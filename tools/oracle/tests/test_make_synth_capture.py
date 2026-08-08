"""Pins the four `90-synth-acceptance` rows of `docs/ORACLE_HARNESS.md` S8.5.

The synthetic capture is the harness's instrument test at the acceptance
geometry -- three controllers with a partial last one, where no real capture
exists. S8.5 states what the pass criterion does there under three injected
mapping faults. This test regenerates the capture and re-derives all four
verdicts from `verify_config`, so the documented table cannot drift away from
the code that produced it.

It also round-trips the generator's pcapng writer through `mapper.pcapng`'s
reader, which is the only check that the file it emits is the shape the harness
actually parses.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from mapper.pcapng import read_udp, split_frames
from mapper.plan import build_plan
from tools.oracle.decode_diff import DEST_PORT, verify_config
from tools.oracle.make_synth_capture import (
    ACCEPTANCE,
    BLANK_FRAMES,
    FRAME_COUNT,
    TORN_FRAMES,
    TRAILING_PARTIAL_PACKETS,
    build_capture_frames,
    write_pcapng,
)


def _result(fault: str, directory: Path):
    path = directory / f"synth-{fault}.pcapng"
    write_pcapng(build_capture_frames(fault), path)
    return verify_config(ACCEPTANCE, path)


class SynthCaptureShape(unittest.TestCase):
    def test_reader_sees_what_the_writer_wrote(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "synth.pcapng"
            groups = build_capture_frames("none")
            written = write_pcapng(groups, path)

            datagrams = read_udp(path, DEST_PORT)
            self.assertEqual(len(datagrams), written)

            read_back = split_frames(datagrams)
            self.assertEqual(len(read_back), FRAME_COUNT + 1)
            self.assertEqual(
                [len(g) for g in read_back],
                [len(g) for g in groups],
                "every group must survive the pcapng round trip at its own length",
            )

    def test_the_planted_defects_are_where_they_are_claimed(self):
        groups = build_capture_frames("none")
        plan = build_plan(ACCEPTANCE.floor_config, eof=ACCEPTANCE.eof)

        for index in BLANK_FRAMES:
            self.assertTrue(
                all(all(b == 0 for b in d[5:]) for d in groups[index]),
                f"frame {index} should be an all-black loop-boundary frame",
            )

        # Disjointness is load-bearing: two tears sharing an ordinal would
        # manufacture the recurrence signal the check exists to detect.
        torn_ordinals = [set(o) for o in TORN_FRAMES.values()]
        self.assertEqual(
            len(set().union(*torn_ordinals)),
            sum(len(o) for o in torn_ordinals),
            "torn frames must not share a packet ordinal",
        )

        self.assertEqual(len(groups[-1]), TRAILING_PARTIAL_PACKETS)
        self.assertLess(len(groups[-1]), len(plan))


class DocumentedVerdicts(unittest.TestCase):
    """S8.5's `90-synth-acceptance` rows, re-derived."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        directory = Path(cls._tmp.name)
        cls.results = {f: _result(f, directory) for f in ("none", "f1", "f1b", "f2")}

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_clean_capture_passes_with_the_documented_counts(self):
        r = self.results["none"]
        self.assertTrue(r.passed, r.failures)
        self.assertEqual(r.frames_total, FRAME_COUNT)
        self.assertEqual(r.frames_matched, 69)
        self.assertEqual(r.frames_tolerated, 5)
        self.assertEqual(r.frames_unexplained, 0)
        self.assertEqual(len(r.partial_frames), 1)
        self.assertEqual(r.systematic, [])
        # ~1 %: one tear, once, on a packet nothing else touches.
        self.assertEqual(r.worst_recurrence.frames, 1)

    def _assert_located(self, fault: str, ports: set[tuple[int, int]]):
        r = self.results[fault]
        self.assertFalse(r.passed)
        self.assertEqual(r.frames_matched, 0)
        self.assertEqual(r.frames_tolerated, 0, "a systematic fault must not be tolerated")
        self.assertEqual({(x.controller, x.port) for x in r.systematic}, ports)
        # 71 of 74: the three blank frames carry no evidence and are excluded
        # from the numerator, not from the denominator.
        self.assertEqual(r.worst_recurrence.frames, FRAME_COUNT - len(BLANK_FRAMES))

    def test_f1_locates_the_cross_controller_swap(self):
        self._assert_located("f1", {(0, 3), (1, 0)})

    def test_f1b_locates_columns_0_and_5(self):
        self._assert_located("f1b", {(0, 0), (1, 1)})

    def test_f2_locates_the_column_no_real_capture_can_see(self):
        self._assert_located("f2", {(1, 3)})


if __name__ == "__main__":
    unittest.main()
