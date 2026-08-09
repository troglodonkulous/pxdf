"""The send loop, with a fake socket in place of the floor.

`sender.py` had no test at all until `--loop` and `--forever` gave it branching
worth checking. Nothing here touches a real socket: `open_socket` is patched, so
the whole file runs anywhere and sends nothing to anything.

The thing actually under test is `frame_numbers` — how "how long should this
send" is decided from three mutually exclusive ways of saying it — plus that the
infinite mode terminates cleanly and closes its socket.
"""

from __future__ import annotations

import itertools
import unittest
from unittest import mock

from mapper.floors import FloorConfig
from mapper.patterns import white
from mapper.sender import frame_numbers, run

#: One tile, one controller, one packet per frame. Keeps a sent-packet count
#: equal to a sent-frame count, so the assertions below say what they mean.
TINY = FloorConfig.of("8x8_4P", 1, 1)

#: Fast enough that the loop's pacing sleeps round to nothing.
FAST = 1000


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[tuple[bytes, tuple[str, int]]] = []
        self.closed = False

    def sendto(self, datagram: bytes, destination: tuple[str, int]) -> None:
        self.sent.append((datagram, destination))

    def close(self) -> None:
        self.closed = True


class FrameNumbersTest(unittest.TestCase):
    def test_total_frames_wins_over_duration(self):
        """A loop count is exact; seconds are not.

        3 loops of a 7-frame clip at 3 fps is 21 frames. Expressed as a
        duration it is 6.999999999999999 s, and whether that rounds back to 21
        is a property of binary floating point rather than of the request.
        """
        self.assertEqual(list(frame_numbers(7.0, 3, 21)), list(range(21)))

    def test_duration_derives_a_count(self):
        self.assertEqual(list(frame_numbers(2.0, 10, None)), list(range(20)))

    def test_a_duration_shorter_than_one_frame_still_sends_one(self):
        self.assertEqual(list(frame_numbers(0.01, 10, None)), [0])

    def test_no_duration_and_no_count_is_forever(self):
        numbers = frame_numbers(None, 10, None)
        self.assertEqual(list(itertools.islice(numbers, 5)), [0, 1, 2, 3, 4])

    def test_a_count_below_one_is_rejected(self):
        with self.assertRaises(ValueError):
            frame_numbers(None, 10, 0)


class RunTest(unittest.TestCase):
    def setUp(self):
        self.sock = FakeSocket()
        patcher = mock.patch("mapper.sender.open_socket", return_value=self.sock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.frame = white(TINY)

    def test_a_loop_count_sends_exactly_that_many_frames(self):
        asked: list[int] = []

        def source(n: int) -> bytes:
            asked.append(n)
            return self.frame

        sent = run(TINY, source, duration=None, fps=FAST, total_frames=3)

        self.assertEqual(asked, [0, 1, 2])
        self.assertEqual(sent, 3 * TINY.packets_per_frame)
        self.assertEqual(len(self.sock.sent), sent)
        self.assertTrue(self.sock.closed)

    def test_forever_runs_until_interrupted_and_still_reports(self):
        """Ctrl-C is the infinite mode's only exit, so it must be an exit.

        `on_frame` fires after the frame is counted, so raising there is the
        same shape as a Ctrl-C landing between two frames.
        """

        def stop_after_four(n: int, _elapsed: float) -> None:
            if n == 3:
                raise KeyboardInterrupt

        sent = run(
            TINY,
            lambda n: self.frame,
            duration=None,
            fps=FAST,
            on_frame=stop_after_four,
        )

        self.assertEqual(sent, 4 * TINY.packets_per_frame)
        self.assertTrue(self.sock.closed)

    def test_the_socket_closes_when_the_frame_source_raises(self):
        def broken(n: int) -> bytes:
            raise RuntimeError("no frame")

        with self.assertRaises(RuntimeError):
            run(TINY, broken, duration=None, fps=FAST, total_frames=2)
        self.assertTrue(self.sock.closed)


if __name__ == "__main__":
    unittest.main()
