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

    def test_acceptance_list_loads_and_every_capture_is_null(self):
        configs = load(ACCEPTANCE)
        self.assertGreaterEqual(len(configs), 1)
        self.assertTrue(all(c.capture is None for c in configs), "acceptance list must not claim a capture that doesn't exist")

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
        self.assertEqual(payload["schema"], "ddf-oracle-report/1")
        self.assertEqual(payload["summary"]["total"], len(results))
        self.assertEqual(
            payload["summary"]["passed"] + payload["summary"]["failed"], len(results)
        )


if __name__ == "__main__":
    unittest.main()
