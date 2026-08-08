"""Unit tests for the harness's own logic layered on top of `mapper/`.

Does not re-test `mapper.pcapng` or `mapper.verify` -- those have their own
suite under `mapper/tests/`. This covers what `tools/oracle/decode_diff.py`
adds: the defect classifier, and the packet-ordinal -> protocol-terms
mapping. `test_against_real_captures` is the end-to-end check, run against
the same `captures/*.pcapng` the dry-run config list uses.
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
from mapper.patterns import black, white
from mapper.plan import build_plan
from mapper.verify import compare_frame

from tools.oracle.config_list import OracleConfig
from tools.oracle.decode_diff import _classify, verify_config

CAPTURES = ROOT / "captures"


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
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="white")
        result = verify_config(oc, CAPTURES / "02-white.pcapng")
        self.assertIsNone(result.error)
        self.assertTrue(result.passed)
        self.assertEqual(result.frames_unexplained, 0)
        self.assertGreater(result.frames_tolerated, 0, "expected Ledset's documented loop-boundary blanks")

    def test_wrong_pattern_against_a_real_capture_fails_with_a_located_divergence(self):
        """Feed it the wrong source pattern -- every frame should disagree,
        and the failure must be classified 'unexplained', not tolerated."""
        oc = OracleConfig(name="t", type="8x8_8P", cols=8, rows=5, pattern="red")
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
