"""Config list loading and report rendering -- the plumbing around decode_diff."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.oracle.config_list import load
from tools.oracle.decode_diff import verify_config
from tools.oracle.report import to_json, to_table

DRYRUN = ROOT / "tools" / "oracle" / "configs.dryrun.json"
ACCEPTANCE = ROOT / "tools" / "oracle" / "configs.acceptance.json"
CAPTURES = ROOT / "captures"


class ConfigListLoading(unittest.TestCase):
    def test_dryrun_list_loads(self):
        configs = load(DRYRUN)
        self.assertGreaterEqual(len(configs), 5)
        self.assertTrue(any(c.capture is None for c in configs), "expect the acceptance-gap row")

    def test_acceptance_list_never_claims_a_capture_that_does_not_exist(self):
        """The real invariant, which outlived the gate-2 session.

        Until 2026-08-08 this asserted every acceptance capture was `null`,
        which was true only because no attended session had run yet -- the
        assertion encoded a schedule, not a property. Gate 2 filled two of the
        three rows in, and the thing actually worth defending is what the old
        message already said: a row must not name a file that is not there.
        """
        configs = load(ACCEPTANCE)
        self.assertGreaterEqual(len(configs), 1)
        for oc in configs:
            if oc.capture is None:
                continue
            with self.subTest(config=oc.name):
                self.assertTrue(
                    (ROOT / oc.capture).exists(),
                    f"{oc.name} claims {oc.capture}, which is not on disk",
                )

    def test_unknown_field_is_rejected(self):
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"configs": [{"name": "x", "type": "8x8_4P", "cols": 1, "rows": 1, "bogus": True}]}, f)
            path = f.name
        try:
            with self.assertRaises(ValueError):
                load(path)
        finally:
            Path(path).unlink()


class ReportRendering(unittest.TestCase):
    def test_table_and_json_cover_a_pass_a_fail_and_an_error_row(self):
        configs = load(DRYRUN)
        results = [
            verify_config(oc, (ROOT / oc.capture) if oc.capture else None)
            for oc in configs
        ]
        self.assertTrue(any(r.passed for r in results), "expect at least one PASS in the default dry-run list")
        self.assertTrue(any(r.error for r in results), "expect the no-capture acceptance row to surface as an error")

        table = to_table(results)
        self.assertIn("PASS", table)
        self.assertIn("configs passed", table)

        payload = json.loads(to_json(results))
        self.assertEqual(payload["schema"], "pxdf-oracle-report/2")
        self.assertEqual(payload["summary"]["total"], len(results))
        self.assertEqual(
            payload["summary"]["passed"] + payload["summary"]["failed"], len(results)
        )

    def test_every_row_carries_the_recurrence_reading_and_the_tolerance_budget(self):
        """The instrument's readings must be on the row even when it passes.

        A verdict that only appears as PASS/FAIL is exactly the kind of
        self-agreeing measurement this project keeps getting wrong; a printed
        number regresses visibly.
        """
        configs = load(DRYRUN)
        results = [
            verify_config(oc, (ROOT / oc.capture) if oc.capture else None) for oc in configs
        ]
        payload = json.loads(to_json(results))
        for row in payload["configs"]:
            if row["error"]:
                continue
            self.assertIn("worstRecurrence", row)
            self.assertIn("maxTolerated", row)
            self.assertIn("partialFrames", row)
            self.assertIsInstance(row["systematicMismatches"], list)
            self.assertLessEqual(row["framesTolerated"], row["maxTolerated"])

        table = to_table(results)
        self.assertIn("recur", table)
        self.assertIn("3/3", table, "02-white's tolerated count must print against its budget")

    def test_every_config_with_a_capture_has_a_measured_tolerance_budget_note(self):
        """`max_tolerated` is a measurement, so the config must say what was measured.

        Both lists, not just the dry-run one: the acceptance rows carried a
        *derived* budget until a capture existed at that geometry, and the
        whole point of re-measuring it after gate 2 is that the derivation
        stops being the justification.
        """
        for path in (DRYRUN, ACCEPTANCE):
            for oc in load(path):
                if oc.capture is None:
                    continue
                with self.subTest(list=path.name, config=oc.name):
                    self.assertIn("Measured", oc.notes, "max_tolerated must be justified in notes")


if __name__ == "__main__":
    unittest.main()
