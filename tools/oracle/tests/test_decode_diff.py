"""Unit tests for the harness's own logic layered on top of `mapper/`.

Does not re-test `mapper.pcapng` or `mapper.verify` -- those have their own
suite under `mapper/tests/`. This covers what `tools/oracle/decode_diff.py`
adds: the defect classifier, the cross-frame checks that keep a defect label
from absorbing a real fault, and the packet-ordinal -> protocol-terms mapping.

`InjectedMappingFaults` is the load-bearing class. Round 1's classifier passed
a misassigned port as a "torn frame" on every frame of a real capture, so a
synthetic frame that merely *looks* torn is not enough evidence here: these
tests reproduce the exact fault -- a port reading the wrong tile column -- and
require the harness to fail, and to name the port.

The fault is modelled on the observed side (`_as_if_ports_read`) rather than by
patching `mapper.plan`, because `mapper/` belongs to another pair and must not
be edited. The two are equivalent: `datagrams_from_buffer` slices each packet
at `tile_col * port_data_size`, so swapping which tile column a port reads
produces byte-for-byte the same diff as swapping which bytes arrive on it.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mapper.floors import FloorConfig
from mapper.frame import build_frame
from mapper.patterns import PATTERNS, black, white
from mapper.plan import build_plan
from mapper.verify import compare_frame

from tools.oracle.config_list import OracleConfig
from tools.oracle.decode_diff import (
    MAX_BLANK_RUN,
    MAX_RECURRENCE,
    _classify,
    analyse_frames,
    framebuffer_for,
    verify_config,
)

CAPTURES = ROOT / "captures"


def _as_if_ports_read(plan, frame: list[bytes], mapping: dict[int, int]) -> list[bytes]:
    """`frame` as it would look if the port carrying tile column `k` had read
    `mapping[k]` instead. Headers untouched -- that is the whole point of this
    fault class, and why a header check cannot catch it."""
    bodies: dict[int, list[bytes]] = {}
    for spec, packet in zip(plan, frame):
        bodies.setdefault(spec.tile_col, []).append(packet[5:])
    return [
        packet[:5] + bodies[mapping.get(spec.tile_col, spec.tile_col)][spec.packet_index]
        for spec, packet in zip(plan, frame)
    ]


def _run(oc: OracleConfig, observed: list[list[bytes]], partial=()):
    """Drive the whole verdict from synthetic frames, no pcapng needed."""
    config = oc.floor_config
    plan = build_plan(config, eof=oc.eof)
    expected = build_frame(config, framebuffer_for(oc, config), oc.orientation_obj, eof=oc.eof)
    return analyse_frames(oc, plan, expected, observed, list(partial), "<synthetic>")


class Classify(unittest.TestCase):
    """Synthetic frames -- exercises the classifier without a capture file."""

    def setUp(self):
        self.config = FloorConfig.of("8x8_4P", 4, 5)  # one controller, 4 ports
        self.plan = build_plan(self.config)
        self.expected = build_frame(self.config, white(self.config))

    def test_exact_match_is_matched(self):
        diff = compare_frame(self.expected, self.expected, 0)
        self.assertEqual(_classify(self.expected, diff), "matched")

    def test_all_black_body_is_loop_boundary_blank(self):
        blank = build_frame(self.config, black(self.config))
        diff = compare_frame(self.expected, blank, 0)
        self.assertEqual(_classify(blank, diff), "loop-boundary-blank")

    def test_one_packet_torn_mid_body_is_torn_frame(self):
        observed = list(self.expected)
        header = observed[0][:5]
        torn_body = bytes([0] * 10) + observed[0][15:]  # first 10 body bytes zeroed, rest intact
        observed[0] = header + torn_body
        diff = compare_frame(self.expected, observed, 0)
        self.assertEqual(_classify(observed, diff), "torn-frame")

    def test_header_mismatch_is_never_a_known_defect(self):
        """A real mapping bug is free to break headers; neither Ledset defect is."""
        observed = list(self.expected)
        bad_header = bytes([observed[0][0], 9, observed[0][2], observed[0][3], observed[0][4]])
        observed[0] = bad_header + observed[0][5:]
        diff = compare_frame(self.expected, observed, 0)
        self.assertEqual(_classify(observed, diff), "unexplained")

    def test_all_black_body_but_pattern_is_itself_black_still_matches(self):
        """A black-pattern config's own expected frame is all zero -- must not
        be misclassified as a loop-boundary blank against itself."""
        black_expected = build_frame(self.config, black(self.config))
        diff = compare_frame(black_expected, black_expected, 0)
        self.assertEqual(_classify(black_expected, diff), "matched")

    def test_blank_frame_is_blank_even_when_the_source_is_half_black(self):
        """Regression: the old test was `len(bad) == len(observed)`.

        On a source that is already partly black (`06-halves`), a fully-black
        loop-boundary frame differs in only the packets that were carrying
        light -- 8 of 16 -- so the count-based test called every real blank on
        that capture a "torn frame". The blank test must look at the observed
        bytes, not at how many packets happened to differ.
        """
        config = FloorConfig.of("8x8_8P", 8, 5)
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="halves")
        expected = build_frame(config, framebuffer_for(oc, config))
        blank = build_frame(config, black(config))
        diff = compare_frame(expected, blank, 0)
        self.assertLess(len(diff.body_mismatches), len(blank), "precondition: a partial diff")
        self.assertEqual(_classify(blank, diff), "loop-boundary-blank")


class InjectedMappingFaults(unittest.TestCase):
    """A misassigned port must fail, and must be named. The round-1 defect.

    Every case here is a *real* fault of the class `docs/ORACLE_HARNESS.md` S6
    item 1 says the acceptance capture exists to catch: headers correct, packet
    count correct, one or more ports carrying another port's tile column. Round
    1 classified all of them as `torn-frame` and, under the documented pass
    criterion, passed them.
    """

    ACCEPTANCE = dict(type="8x8_4P", cols=10, rows=5, pattern="gradient24")

    def _acceptance(self, **kw):
        return OracleConfig(name="t", **self.ACCEPTANCE, **kw)

    def _frames(self, oc, mapping, count):
        config = oc.floor_config
        plan = build_plan(config)
        clean = build_frame(config, framebuffer_for(oc, config))
        return [_as_if_ports_read(plan, clean, mapping) for _ in range(count)]

    def test_swapped_tile_columns_fail_and_are_located(self):
        """F1: tile columns 3 <-> 4. At 8x8_4P that is a cross-controller swap."""
        oc = self._acceptance(max_tolerated=9)
        result = _run(oc, self._frames(oc, {3: 4, 4: 3}, 60))

        self.assertFalse(result.passed)
        self.assertEqual(result.frames_tolerated, 0, "a systematic fault must not be tolerated")
        self.assertEqual(result.frames_unexplained, 60)
        self.assertTrue(result.systematic)
        self.assertEqual(result.worst_recurrence.frames, 60)
        self.assertEqual(result.worst_recurrence.fraction, 1.0)
        self.assertTrue(any("systematic-mismatch" in f for f in result.failures))

        # Located at the two ports that actually carry tile columns 3 and 4:
        # 4 ports/controller, so col 3 -> ctrl0/port3 and col 4 -> ctrl1/port0.
        implicated = {(r.controller, r.port) for r in result.systematic}
        self.assertEqual(implicated, {(0, 3), (1, 0)})
        self.assertIn(
            result.first_divergence.classification,
            ("systematic-mismatch",),
            "the row an operator reads must not say 'torn-frame'",
        )

    def test_a_port_reading_its_neighbours_column_fails_and_is_located(self):
        """F2: tile column 7 reads 6. Invisible in every existing capture --
        6 and 7 carry identical content in all of them -- so this is exactly
        what the per-pixel-unique acceptance capture is for."""
        oc = self._acceptance(max_tolerated=9)
        result = _run(oc, self._frames(oc, {7: 6}, 60))

        self.assertFalse(result.passed)
        self.assertEqual(result.frames_tolerated, 0)
        self.assertEqual(result.worst_recurrence.fraction, 1.0)
        implicated = {(r.controller, r.port) for r in result.systematic}
        self.assertEqual(implicated, {(1, 3)}, "tile column 7 is controller 1, port 3")

    def test_a_single_byte_wrong_on_every_frame_fails(self):
        """The smallest possible systematic fault: one byte, one packet, always.

        Round 1 called this `torn-frame` (1 of 16 packets bad, a strict subset)
        and tolerated it. Recurrence, not extent, is what separates it from a
        vendor tear.
        """
        oc = self._acceptance(max_tolerated=9)
        config = oc.floor_config
        clean = build_frame(config, framebuffer_for(oc, config))
        broken = list(clean)
        broken[5] = broken[5][:9] + bytes([broken[5][9] ^ 0xFF]) + broken[5][10:]
        result = _run(oc, [list(broken) for _ in range(60)])

        self.assertFalse(result.passed)
        self.assertEqual(result.frames_unexplained, 60)
        self.assertEqual(len(result.systematic), 1)
        self.assertEqual(result.systematic[0].packet_ordinal, 5)

    def test_a_fault_that_spares_one_frame_still_fails(self):
        """The `matched > 0` guard is coincidence, not protection.

        Round 1's only defence against a laundered fault was that a systematic
        fault corrupts every frame, which held only because the acceptance media
        is 60 identical frames. One invariant frame flipped it to PASS. It must
        not.
        """
        oc = self._acceptance(max_tolerated=9)
        config = oc.floor_config
        clean = build_frame(config, framebuffer_for(oc, config))
        plan = build_plan(config)
        faulted = _as_if_ports_read(plan, clean, {3: 4, 4: 3})
        result = _run(oc, [list(clean)] + [list(faulted) for _ in range(59)])

        self.assertGreater(result.frames_matched, 0, "precondition: the guard would pass this")
        self.assertFalse(result.passed)
        self.assertTrue(result.systematic)

    def test_the_same_fault_on_the_real_halves_capture_fails(self):
        """F1 against `captures/06-halves.pcapng`, the capture that can see it.

        Round 1 reported this as `FAIL 0 matched, 46 tolerated, 0 unexplained,
        [torn-frame]` -- a row whose rational reading is "Ledset tore 46 frames,
        re-capture", and every re-capture reproduces it. It must read as a
        mapping fault, at a named port.
        """
        oc = OracleConfig(
            name="t", type="8x8_8P", cols=8, rows=5, pattern="halves", max_tolerated=5
        )
        clean = verify_config(oc, CAPTURES / "06-halves.pcapng")
        self.assertTrue(clean.passed, "precondition: the capture passes unfaulted")

        config = oc.floor_config
        plan = build_plan(config)
        observed = [
            _as_if_ports_read(plan, [v for v in frame], {3: 4, 4: 3})
            for frame in _real_frames(oc, "06-halves.pcapng")
        ]
        result = _run(oc, observed)

        self.assertFalse(result.passed)
        self.assertEqual(result.frames_tolerated, 0)
        self.assertGreater(result.worst_recurrence.fraction, MAX_RECURRENCE)
        self.assertEqual({(r.controller, r.port) for r in result.systematic}, {(0, 3), (0, 4)})


def _real_frames(oc: OracleConfig, name: str) -> list[list[bytes]]:
    from mapper.pcapng import read_udp, split_frames

    plan = build_plan(oc.floor_config)
    groups = [[d.payload for d in f] for f in split_frames(read_udp(CAPTURES / name, 60001))]
    return [g for g in groups if len(g) == len(plan)]


class CrossFrameBounds(unittest.TestCase):
    """The bounds that stop a tolerated bucket from being unbounded."""

    def setUp(self):
        self.oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white")
        self.config = self.oc.floor_config
        self.plan = build_plan(self.config)
        self.clean = build_frame(self.config, white(self.config))

    def _torn(self):
        torn = list(self.clean)
        torn[0] = torn[0][:5] + bytes(10) + torn[0][15:]
        return torn

    def test_one_transient_tear_is_still_tolerated(self):
        """The bar is zero unexplained, not zero diffs -- that must survive."""
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=1)
        frames = [list(self.clean) for _ in range(40)]
        frames[7] = self._torn()
        result = _run(oc, frames)
        self.assertTrue(result.passed, result.failures)
        self.assertEqual(result.frames_tolerated, 1)
        self.assertEqual(result.worst_recurrence.frames, 1)

    def test_max_tolerated_is_a_real_bound(self):
        """Same capture, zero budget: tolerated is no longer an output counter."""
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=0)
        frames = [list(self.clean) for _ in range(40)]
        frames[7] = self._torn()
        result = _run(oc, frames)
        self.assertFalse(result.passed)
        self.assertTrue(any("budget 0" in f for f in result.failures), result.failures)

    def test_max_tolerated_defaults_to_zero(self):
        """A config that never wrote a number down gets no allowance."""
        self.assertEqual(OracleConfig(name="t", type="8x8_4P", cols=4, rows=5).max_tolerated, 0)

    def test_a_short_blank_run_is_a_loop_boundary(self):
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=3)
        blank = build_frame(self.config, black(self.config))
        frames = [list(self.clean) for _ in range(40)]
        frames[20] = frames[21] = list(blank)
        result = _run(oc, frames)
        self.assertTrue(result.passed, result.failures)
        self.assertEqual(result.frames_tolerated, 2)

    def test_an_all_black_capture_is_not_tolerated_wholesale(self):
        """Media that failed to load, a clip that is not playing, an idle floor.

        Round 1 accepted every one of these: `loop-boundary-blank` never checked
        that the blank was at a loop boundary.
        """
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=9)
        blank = build_frame(self.config, black(self.config))
        result = _run(oc, [list(blank) for _ in range(40)])
        self.assertFalse(result.passed)
        self.assertTrue(any("sustained-blank" in f for f in result.failures), result.failures)
        self.assertGreater(result.frames_unexplained, MAX_BLANK_RUN)

    def test_partial_frames_at_the_capture_edges_are_counted_and_allowed(self):
        """Every real Ledset capture ends one datagram into the next frame."""
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=0)
        result = _run(oc, [list(self.clean) for _ in range(40)], partial=[(40, 1)])
        self.assertTrue(result.passed, result.failures)
        self.assertEqual(len(result.partial_frames), 1)

    def test_a_partial_frame_inside_the_capture_fails(self):
        """A controller dropping out mid-capture must not vanish from the table."""
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=0)
        result = _run(oc, [list(self.clean) for _ in range(40)], partial=[(17, 12), (41, 1)])
        self.assertFalse(result.passed)
        self.assertTrue(any("inside the capture" in f for f in result.failures), result.failures)

    def test_no_exact_match_fails_even_with_everything_explained(self):
        """Documented criterion 4 (`docs/ORACLE_HARNESS.md` S8): a capture whose
        every frame is written off has proved nothing, whatever its budget."""
        oc = OracleConfig(name="t", type="8x8_4P", cols=4, rows=5, pattern="white", max_tolerated=3)
        blank = build_frame(self.config, black(self.config))
        result = _run(oc, [list(blank), self._torn(), list(blank)])
        self.assertEqual(result.frames_matched, 0)
        self.assertFalse(result.passed)
        self.assertTrue(any("no frame matched" in f for f in result.failures), result.failures)


class RecurrenceThresholdDerivation(unittest.TestCase):
    """The threshold is a measurement of the real captures, so measure them.

    `MAX_RECURRENCE`'s docstring quotes a ceiling of 2.3 %. If that stops being
    true of `captures/*.pcapng`, the number in the source is no longer derived
    from anything and this fails -- rather than the harness quietly running on a
    threshold whose justification has expired.
    """

    CASES = [
        ("01-black", "black", 0.0),
        ("02-white", "white", 1 / 46),
        ("03-red", "red", 1 / 44),
        ("06-halves", "halves", 1 / 46),
        ("20-ours-white", "white", 0.0),
    ]

    def test_measured_ceiling_is_far_below_the_threshold(self):
        worst = 0.0
        for name, pattern, expected in self.CASES:
            oc = OracleConfig(name=name, type="8x8_8P", cols=8, rows=5, pattern=pattern)
            result = verify_config(oc, CAPTURES / f"{name}.pcapng")
            got = result.worst_recurrence.fraction if result.worst_recurrence else 0.0
            with self.subTest(capture=name):
                self.assertAlmostEqual(got, expected, places=6)
            worst = max(worst, got)
        self.assertLess(worst, 0.025, "measured ceiling across every real capture")
        self.assertGreater(
            MAX_RECURRENCE, worst * 8,
            "the threshold must keep an order of magnitude over the noise it tolerates",
        )
        self.assertLess(
            MAX_RECURRENCE, 0.5,
            "and must stay far below the 100% an injected mapping fault produces",
        )


class AgainstRealCaptures(unittest.TestCase):
    """The same captures the dry-run config list points at."""

    def test_black_is_a_clean_pass(self):
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="black")
        result = verify_config(oc, CAPTURES / "01-black.pcapng")
        self.assertIsNone(result.error)
        self.assertTrue(result.passed)
        self.assertEqual(result.frames_unexplained, 0)
        self.assertGreater(result.frames_matched, 0)

    def test_white_passes_with_tolerated_defects_only(self):
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="white", max_tolerated=3)
        result = verify_config(oc, CAPTURES / "02-white.pcapng")
        self.assertIsNone(result.error)
        self.assertTrue(result.passed, result.failures)
        self.assertEqual(result.frames_unexplained, 0)
        self.assertEqual(result.frames_tolerated, 3, "1 torn frame + a 2-frame loop blank")

    def test_halves_blanks_are_labelled_blanks_not_tears(self):
        """The real regression, on the real file: frames 31-33 are all-black."""
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="halves", max_tolerated=5)
        result = verify_config(oc, CAPTURES / "06-halves.pcapng")
        self.assertTrue(result.passed, result.failures)
        labels = {v.frame_index: v.classification for v in result.verdicts if not v.ok}
        self.assertEqual(labels[31], "loop-boundary-blank")
        self.assertEqual(labels[32], "loop-boundary-blank")
        self.assertEqual(labels[33], "loop-boundary-blank")
        self.assertEqual(labels[6], "torn-frame")
        self.assertEqual(labels[7], "torn-frame")

    def test_every_ledset_capture_ends_one_datagram_into_the_next_frame(self):
        """Counted, not dropped. `20-ours-white` stops on a frame boundary."""
        for name, pattern, expected in (
            ("01-black", "black", [(46, 1)]),
            ("02-white", "white", [(46, 1)]),
            ("03-red", "red", [(44, 1)]),
            ("06-halves", "halves", [(46, 1)]),
            ("20-ours-white", "white", []),
        ):
            oc = OracleConfig(
                name=name, type="8x8_8P", cols=8, rows=5, pattern=pattern, max_tolerated=5
            )
            result = verify_config(oc, CAPTURES / f"{name}.pcapng")
            with self.subTest(capture=name):
                self.assertEqual(result.partial_frames, expected)
                self.assertTrue(result.passed, result.failures)

    def test_wrong_pattern_against_a_real_capture_fails_with_a_located_divergence(self):
        """Feed it the wrong source pattern -- every frame should disagree,
        and the failure must be classified 'unexplained', not tolerated."""
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="red", max_tolerated=99)
        result = verify_config(oc, CAPTURES / "02-white.pcapng")
        self.assertFalse(result.passed)
        self.assertGreater(result.frames_unexplained, 0)
        self.assertIsNotNone(result.first_divergence)
        self.assertIn(result.first_divergence.field, ("header", "body"))

    def test_missing_capture_is_a_reported_row_not_an_exception(self):
        oc = OracleConfig(name="t", type="8x8_4P", cols=10, rows=5, pattern="gradient24", capture=None)
        result = verify_config(oc, None)
        self.assertFalse(result.passed)
        self.assertIsNotNone(result.error)


if __name__ == "__main__":
    unittest.main()
