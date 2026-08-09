"""The invariant suite, run over every legal (type, cols, rows).

These are the properties the vendor's send loop has by construction. If a
generalisation breaks one, it is wrong regardless of what the floor happens to
show.
"""

from __future__ import annotations

import unittest

from mapper.floors import BODY_MAX, CONST_BYTE2, EOF_FLAG, HEADER_LEN, MAGIC, legal_configs
from mapper.frame import send_buffer_sources
from mapper.orientation import IDENTITY, Orientation
from mapper.plan import build_plan

ALL_CONFIGS = tuple(legal_configs())

#: Orientations exercised by the bijection sweep. The transform is applied
#: before packing, so it must permute the framebuffer and nothing else.
ORIENTATIONS = (
    IDENTITY,
    Orientation(rotate_180=True),
    Orientation(mirror_x=True),
    Orientation(reverse_columns_per_controller=True),
    Orientation(rotate_180=True, mirror_x=True, reverse_columns_per_controller=True),
)


class PlanInvariants(unittest.TestCase):
    """Structural properties of the packet plan, over the whole legal matrix."""

    def test_matrix_is_the_size_we_think_it_is(self):
        self.assertEqual(len(ALL_CONFIGS), 32 * (25 + 17 + 22 + 11))

    def test_every_config(self):
        for config in ALL_CONFIGS:
            with self.subTest(config=config.describe()):
                plan = build_plan(config)
                self._check_headers(config, plan)
                self._check_one_eof_per_controller(config, plan)
                self._check_port_payloads_are_covered_exactly(config, plan)
                self._check_tile_columns(config, plan)
                self._check_totals(config, plan)

    def _check_headers(self, config, plan):
        for packet in plan:
            header = packet.header
            self.assertEqual(len(header), HEADER_LEN)
            self.assertEqual(header[0], MAGIC)
            self.assertEqual(header[1], packet.controller)
            self.assertEqual(header[2], CONST_BYTE2)
            self.assertEqual(header[3], packet.port)
            self.assertEqual(header[4], packet.byte4)
            self.assertEqual(packet.byte4 & 0x7F, packet.packet_index)
            self.assertLess(packet.controller, 256, "controller index must fit one byte")
            self.assertLess(packet.packet_index, 0x80, "packet index must not collide with the EOF flag")
            self.assertTrue(0 < packet.body_len <= BODY_MAX)
            self.assertEqual(packet.datagram_len, packet.body_len + HEADER_LEN)
            self.assertLessEqual(packet.datagram_len, 512)

    def _check_one_eof_per_controller(self, config, plan):
        flagged = [p for p in plan if p.is_eof]
        self.assertEqual(len(flagged), config.controller_count)
        self.assertEqual(
            sorted(p.controller for p in flagged), list(range(config.controller_count))
        )
        for packet in flagged:
            self.assertEqual(packet.port, config.ports_on(packet.controller) - 1)
            self.assertEqual(packet.packet_index, config.packets_per_port - 1)
        self.assertIs(flagged[-1], plan[-1], "the frame must end on an EOF packet")

    def _check_port_payloads_are_covered_exactly(self, config, plan):
        """Each port's payload is tiled by its packets: contiguous, no gaps, no overlap."""
        by_port: dict[tuple[int, int], list] = {}
        for packet in plan:
            by_port.setdefault((packet.controller, packet.port), []).append(packet)

        self.assertEqual(len(by_port), config.tile_cols)
        for (controller, port), packets in by_port.items():
            self.assertEqual(len(packets), config.packets_per_port)
            self.assertEqual(
                [p.packet_index for p in packets], list(range(config.packets_per_port))
            )
            cursor = 0
            for packet in packets:
                self.assertEqual(packet.port_offset, cursor)
                cursor += packet.body_len
            self.assertEqual(cursor, config.port_data_size)
            self.assertLess(port, config.ports_on(controller))

    def _check_tile_columns(self, config, plan):
        covered = sorted({p.tile_col for p in plan})
        self.assertEqual(covered, list(range(config.tile_cols)))
        for packet in plan:
            self.assertEqual(
                packet.tile_col,
                config.type.ports_per_controller * packet.controller + packet.port,
            )

    def _check_totals(self, config, plan):
        self.assertEqual(len(plan), config.packets_per_frame)
        self.assertEqual(sum(p.datagram_len for p in plan), config.bytes_per_frame)
        self.assertEqual(sum(p.body_len for p in plan), config.pixel_count * 3)

    def test_eof_can_be_suppressed(self):
        for config in (ALL_CONFIGS[0], ALL_CONFIGS[-1]):
            plan = build_plan(config, eof=False)
            self.assertEqual([p for p in plan if p.is_eof], [])
            self.assertEqual(
                [p.byte4 for p in plan],
                [p.byte4 & ~EOF_FLAG for p in build_plan(config, eof=True)],
            )


class PixelBijection(unittest.TestCase):
    """Every logical pixel occupies exactly one wire slot, and every slot is filled.

    `send_buffer_sources` raises on a collision or a hole, so building it is the
    proof; the assertions here confirm the result is a permutation of the whole
    framebuffer.
    """

    def _check(self, config, orientation):
        sources = send_buffer_sources(config, orientation)
        self.assertEqual(len(sources), config.pixel_count)
        self.assertEqual(sorted(sources), list(range(config.pixel_count)))

    def test_identity_over_the_whole_matrix(self):
        for config in ALL_CONFIGS:
            with self.subTest(config=config.describe()):
                self._check(config, IDENTITY)

    def test_orientations_over_a_covering_sample(self):
        """Every branch of the orientation transform, at every awkward geometry.

        The full matrix crossed with five orientations is a five-fold repeat of
        the same permutation proof; these configs cover the cases the transform
        can actually get wrong — partial last controller, single controller,
        single tile column, single row, and the maximum of each axis.
        """
        interesting = [
            c
            for c in ALL_CONFIGS
            if c.tile_cols in (1, 2, 3, 4, 5, 7, 8, 9, 10, 31, 32)
            and c.tile_rows in (1, 2, 3, c.type.max_tile_rows)
        ]
        self.assertGreater(len(interesting), 100)
        for config in interesting:
            for orientation in ORIENTATIONS:
                with self.subTest(config=config.describe(), orientation=orientation.describe()):
                    self._check(config, orientation)

    def test_orientations_are_involutions(self):
        """Applying a transform twice returns the original pixel."""
        from mapper.floors import FloorConfig

        for config in (
            FloorConfig.of("8x8_4P", 10, 5),
            FloorConfig.of("8x8_8P", 8, 5),
            FloorConfig.of("6x6_4P", 7, 3),
        ):
            for orientation in ORIENTATIONS:
                with self.subTest(config=config.describe(), orientation=orientation.describe()):
                    for y in range(config.height_px):
                        for x in range(config.width_px):
                            once = orientation.to_wire(config, x, y)
                            self.assertEqual(orientation.to_wire(config, *once), (x, y))


if __name__ == "__main__":
    unittest.main()
