"""The committed fixtures must still be what the mapper produces.

This is the drift alarm. If a change to the mapper alters a single byte of a
fixture, that is either a bug or a deliberate contract change — and a
deliberate change should show up as a diff in `fixtures/`, reviewed, not
silently absorbed.
"""

from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

from mapper import fixtures as fixtures_module
from mapper import mapper_xml
from mapper.floors import FloorConfig, legal_configs

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


class CommittedFixtures(unittest.TestCase):
    def setUp(self):
        if not FIXTURES.exists():
            self.skipTest("fixtures not generated — run `python -m mapper fixtures`")

    def test_each_fixture_still_matches(self):
        for spec in fixtures_module.fixture_specs():
            with self.subTest(fixture=spec.name):
                manifest, datagrams = fixtures_module.build_manifest(spec)
                path = FIXTURES / "manifests" / f"{spec.name}.json"
                self.assertTrue(path.exists(), f"missing manifest {path.name}")
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), manifest)
                if spec.golden:
                    golden = (FIXTURES / "golden" / f"{spec.name}.bin").read_bytes()
                    self.assertEqual(golden, b"".join(datagrams))
                    self.assertEqual(
                        hashlib.sha256(golden).hexdigest(), manifest["frameSha256"]
                    )

    def test_manifest_headers_agree_with_the_golden_bytes(self):
        """The header table is the contract; the dump must not contradict it."""
        for spec in fixtures_module.fixture_specs():
            if not spec.golden:
                continue
            with self.subTest(fixture=spec.name):
                manifest = json.loads(
                    (FIXTURES / "manifests" / f"{spec.name}.json").read_text(encoding="utf-8")
                )
                blob = (FIXTURES / "golden" / f"{spec.name}.bin").read_bytes()
                cursor = 0
                for controller, port, packet_index, byte4, length in manifest["packets"]:
                    header = blob[cursor : cursor + 5]
                    self.assertEqual(header[0], 0xFF)
                    self.assertEqual(header[1], controller)
                    self.assertEqual(header[2], 0x01)
                    self.assertEqual(header[3], port)
                    self.assertEqual(header[4], byte4)
                    self.assertEqual(byte4 & 0x7F, packet_index)
                    cursor += length
                self.assertEqual(cursor, len(blob))
                self.assertEqual(cursor, manifest["derived"]["bytesPerFrame"])

    def test_index_lists_every_fixture(self):
        index = json.loads((FIXTURES / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(
            [entry["name"] for entry in index["fixtures"]],
            [spec.name for spec in fixtures_module.fixture_specs()],
        )

    def test_fixture_names_are_unique(self):
        names = [spec.name for spec in fixtures_module.fixture_specs()]
        self.assertEqual(len(names), len(set(names)))


class MapperXmlRoundTrip(unittest.TestCase):
    def test_matches_the_vendor_file_byte_for_byte(self):
        reference = Path(__file__).resolve().parents[2] / "reference" / "Test3.mapper.xml"
        expected = reference.read_text(encoding="utf-8").replace("\r\n", "\n").rstrip("\n")
        self.assertEqual(mapper_xml.to_xml(FloorConfig.of("8x8_8P", 8, 5)), expected)

    def test_round_trips_every_legal_geometry(self):
        for config in legal_configs():
            with self.subTest(config=config.describe()):
                self.assertEqual(mapper_xml.from_xml(mapper_xml.to_xml(config)), config)

    def test_reads_the_vendor_file(self):
        reference = Path(__file__).resolve().parents[2] / "reference" / "Test3.mapper.xml"
        self.assertEqual(mapper_xml.read(reference), FloorConfig.of("8x8_8P", 8, 5))

    def test_rejects_a_contradictory_file(self):
        bad = mapper_xml.to_xml(FloorConfig.of("8x8_8P", 8, 5)).replace('Width="64"', 'Width="72"')
        with self.assertRaises(ValueError):
            mapper_xml.from_xml(bad)


if __name__ == "__main__":
    unittest.main()
