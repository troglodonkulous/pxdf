"""`mapper stream`: raw framebuffers on stdin, the graded wire path underneath.

Every digest here is *derived*, never pasted in. The bar in `CLAUDE.md` quotes
two hex strings, and copying them into this file would produce a test that only
knows what the bar already said. Deriving the expectation from `mapper send`
instead makes this an equivalence test between the two commands: a deliberate
contract change moves both digests together and the test still passes, while an
accidental one — a stray transform on the stream path, a framebuffer read in the
wrong order — moves only one and is caught. That distinction is the whole point;
this project has shipped six self-consistent-but-wrong results, and a frozen
constant is exactly the instrument that cannot tell you about the seventh.

No test in this file may open a socket or put a byte on the wire. The `--dry-run`
path and the frame slot need nothing to satisfy that; the live path is graded
against a fake socket that collects datagrams instead of sending them, which is
the only way to put the code the app actually runs under the same digest as
everything else.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from mapper import sender
from mapper.cli import LatestFrame, build_parser, main
from mapper.floors import FloorConfig
from mapper.patterns import PATTERNS


def run_cli(argv: list[str], stdin: bytes = b"") -> str:
    """Drive the CLI in process with `stdin` on its input, returning stdout."""
    out = io.StringIO()
    with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(stdin))):
        with contextlib.redirect_stdout(out):
            code = main(argv)
    assert code == 0, f"{argv} exited {code}"
    return out.getvalue()


def digests(output: str) -> list[str]:
    """The sha256 of every frame named in a command's output, in order."""
    return [
        line.split("sha256:")[1].strip()
        for line in output.splitlines()
        if "sha256:" in line
    ]


class StreamMatchesSendTest(unittest.TestCase):
    """One gradient24 frame through `stream` is one through `send`, byte for byte."""

    def assert_matches_send(self, cols: int, rows: int) -> None:
        expected = digests(
            run_cli(
                [
                    "send",
                    "--type", "8x8_4P",
                    "--cols", str(cols),
                    "--rows", str(rows),
                    "--pattern", "gradient24",
                    "--dry-run",
                ]
            )
        )
        self.assertEqual(len(expected), 1)

        config = FloorConfig.of("8x8_4P", cols, rows)
        got = digests(
            run_cli(
                [
                    "stream",
                    "--type", "8x8_4P",
                    "--cols", str(cols),
                    "--rows", str(rows),
                    "--dry-run",
                ],
                stdin=PATTERNS["gradient24"](config),
            )
        )
        self.assertEqual(got, expected)

    def test_shop_rig_10x5(self):
        self.assert_matches_send(10, 5)

    def test_job_rig_10x12(self):
        # Twelve tiles deep is 50 packets and 23,290 bytes per frame, and has
        # never been seen on hardware. The digest agreeing with `send` here is
        # the only grade this geometry has off the floor.
        self.assert_matches_send(10, 12)


class FakeSocket:
    """Collects what `send_frame` would have put on the wire.

    Not a socket, deliberately: the point is to grade the live path without a
    file descriptor existing anywhere, so this test is as safe to run beside a
    real send as any other test in the suite.
    """

    def __init__(self) -> None:
        self.datagrams: list[bytes] = []
        self.destinations: set[tuple[str, int]] = set()
        self.closed = False

    def sendto(self, datagram, destination) -> int:
        self.datagrams.append(bytes(datagram))
        self.destinations.add(destination)
        return len(datagram)

    def close(self) -> None:
        self.closed = True


#: Every `--pacing` mode. Each live-path test below runs under all of them: a
#: mode that changes *when* frames go must not change *which* bytes go.
PACINGS = ("clock", "arrival")

SHOP = ["--type", "8x8_4P", "--cols", "10", "--rows", "5"]


def live_stream(argv: list[str], stdin: bytes) -> tuple[FakeSocket, str]:
    """Run the live `stream` path against a fake socket."""
    sock = FakeSocket()
    with patch("mapper.sender.open_socket", return_value=sock):
        out = run_cli(["stream", *SHOP, *argv], stdin=stdin)
    return sock, out


class LiveStreamMatchesSendTest(unittest.TestCase):
    """The path the app actually runs, held to the same digest as `send`.

    Everything above this grades `--dry-run`, which shares `build_frame` with the
    live path but not the reader thread, the slot or the metronome. Grading only
    the convenient path is how `oracle.harness --live` came to grade a stored
    capture while a live send was on the wire, so the inconvenient one is graded
    here too.
    """

    def test_the_last_frame_sent_matches_the_send_digest(self):
        config = FloorConfig.of("8x8_4P", 10, 5)
        expected = digests(
            run_cli(
                [
                    "send",
                    "--type", "8x8_4P",
                    "--cols", "10",
                    "--rows", "5",
                    "--pattern", "gradient24",
                    "--dry-run",
                ]
            )
        )[0]

        for pacing in PACINGS:
            with self.subTest(pacing=pacing):
                sock, out = live_stream(
                    ["--emit-digest", "--pacing", pacing], PATTERNS["gradient24"](config)
                )

                # The send loop and the reader thread start together, so whether
                # tick 0 sees the first frame or the black the slot opens with is
                # a race, and it is a race by design -- the sender never waits.
                # What is not negotiable is that the newest frame reaches the
                # wire and is the last thing on it, which is what the floor is
                # left holding. Under `arrival` that is also the EOF contract: a
                # frame is handed out only by being sent.
                per_frame = config.packets_per_frame
                self.assertGreaterEqual(len(sock.datagrams), per_frame)
                self.assertEqual(len(sock.datagrams) % per_frame, 0)
                last = b"".join(sock.datagrams[-per_frame:])
                self.assertEqual(hashlib.sha256(last).hexdigest(), expected)

                # `--emit-digest` must report what actually went out, not a
                # second opinion about it.
                self.assertEqual(digests(out)[-1], expected)

                self.assertEqual(sock.destinations, {("255.255.255.255", 60001)})
                self.assertTrue(sock.closed, "the send loop must close its socket")

    def test_empty_input_still_sends_black(self):
        """No frames at all is a dark floor, never a silent one, in every mode."""
        config = FloorConfig.of("8x8_4P", 10, 5)
        black = b"".join(sender.dry_run(config, lambda n: bytes(config.pixel_count * 3)))
        per_frame = config.packets_per_frame
        for pacing in PACINGS:
            with self.subTest(pacing=pacing):
                sock, _ = live_stream(["--pacing", pacing], b"")
                # The count as well as the property: zero packets would pass
                # "every packet is black".
                self.assertGreaterEqual(len(sock.datagrams), per_frame)
                self.assertEqual(len(sock.datagrams) % per_frame, 0)
                for i in range(0, len(sock.datagrams), per_frame):
                    self.assertEqual(b"".join(sock.datagrams[i:i + per_frame]), black)


class PacingOptionTest(unittest.TestCase):
    """`--pacing` is `stream`'s alone, and its default is today's sender (D-02)."""

    def test_default_is_clock(self):
        args = build_parser().parse_args(["stream", *SHOP])
        self.assertEqual(args.pacing, "clock")
        self.assertFalse(args.emit_timing)

    def test_play_and_send_do_not_take_it(self):
        # Their bytes are frozen (D-01), and so is their timing: nobody gets to
        # pace a hardware-graded path by accident.
        for argv in (
            ["send", *SHOP, "--pattern", "gradient24", "--pacing", "arrival"],
            ["play", "clip.avi", *SHOP, "--pacing", "arrival"],
        ):
            with self.subTest(command=argv[0]):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        build_parser().parse_args(argv)

    def test_clock_hands_run_no_pace(self):
        """`clock` is `run` exactly as before: its own one-sleep-per-tick loop."""
        seen: dict[str, object] = {}
        real_run = sender.run

        def spy(*args, **kwargs):
            seen["pace"] = kwargs.get("pace")
            return real_run(*args, **kwargs)

        for pacing, expect_pace in (("clock", False), ("arrival", True)):
            with self.subTest(pacing=pacing):
                with patch("mapper.cli.run", side_effect=spy):
                    live_stream(["--pacing", pacing], b"")
                self.assertEqual(seen["pace"] is not None, expect_pace)

    def test_the_sending_line_names_the_pacing(self):
        """The one line the app logs about what the sender is doing says which mode ran."""
        for pacing in PACINGS:
            with self.subTest(pacing=pacing):
                _, out = live_stream(["--pacing", pacing], b"")
                sending = [line for line in out.splitlines() if line.startswith("sending to ")]
                self.assertEqual(len(sending), 1, out)
                self.assertIn(f"pacing {pacing}", sending[0])


class EmitTimingTest(unittest.TestCase):
    """`--emit-timing`: when each frame was written into the slot and when it was sent.

    This is the instrument for the question the stream probe could only infer
    (step 5): is a +0/+2 pair the sender waking late, or the reader thread
    getting the frame into the slot late? Timestamps are `perf_counter`, which
    on macOS is `mach_absolute_time` and so comparable with a writer in another
    process.
    """

    def setUp(self):
        self.config = FloorConfig.of("8x8_4P", 10, 5)
        self.frames = [bytes([k]) * (self.config.pixel_count * 3) for k in (1, 2, 3)]

    def timing_lines(self, out: str) -> list[list[str]]:
        return [line.split() for line in out.splitlines() if line.startswith("timing ")]

    def test_off_by_default(self):
        _, out = live_stream(["--pacing", "clock"], b"".join(self.frames))
        self.assertEqual(self.timing_lines(out), [])

    def test_one_line_per_frame_sent(self):
        for pacing in PACINGS:
            with self.subTest(pacing=pacing):
                sock, out = live_stream(["--pacing", pacing, "--emit-timing"], b"".join(self.frames))
                lines = self.timing_lines(out)
                sent = len(sock.datagrams) // self.config.packets_per_frame
                self.assertEqual(len(lines), sent)

                # timing <n> read <t> sent <t> seq <k> wrote <t|->
                for i, fields in enumerate(lines):
                    self.assertEqual(fields[0::2], ["timing", "read", "sent", "seq", "wrote"], fields)
                    self.assertEqual(int(fields[1]), i)
                    read_at, sent_at = float(fields[3]), float(fields[5])
                    self.assertLessEqual(read_at, sent_at)
                    seq = int(fields[7])
                    if seq == 0:
                        self.assertEqual(fields[9], "-", "the opening black was never written")
                    else:
                        self.assertLessEqual(float(fields[9]), read_at)

                seqs = [int(f[7]) for f in lines]
                self.assertEqual(seqs, sorted(seqs))
                self.assertEqual(seqs[-1], len(self.frames), "the last frame written must be sent")


class StreamFramingTest(unittest.TestCase):
    """The byte contract: back-to-back frames, no header, no delimiter."""

    def setUp(self):
        self.config = FloorConfig.of("8x8_4P", 10, 5)
        self.frame_bytes = self.config.pixel_count * 3
        self.argv = [
            "stream", "--type", "8x8_4P", "--cols", "10", "--rows", "5", "--dry-run",
        ]

    def test_two_concatenated_frames_are_two_frames(self):
        black = bytes(self.frame_bytes)
        gradient = PATTERNS["gradient24"](self.config)
        got = digests(run_cli(self.argv, stdin=black + gradient))
        self.assertEqual(len(got), 2)
        # In order, and distinguishable: two lines of the same digest would
        # pass a length check while proving nothing about ordering.
        self.assertNotEqual(got[0], got[1])
        self.assertEqual(got[1], digests(run_cli(self.argv, stdin=gradient))[0])

    def test_trailing_partial_frame_is_discarded(self):
        gradient = PATTERNS["gradient24"](self.config)
        got = digests(run_cli(self.argv, stdin=gradient * 3 + b"\x01\x02\x03\x04\x05"))
        self.assertEqual(len(got), 3)


class LatestFrameTest(unittest.TestCase):
    """The slot, with no socket and no thread anywhere near it."""

    def test_starts_black_and_keeps_the_newest_frame(self):
        config = FloorConfig.of("8x8_4P", 10, 5)
        size = config.pixel_count * 3
        slot = LatestFrame(size)

        # Black before the renderer has said anything. Sending nothing instead
        # would let controller 1 revert to vendor local content after ~5 s.
        self.assertEqual(slot.read(), bytes(size))

        frames = [bytes([n]) * size for n in (1, 2, 3, 4)]
        slot.pump(io.BytesIO(b"".join(frames)))

        # The reader overwrites; the sender is only ever offered the newest.
        # A sender running slower than the renderer therefore skips stale
        # frames rather than falling behind, which is the intended trade.
        self.assertEqual(slot.read(), frames[-1])
        self.assertNotEqual(slot.read(), frames[0])

    def test_drained_only_after_the_last_frame_is_handed_out(self):
        size = 12
        slot = LatestFrame(size)
        slot.pump(io.BytesIO(b"\x07" * size))
        # End of input alone is not the stop condition -- the final frame is
        # still sitting unsent, and on this floor the last frame sent is the
        # one left on the tiles.
        self.assertFalse(slot.drained())
        self.assertEqual(slot.read(), b"\x07" * size)
        self.assertTrue(slot.drained())

    def test_wait_for_new_sees_each_frame_once(self):
        """The recovery phase, on the real slot.

        A write that lands after the wait has timed out is still sent by the
        `read` that follows -- and, having been sent, is not "new" to the next
        wait. Otherwise an arrival on the repeat deadline would go out twice,
        one tick apart.
        """
        slot = LatestFrame(3)
        slot.write(b"AAA")
        self.assertTrue(slot.wait_for_new(0))
        self.assertEqual(slot.read(), b"AAA")
        self.assertFalse(slot.wait_for_new(0))
        slot.write(b"BBB")  # after the timeout, before the read
        self.assertEqual(slot.read(), b"BBB")
        self.assertFalse(slot.wait_for_new(0), "a frame already sent came back as new")
        slot.write(b"CCC")
        self.assertTrue(slot.wait_for_new(0))

    def test_a_write_wakes_a_waiting_sender(self):
        slot = LatestFrame(3)
        slot.read()
        writer = threading.Timer(0.05, slot.write, args=(b"ZZZ",))
        writer.start()
        began = time.perf_counter()
        self.assertTrue(slot.wait_for_new(5.0))
        # Woken by the write, not by the 5 s timeout.
        self.assertLess(time.perf_counter() - began, 1.0)
        writer.join()

    def test_end_of_input_wakes_a_waiting_sender(self):
        """EOF must not leave the sender parked for a whole max silence."""
        slot = LatestFrame(3)
        slot.read()
        closer = threading.Timer(0.05, slot.close)
        closer.start()
        began = time.perf_counter()
        slot.wait_for_new(5.0)
        self.assertLess(time.perf_counter() - began, 1.0)
        closer.join()


if __name__ == "__main__":
    unittest.main()
