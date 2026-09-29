"""The send loop, with a fake socket in place of the floor.

`sender.py` had no test at all until `--loop` and `--forever` gave it branching
worth checking. Nothing here touches a real socket: `open_socket` is patched, so
the whole file runs anywhere and sends nothing to anything.

The thing actually under test is `frame_numbers` — how "how long should this
send" is decided from three mutually exclusive ways of saying it — plus that the
infinite mode terminates cleanly and closes its socket.

The pacing tests further down run on a `FakeClock` patched in for the sender's
`time`, so "never earlier than the ceiling" and "repeat at exactly the maximum
silence" are asserted as arithmetic rather than as a timing window that a busy
machine could make pass or fail by luck.
"""

from __future__ import annotations

import itertools
import time
import unittest
from types import SimpleNamespace
from unittest import mock

from mapper.floors import FloorConfig
from mapper.patterns import white
from mapper.sender import frame_numbers, on_arrival, precise_clock, run, sleep_until

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


# ------------------------------------------------------------------ pacing


class FakeClock:
    """`perf_counter` and `sleep` for the sender, with time that only moves on request."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []
        #: How late every sleep wakes. 0 by default; macOS wakes a 1 ms slice
        #: up to ~0.5 ms late (p99 0.56 ms, measured 2026-09-28).
        self.overshoot = 0.0

    def perf_counter(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += max(seconds, 0.0) + self.overshoot


class ScriptedSlot:
    """A `LatestFrame` stand-in whose frames arrive at scripted fake-clock times.

    `read` hands out the newest frame that has arrived, as the real slot does.
    `wait_for_new` returns True for an arrival *strictly* before its deadline;
    an arrival landing exactly on the deadline is seen as a timeout, and is then
    picked up by the `read` that follows. That tie is the recovery phase the
    pacer must survive: it timed out, yet the snapshot it sends is new.
    """

    def __init__(self, clock: FakeClock, arrivals: list[tuple[float, bytes]], black: bytes) -> None:
        self.clock = clock
        self.arrivals = arrivals
        self.black = black
        self.handed_out = 0

    def _arrived(self) -> int:
        return sum(1 for t, _ in self.arrivals if t <= self.clock.now)

    def read(self) -> bytes:
        self.handed_out = self._arrived()
        return self.arrivals[self.handed_out - 1][1] if self.handed_out else self.black

    def wait_for_new(self, timeout: float) -> bool:
        if self._arrived() > self.handed_out:
            return True
        if self.handed_out < len(self.arrivals):
            t = self.arrivals[self.handed_out][0]
            if t < self.clock.now + timeout:
                self.clock.now = t
                return True
        self.clock.now += max(timeout, 0.0)
        return False


def numbered(k: int) -> bytes:
    """Frame k of the tiny floor. 0 is black, as the slot starts."""
    return bytes([k]) * (TINY.pixel_count * 3)


class PacedTest(unittest.TestCase):
    """Base: a fake socket and a fake clock under `mapper.sender`."""

    def setUp(self):
        self.sock = FakeSocket()
        self.clock = FakeClock()
        for target, value in (
            ("mapper.sender.open_socket", mock.Mock(return_value=self.sock)),
            ("mapper.sender.time", SimpleNamespace(perf_counter=self.clock.perf_counter,
                                                   sleep=self.clock.sleep)),
        ):
            patcher = mock.patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_paced(self, source, pace, until: float, fps: int = 30) -> list[tuple[float, bytes]]:
        """Run until the fake clock passes `until`; return (send time, frame) per send."""
        start = self.clock.now
        sends: list[tuple[float, bytes]] = []
        current: dict[str, bytes] = {}

        def frame_source(n: int) -> bytes:
            current["frame"] = source()
            return current["frame"]

        def on_frame(n: int, _elapsed: float) -> None:
            sends.append((self.clock.now - start, current["frame"]))
            if self.clock.now - start >= until:
                raise KeyboardInterrupt

        run(TINY, frame_source, duration=None, fps=fps, pace=pace, on_frame=on_frame)
        return sends


class ClockPacingTest(PacedTest):
    def test_the_default_sleeps_once_per_tick(self):
        """`clock` is today's sender, timing for timing: one `sleep` per tick.

        This is what the stream probe measured juddering, and it stays the
        default until a floor capture says otherwise (D-02). A default that
        quietly became sliced would move every earlier cadence measurement.
        """
        run(TINY, lambda n: numbered(1), duration=None, fps=30, total_frames=3)
        self.assertEqual(len(self.clock.sleeps), 3)
        for seconds in self.clock.sleeps:
            self.assertAlmostEqual(seconds, 1 / 30, places=9)

    def test_a_pace_replaces_the_sleep_and_is_told_when_each_frame_went(self):
        calls: list[tuple[int, float, float]] = []
        run(TINY, lambda n: numbered(1), duration=None, fps=30, total_frames=3,
            pace=lambda n, start, sent: calls.append((n, start, sent)))
        self.assertEqual([n for n, _, _ in calls], [0, 1, 2])
        self.assertEqual(self.clock.sleeps, [], "run slept as well as the pace")
        for _, start, sent in calls:
            self.assertEqual(start, 1000.0)
            self.assertGreaterEqual(sent, start)


class SleepUntilTest(unittest.TestCase):
    def test_never_returns_early_on_the_real_clock(self):
        for _ in range(20):
            target = time.perf_counter() + 0.005
            sleep_until(target)
            self.assertGreaterEqual(time.perf_counter(), target)

    def test_sleeps_in_slices_no_longer_than_a_millisecond(self):
        """The mechanism, not just the outcome.

        MEASURED 2026-09-28: one ~33 ms `time.sleep` on macOS wakes 7-15 ms
        late; 1 ms slices land p99 0.56 ms late. A single long sleep would pass
        "never early" above and still be the judder.
        """
        clock = FakeClock()
        with mock.patch("mapper.sender.time", SimpleNamespace(perf_counter=clock.perf_counter,
                                                               sleep=clock.sleep)):
            sleep_until(clock.now + 1 / 30)
        self.assertGreater(len(clock.sleeps), 30)
        self.assertLessEqual(max(clock.sleeps), 0.001)
        self.assertGreaterEqual(clock.now, 1000.0 + 1 / 30)


class PrecisePacingTest(PacedTest):
    def test_holds_the_metronome_grid_in_millisecond_slices(self):
        sends = self.run_paced(lambda: numbered(1), precise_clock(30), until=0.5)
        for n, (t, _) in enumerate(sends):
            self.assertAlmostEqual(t, n / 30, places=9, msg=f"tick {n}")
        self.assertLessEqual(max(self.clock.sleeps), 0.001)

    def test_a_slow_send_does_not_drift_the_grid(self):
        """Ticks are counted from the start, not from each send.

        Pacing from the send would add the send's own cost to every interval:
        at 2 ms a frame, 30 fps becomes ~28, and the grid walks through every
        writer phase in turn.
        """
        sendto = self.sock.sendto

        def slow(datagram, destination):
            self.clock.now += 0.002
            return sendto(datagram, destination)

        self.sock.sendto = slow
        sends = self.run_paced(lambda: numbered(1), precise_clock(30), until=1.0)
        for n, (t, _) in enumerate(sends):
            self.assertAlmostEqual(t, n / 30 + 0.002, places=9, msg=f"tick {n}")


class ArrivalPacingTest(PacedTest):
    def arrival_run(self, arrivals: list[tuple[float, bytes]], until: float, max_silence: float = 1.0):
        base = self.clock.now
        slot = ScriptedSlot(self.clock, [(base + t, f) for t, f in arrivals], numbered(0))
        return self.run_paced(slot.read, on_arrival(30, slot.wait_for_new, max_silence), until=until)

    def test_black_goes_out_at_once_before_anything_arrives(self):
        sends = self.arrival_run([(0.5, numbered(1))], until=0.5)
        self.assertEqual(sends[0], (0.0, numbered(0)))
        # And the first real frame goes the moment it lands, not a max
        # silence after the black.
        self.assertEqual(sends[1], (0.5, numbered(1)))

    def test_never_faster_than_the_ceiling_and_never_queues(self):
        """A 100 Hz writer: the wire gets 30 fps at most, always the newest frame."""
        arrivals = [(0.005 + k * 0.01, numbered(k % 250 + 1)) for k in range(100)]
        sends = self.arrival_run(arrivals, until=1.0)
        gaps = [b[0] - a[0] for a, b in zip(sends, sends[1:])]
        # Exactly `1/fps`, no early tolerance. framePacing.ts allows the
        # renderer 4 ms; the sender allowing the same would exceed 30 fps.
        self.assertGreaterEqual(min(gaps), 1 / 30 - 1e-9)
        # Counted strictly inside the first second: the send near t = 1.0 lands
        # either side of it on accumulated float slices.
        first_second = [t for t, _ in sends if t < 1.0 - 1e-6]
        self.assertLessEqual(len(first_second), 30)
        self.assertGreaterEqual(len(first_second), 29)
        for t, frame in sends[1:]:
            newest = max((a for a in arrivals if a[0] <= t + 1e-12), key=lambda a: a[0])
            self.assertEqual(frame, newest[1], f"send at {t:.4f} was not the newest frame")

    def test_a_steady_writer_sets_the_cadence_whatever_its_phase(self):
        """30 Hz arriving at any phase goes out once each, as it arrives.

        This is the phase relation (b) exists to remove: a +0/+2 pair would
        show up here as a repeated or skipped index.
        """
        for phase in (0.0001, 0.0165, 0.0332):
            with self.subTest(phase=phase):
                self.clock.now = 1000.0
                self.sock.sent.clear()
                arrivals = [(phase + k / 30, numbered(k)) for k in range(1, 30)]
                sends = self.arrival_run(arrivals, until=phase + 28 / 30)
                indices = [frame[0] for _, frame in sends]
                self.assertEqual(indices, list(range(29)))
                for (t, frame), (arrived, _) in zip(sends[1:], arrivals):
                    self.assertAlmostEqual(t, arrived, places=9)

    # Times below are dyadic (0.125, not 0.1) so "exactly on the deadline" is
    # exactly on it in binary floating point, not one ulp either side.

    def test_a_same_rate_writer_does_not_ratchet_into_skips(self):
        """A send that costs time must not push every later send later.

        MEASURED 2026-09-29, first loopback smoke of this mode: with the ceiling
        at `last_send + 1/fps`, a 30 Hz writer against a 30 fps ceiling has no
        slack, so each send's own cost (build, send, wake overshoot -- ~2 ms)
        carried into the next ceiling. Lateness climbed 2 -> 35 ms over ~15
        frames, then a frame was skipped (+2) and it began again: a 2 Hz judder,
        worse than the metronome this mode exists to beat. The ceiling now
        counts from when the previous send was *allowed*, not when it happened.
        """
        sendto = self.sock.sendto

        def slow(datagram, destination):
            self.clock.now += 0.002
            return sendto(datagram, destination)

        self.sock.sendto = slow
        # And every sleep wakes late, as on macOS: a pace that anchored the
        # ceiling to when it woke would carry this into every later send too.
        self.clock.overshoot = 0.0005
        # Ten seconds: a ratchet of a fraction of a millisecond a frame takes
        # this long to cost a whole tick, and at 5 s it had not yet.
        arrivals = [(k / 30, numbered(k % 250 + 1)) for k in range(1, 301)]
        sends = self.arrival_run(arrivals, until=299 / 30)
        indices = [frame[0] for _, frame in sends]
        expected = [0] + [k % 250 + 1 for k in range(1, len(indices))]
        self.assertEqual(indices, expected, "a frame was skipped or repeated")
        self.assertGreaterEqual(len(indices), 299)

    def test_sustained_rate_never_exceeds_fps_even_with_slow_sends(self):
        """Anchoring to the schedule may shorten one gap after a late send; it
        must never let the long-run rate past `fps`."""
        sendto = self.sock.sendto

        def slow(datagram, destination):
            self.clock.now += 0.003
            return sendto(datagram, destination)

        self.sock.sendto = slow
        arrivals = [(0.001 + k * 0.004, numbered(k % 250 + 1)) for k in range(1000)]
        sends = self.arrival_run(arrivals, until=3.0)
        times = [t for t, _ in sends]
        for window in (2, 10, 60):
            for i in range(len(times) - window):
                span = times[i + window] - times[i]
                self.assertGreaterEqual(span, window / 30 - 1e-9, f"{window} sends in {span:.4f} s")

    def test_a_stalled_send_does_not_burst_to_catch_up(self):
        """After a multi-tick stall the schedule is in the past; it must not be chased.

        Found by the stop-time review of the schedule-anchored ceiling: with
        only `allowed + 1/fps`, a 200 ms stall leaves six ceilings already open,
        and a 60 Hz writer then gets a frame out every 16.7 ms until the
        schedule catches up with the clock -- 60 fps on the wire from a 30 fps
        ceiling. No two sends may be closer than half a tick, and no run of
        sends may beat the ceiling by more than that half tick.
        """
        sendto = self.sock.sendto
        stalls = {12}

        def stalling(datagram, destination):
            if len(self.sock.sent) in stalls:
                self.clock.now += 0.2
            return sendto(datagram, destination)

        self.sock.sendto = stalling
        arrivals = [(k / 60, numbered(k % 250 + 1)) for k in range(1, 180)]
        sends = self.arrival_run(arrivals, until=2.9)
        times = [t for t, _ in sends]
        interval = 1 / 30
        self.assertTrue(any(b - a > 0.2 for a, b in zip(times, times[1:])), "the stall never happened")
        for i in range(len(times)):
            for j in range(i + 1, len(times)):
                self.assertGreaterEqual(
                    times[j] - times[i], (j - i) * interval - interval / 2 - 1e-9,
                    f"sends {i}..{j} span {times[j] - times[i]:.4f} s",
                )

    def test_silence_repeats_the_newest_frame_every_max_silence(self):
        sends = self.arrival_run([(0.125, numbered(1))], until=3.125)
        self.assertEqual([t for t, _ in sends], [0.0, 0.125, 1.125, 2.125, 3.125])
        self.assertEqual({f for _, f in sends[1:]}, {numbered(1)})

    def test_an_arrival_on_the_repeat_deadline_is_sent_once_and_not_again_early(self):
        """The recovery phase: the wait timed out, and the frame landed anyway.

        The deadline must send the newest snapshot -- frame 2, not a stale
        repeat of frame 1 -- and then count it as sent, so the next send is a
        max silence later rather than one tick later as a spurious "new" frame.
        """
        sends = self.arrival_run([(0.125, numbered(1)), (1.125, numbered(2))], until=2.125)
        self.assertEqual([(t, f[0]) for t, f in sends],
                         [(0.0, 0), (0.125, 1), (1.125, 2), (2.125, 2)])


if __name__ == "__main__":
    unittest.main()
