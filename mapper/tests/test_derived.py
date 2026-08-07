"""Derived sizes checked against the tables written up in the docs.

Two rigs. The 8x5 `8x8_8P` numbers come from `docs/DECOMP_FINDINGS.md` and were
verified on the wire on 2026-08-06. The 10x5 `8x8_4P` numbers are the current
rig — three controllers with a partial last controller, which is the first
layout to exercise both at once.
"""

from __future__ import annotations

import unittest

from mapper.floors import FLOOR_TYPES, MAX_TILE_COLS, FloorConfig, floor_type
from mapper.plan import build_plan


class ReferenceRig8x5(unittest.TestCase):
    """8 x 5 tiles, `8x8_8P`, one controller. The 2026-08-06 capture rig."""

    def setUp(self):
        self.config = FloorConfig.of("8x8_8P", 8, 5)

    def test_derived_values(self):
        c = self.config
        self.assertEqual(c.type.ports_per_controller, 8)
        self.assertEqual((c.width_px, c.height_px), (64, 40))
        self.assertEqual(c.pixel_count, 2560)
        self.assertEqual(c.port_data_size, 960)
        self.assertEqual(c.packets_per_port, 2)
        self.assertEqual(c.controller_count, 1)
        self.assertEqual(c.last_controller_port_count, 8)
        self.assertEqual(c.packets_per_frame, 16)
        self.assertEqual(c.bytes_per_frame, 7760)

    def test_packet_shape(self):
        plan = build_plan(self.config)
        self.assertEqual([p.datagram_len for p in plan], [512, 458] * 8)
        self.assertEqual([p.byte4 for p in plan], [0, 1] * 7 + [0, 0x81])
        self.assertEqual({p.controller for p in plan}, {0})

    def test_mapper_xml_indices(self):
        """`Test3.mapper.xml`: TypeIndex 3, FeetOfWidthIndex 7, FeetOfHeightIndex 4."""
        self.assertEqual(self.config.type.type_index, 3)
        self.assertEqual(self.config.feet_of_width_index, 7)
        self.assertEqual(self.config.feet_of_height_index, 4)


class CurrentRig10x5(unittest.TestCase):
    """10 x 5 tiles, `8x8_4P`, three controllers with a partial last one."""

    def setUp(self):
        self.config = FloorConfig.of("8x8_4P", 10, 5)

    def test_derived_values(self):
        c = self.config
        self.assertEqual(c.type.ports_per_controller, 4)
        self.assertEqual((c.width_px, c.height_px), (80, 40))
        self.assertEqual(c.port_data_size, 960)
        self.assertEqual(c.packets_per_port, 2)
        self.assertEqual(c.controller_count, 3)
        self.assertEqual(c.last_controller_port_count, 2)
        self.assertEqual([c.ports_on(i) for i in range(3)], [4, 4, 2])
        self.assertEqual(c.packets_per_frame, 20)
        self.assertEqual(c.bytes_per_frame, 9700)
        self.assertEqual((c.width_mm, c.height_mm), (5000.0, 2500.0))

    def test_controller_owns_its_tile_columns(self):
        plan = build_plan(self.config)
        owned: dict[int, set[int]] = {}
        for packet in plan:
            owned.setdefault(packet.controller, set()).add(packet.tile_col)
        self.assertEqual(owned, {0: {0, 1, 2, 3}, 1: {4, 5, 6, 7}, 2: {8, 9}})

    def test_three_end_of_frame_flags(self):
        flagged = [(p.controller, p.port, p.byte4) for p in build_plan(self.config) if p.is_eof]
        self.assertEqual(flagged, [(0, 3, 0x81), (1, 3, 0x81), (2, 1, 0x81)])

    def test_byte_one_takes_three_values(self):
        self.assertEqual({p.header[1] for p in build_plan(self.config)}, {0x00, 0x01, 0x02})


class Envelope(unittest.TestCase):
    def test_row_limits_match_the_mapper_ui(self):
        self.assertEqual(
            {name: t.max_tile_rows for name, t in FLOOR_TYPES.items()},
            {"6x6_4P": 25, "6x6_8P": 17, "8x8_4P": 22, "8x8_8P": 11},
        )

    def test_type_indices_match_the_floortype_enum(self):
        self.assertEqual(
            {name: t.type_index for name, t in FLOOR_TYPES.items()},
            {"6x6_4P": 0, "6x6_8P": 1, "8x8_4P": 2, "8x8_8P": 3},
        )
        self.assertIs(floor_type(3), FLOOR_TYPES["8x8_8P"])

    def test_only_8x8_is_claimed(self):
        self.assertEqual(
            {name for name, t in FLOOR_TYPES.items() if t.supported}, {"8x8_4P", "8x8_8P"}
        )
        self.assertEqual(
            {name for name, t in FLOOR_TYPES.items() if t.hardware_verified}, {"8x8_8P"}
        )

    def test_scan_tables(self):
        self.assertEqual(FLOOR_TYPES["8x8_8P"].scan_table, tuple(range(64)))
        six = FLOOR_TYPES["6x6_4P"]
        self.assertEqual(six.scan_table[1], 6)
        self.assertEqual(six.scan_table[6], 1)
        self.assertEqual(six.scan_table, six.slot_of_source, "transpose is its own inverse")

    def test_rejects_illegal_geometry(self):
        with self.assertRaises(ValueError):
            FloorConfig.of("8x8_8P", 8, 12)
        with self.assertRaises(ValueError):
            FloorConfig.of("8x8_8P", MAX_TILE_COLS + 1, 5)
        with self.assertRaises(ValueError):
            FloorConfig.of("8x8_8P", 0, 5)


if __name__ == "__main__":
    unittest.main()
