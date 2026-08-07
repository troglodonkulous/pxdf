"""Graded against Ledset itself, using the 2026-08-06 captures.

`captures/01-07` are Ledset transmitting an AVI at 8x5 `8x8_8P` — the vendor's
own bytes, not ours. Two independent bars are checked here:

* **Bytes out.** Our generated frame must equal Ledset's, datagram for
  datagram, header included.
* **Image in.** Ledset's frames are decoded back through our mapping, and the
  resulting picture must be what the source video actually showed. A solid
  colour cannot detect a permutation, so the spatial captures carry this.

Ledset's own defects are expected and tolerated: two all-black frames at each
video loop boundary, and the occasional torn frame from its unlocked send
thread. Both are documented in `docs/CAPTURE_RESULTS.md`.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from mapper.floors import FloorConfig
from mapper.frame import buffer_from_datagrams, build_frame, unpack_send_buffer
from mapper.orientation import IDENTITY
from mapper.patterns import black, solid, white
from mapper.pcapng import read_udp, split_frames
from mapper.plan import build_plan

CAPTURES = Path(__file__).resolve().parents[2] / "captures"

#: The rig those captures were taken on.
RIG = FloorConfig.of("8x8_8P", 8, 5)


def load(name: str) -> list[list[bytes]]:
    """Complete frames from a capture, as lists of raw datagrams."""
    datagrams = read_udp(CAPTURES / name, 60001)
    frames = [[d.payload for d in frame] for frame in split_frames(datagrams)]
    return [f for f in frames if len(f) == RIG.packets_per_frame]


def distinct(frames: list[list[bytes]]) -> list[bytes]:
    """Distinct frame payloads, ignoring headers, preserving first-seen order."""
    seen: dict[bytes, None] = {}
    for frame in frames:
        seen.setdefault(b"".join(d[5:] for d in frame), None)
    return list(seen)


def decode(frame: list[bytes]) -> bytearray:
    return unpack_send_buffer(RIG, buffer_from_datagrams(RIG, frame), IDENTITY)


def pixel(framebuffer: bytes, x: int, y: int) -> tuple[int, int, int]:
    i = (y * RIG.width_px + x) * 3
    return tuple(framebuffer[i : i + 3])


class CaptureShape(unittest.TestCase):
    def test_headers_match_our_plan_exactly(self):
        expected = [p.header for p in build_plan(RIG)]
        for name in ("01-black", "02-white", "03-red", "06-halves", "07-tilewalk"):
            frames = load(f"{name}.pcapng")
            with self.subTest(capture=name):
                self.assertGreater(len(frames), 10)
                for frame in frames:
                    self.assertEqual([d[:5] for d in frame], expected)
                    self.assertEqual(
                        [len(d) for d in frame], [p.datagram_len for p in build_plan(RIG)]
                    )


class BytesOut(unittest.TestCase):
    """Our generated frame, byte for byte against Ledset's."""

    def _assert_matches_one_of(self, name, candidates: dict[str, list[bytes]]):
        frames = load(f"{name}.pcapng")
        counts = {label: 0 for label in candidates}
        unmatched = 0
        for frame in frames:
            for label, expected in candidates.items():
                if frame == expected:
                    counts[label] += 1
                    break
            else:
                unmatched += 1
        return frames, counts, unmatched

    def test_black(self):
        frames, counts, unmatched = self._assert_matches_one_of(
            "01-black", {"black": build_frame(RIG, black(RIG))}
        )
        self.assertEqual(unmatched, 0)
        self.assertEqual(counts["black"], len(frames))

    def test_white(self):
        candidates = {
            "white": build_frame(RIG, white(RIG)),
            "loop-boundary black": build_frame(RIG, black(RIG)),
        }
        frames, counts, unmatched = self._assert_matches_one_of("02-white", candidates)
        self.assertGreaterEqual(counts["white"], 40)
        self.assertEqual(counts["loop-boundary black"], 2, "Ledset's documented loop blank")
        self.assertLessEqual(unmatched, 1, "at most the one documented torn frame")
        self.assertEqual(counts["white"] + counts["loop-boundary black"] + unmatched, len(frames))

    def test_red_is_red_on_the_wire(self):
        """Confirms BGR: a red source must put 0x00 0x00 0xFF in each pixel."""
        candidates = {
            "red": build_frame(RIG, solid(RIG, 255, 0, 0)),
            "loop-boundary black": build_frame(RIG, black(RIG)),
        }
        frames, counts, unmatched = self._assert_matches_one_of("03-red", candidates)
        self.assertGreaterEqual(counts["red"], 40)
        self.assertLessEqual(unmatched, 1)

    def test_halves(self):
        """The first real spatial check — a solid frame cannot detect a permutation."""
        framebuffer = black(RIG)
        for y in range(RIG.height_px):
            for x in range(RIG.width_px // 2):
                i = (y * RIG.width_px + x) * 3
                framebuffer[i : i + 3] = b"\xff\xff\xff"
        candidates = {
            "left white": build_frame(RIG, framebuffer),
            "loop-boundary black": build_frame(RIG, black(RIG)),
        }
        frames, counts, unmatched = self._assert_matches_one_of("06-halves", candidates)
        self.assertGreaterEqual(counts["left white"], 40)


class ImageIn(unittest.TestCase):
    """Ledset's frames, decoded back through our mapping into a picture."""

    def test_halves_decodes_to_a_clean_vertical_split(self):
        images = [decode(f) for f in load("06-halves.pcapng")]
        lit = [img for img in images if any(img)]
        self.assertGreaterEqual(len(lit), 40)
        for img in lit:
            for y in (0, RIG.height_px // 2, RIG.height_px - 1):
                for x in range(RIG.width_px):
                    expected = (255, 255, 255) if x < RIG.width_px // 2 else (0, 0, 0)
                    self.assertEqual(pixel(img, x, y), expected, f"at ({x}, {y})")

    def test_tilewalk_decodes_to_exactly_one_lit_tile(self):
        """Proves the tile layout and the per-tile scan, not just the packet shape.

        Every non-black frame in the walk must decode to a single fully lit tile
        aligned to the tile grid. A wrong column-major order, a serpentine scan
        or a transposed tile all break this; none of them break a white frame.
        """
        tile_px = RIG.type.tile_px
        positions = set()
        whole = 0
        torn = 0
        for payload_frame in load("07-tilewalk.pcapng"):
            img = decode(payload_frame)
            lit = {
                (x, y)
                for y in range(RIG.height_px)
                for x in range(RIG.width_px)
                if pixel(img, x, y) != (0, 0, 0)
            }
            if not lit:
                continue
            xs = {x // tile_px for x, _ in lit}
            ys = {y // tile_px for _, y in lit}
            # Confinement to one tile is the mapping claim, and it must hold on
            # every frame. Fullness can fail on a torn frame, where Ledset's
            # send thread read the capture buffer mid-write.
            self.assertEqual(len(xs), 1, "lit pixels spread across tile columns")
            self.assertEqual(len(ys), 1, "lit pixels spread across tile rows")
            if len(lit) == tile_px * tile_px and all(
                pixel(img, x, y) == (255, 255, 255) for x, y in lit
            ):
                whole += 1
            else:
                # A torn frame tears mid-pixel as well as mid-tile: Ledset's
                # send thread reads the capture buffer at byte granularity.
                torn += 1
            positions.add((xs.pop(), ys.pop()))

        self.assertGreaterEqual(whole, 100, "most frames must show a fully lit tile")
        self.assertLessEqual(torn, 2, "Ledset's documented torn frames, and no more")
        self.assertGreaterEqual(len(positions), 8, "the walk should visit many tiles")
        for tile_col, tile_row in positions:
            self.assertLess(tile_col, RIG.tile_cols)
            self.assertLess(tile_row, RIG.tile_rows)


if __name__ == "__main__":
    unittest.main()
