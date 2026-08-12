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
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from mapper.cli import LatestFrame, main
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

        sock = FakeSocket()
        with patch("mapper.sender.open_socket", return_value=sock):
            out = run_cli(
                [
                    "stream",
                    "--type", "8x8_4P",
                    "--cols", "10",
                    "--rows", "5",
                    "--emit-digest",
                ],
                stdin=PATTERNS["gradient24"](config),
            )

        # The send loop and the reader thread start together, so whether tick 0
        # sees the first frame or the black the slot opens with is a race, and
        # it is a race by design -- the sender never waits. What is not
        # negotiable is that the newest frame reaches the wire and is the last
        # thing on it, which is what the floor is left holding.
        per_frame = config.packets_per_frame
        self.assertGreaterEqual(len(sock.datagrams), per_frame)
        self.assertEqual(len(sock.datagrams) % per_frame, 0)
        last = b"".join(sock.datagrams[-per_frame:])
        self.assertEqual(hashlib.sha256(last).hexdigest(), expected)

        # `--emit-digest` must report what actually went out, not a second
        # opinion about it.
        self.assertEqual(digests(out)[-1], expected)

        self.assertEqual(sock.destinations, {("255.255.255.255", 60001)})
        self.assertTrue(sock.closed, "the send loop must close its socket")


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


if __name__ == "__main__":
    unittest.main()
