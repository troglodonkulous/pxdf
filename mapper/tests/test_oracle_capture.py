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

from mapper.avi import Video, read_video
from mapper.floors import FloorConfig
from mapper.frame import buffer_from_datagrams, build_frame, unpack_send_buffer
from mapper.orientation import IDENTITY
from mapper.patterns import black, solid, white
from mapper.pcapng import read_udp, split_frames
from mapper.plan import build_plan

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = ROOT / "captures"
VIDEOS = ROOT / "test-patterns"

#: The rig those captures were taken on.
RIG = FloorConfig.of("8x8_8P", 8, 5)

#: The video's full walk, as `((tile_col, tile_row), frame_count)` runs.
TILEWALK_VIDEO = VIDEOS / "07-tilewalk.avi"


def _lit_tile(video: Video, frame: bytes) -> tuple[int, int] | None:
    """The one tile lit in a video frame, or `None` if the frame is black."""
    lit = {
        (x, y)
        for y in range(video.height)
        for x in range(video.width)
        if video.pixel(frame, x, y) != (0, 0, 0)
    }
    if not lit:
        return None
    tile_px = RIG.type.tile_px
    columns = {x // tile_px for x, _ in lit}
    rows = {y // tile_px for _, y in lit}
    if len(columns) != 1 or len(rows) != 1:
        raise AssertionError(f"video frame lights more than one tile: {columns} x {rows}")
    return columns.pop(), rows.pop()


def walk_from_video(path: Path) -> tuple[tuple[tuple[int, int], int], ...]:
    """The tile-walk sequence read straight out of the source video.

    Each frame is reduced to the single tile it lights, consecutive identical
    frames collapse into one run, and the black lead-in drops out. The result
    is `((tile_col, tile_row), frame_count)` in playback order.

    This is the whole point of `mapper/avi.py`: the expected sequence is
    derived from the file Ledset actually played, not from a transcription of
    it. `tilewalk_timing.md` is *generated* from the same list that renders the
    video, so asserting against the timing sheet would have been circular in
    exactly the way this repo has been burned by five times already.
    """
    video = read_video(path)
    if (video.width, video.height) != (RIG.width_px, RIG.height_px):
        raise AssertionError(
            f"{path} is {video.width}x{video.height}, but the rig is "
            f"{RIG.width_px}x{RIG.height_px} — wrong asset for this test"
        )
    runs: list[list] = []
    for frame in video.frames:
        position = _lit_tile(video, frame)
        if position is None:
            continue
        if runs and runs[-1][0] == position:
            runs[-1][1] += 1
        else:
            runs.append([position, 1])
    return tuple((position, count) for position, count in runs)


#: The walk `test-patterns/07-tilewalk.avi` performs, decoded from the file
#: itself. Eleven positions of 20 frames each after a 20-frame black lead-in.
#: This is the only sequence in the repo that resolves individual tiles, so it
#: is the only thing that can kill a permutation of the tile grid.
#:
#: **The capture is truncated.** `07-tilewalk.pcapng` holds 238 complete frames
#: over a 25.9 s span and stops 7 frames into position 8, so positions 9–11 —
#: `(7,0)`, `(7,4)` and `(4,2)` — were never transmitted. Those are exactly the
#: ones that would pin tile columns 7 and 4 individually. Columns 4–7 are
#: therefore constrained only as a *set*, by `06-halves`. The capture is
#: consequently asserted as a *prefix* of this, which means a recapture to
#: completion needs no edit here: the prefix simply gets longer.
#: See `docs/CAPTURE_RESULTS.md` for the full statement of what is left open.
EXPECTED_WALK = tuple(position for position, _ in walk_from_video(TILEWALK_VIDEO))

#: Frames one walk position may occupy.
#:
#: The video holds each position for 2.0 s and Ledset's player runs at ~9.2 fps
#: (median 109 ms between frame starts, consistent across all five Ledset
#: captures), so a full position is 18.4 frames; the capture in fact shows 18
#: or 19. The ±3 band absorbs the frame that straddles a position boundary plus
#: a ~10 % frame-rate excursion, and stays far tighter than the failures it has
#: to catch: a mapping that splits one position into two runs yields ≤ 10
#: frames per run, and one that merges two adjacent positions yields ≥ 36.
FRAMES_PER_POSITION = range(16, 22)


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


class TileWalkVideo(unittest.TestCase):
    """The ground-truth asset itself, so a swapped or regenerated file is loud.

    `EXPECTED_WALK` is derived from this video rather than typed, which removes
    the hand-retyping path but not the risk that the *file* changes. These
    assertions pin the asset's shape, so a swapped or truncated
    `07-tilewalk.avi` fails here rather than silently shortening the oracle.

    That risk is now the only one: the generator that wrote this file
    (`tools/New-PatternAvi.ps1`) was deleted on 2026-08-13 along with the
    retired 64 × 40 pattern set, so the asset can no longer be regenerated at a
    different geometry. It is evidence, and these assertions are what say so.
    """

    def test_video_header(self):
        video = read_video(TILEWALK_VIDEO)
        self.assertEqual((video.width, video.height), (RIG.width_px, RIG.height_px))
        self.assertEqual(len(video.frames), 240)
        # biHeight is -40. Reading it as bottom-up mirrors every frame
        # vertically, which maps tile row r to 4-r and yields a wrong but
        # entirely plausible-looking walk.
        self.assertTrue(video.top_down, "biHeight is negative: the video is top-down")

    def test_video_walk_is_eleven_positions(self):
        runs = walk_from_video(TILEWALK_VIDEO)
        self.assertEqual(len(runs), 11, "the tile-walk video must hold all 11 positions")
        for position, frames in runs:
            self.assertEqual(frames, 20, f"position {position} is not 2.0 s at 10 fps")
        self.assertEqual(len(set(EXPECTED_WALK)), 11, "the walk must visit 11 distinct tiles")
        # Deliberately *not* re-asserting the 11 positions as a literal here.
        # That would put back the hand-typed constant this file exists to
        # remove, and it would be checkable only against `tilewalk_timing.md`,
        # which is generated from the same list that renders the video. The
        # real guard against a swapped asset is `captures/07-tilewalk.pcapng`:
        # it is Ledset's own bytes, it cannot be regenerated without hardware,
        # and `ImageIn` below asserts the video's first 8 positions against it.


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
        """The one capture that resolves individual tiles rather than a set.

        `07-tilewalk.avi` lights one tile at a time. Decoding Ledset's own
        frames back through our mapping must reproduce the order the video
        itself walks — read out of the file by `walk_from_video`, not typed —
        which is what makes this the only test in the suite that can kill a
        permutation of the tile grid: sending a tile column to the wrong port,
        or reversing tile rows within a port, changes the decoded sequence and
        fails here.

        What it does **not** constrain, and must not be read as constraining:

        * **The 8×8 intra-tile scan table.** Every lit tile here is uniformly
          white, so the scan table is invisible to this capture — row-reverse,
          column-reverse and serpentine all decode identically. That table
          rests on the decompiled `InitFloor` alone; see `floors.py`.
        * **Tile columns 4–7 individually.** The capture is truncated before
          the walk reaches them; see `EXPECTED_WALK`. `06-halves` pins them
          only as a set.
        * **Controller placement.** `tile_col -> (controller, port)` is one
          `divmod`, and above 8 tile columns the same line decides the
          controller — but "same mechanism" is not "same evidence". Measured:
          swapping ports 0↔1 on every controller *except* controller 0 changes
          controller placement above tile column 3 and leaves this test green,
          because the only columns this capture resolves individually are 0–3,
          all on controller 0. Controller ordering is unproven and is closed by
          hardware, not here.
        """
        tile_px = RIG.type.tile_px
        # [position, frame count], in arrival order. Deliberately not a set:
        # the *sequence* is the assertion, so a permutation that visits the
        # right tiles in the wrong order must have nowhere to hide.
        runs: list[list] = []
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
            position = (xs.pop(), ys.pop())
            if runs and runs[-1][0] == position:
                runs[-1][1] += 1
            else:
                runs.append([position, 1])

        self.assertGreaterEqual(whole, 100, "most frames must show a fully lit tile")
        self.assertLessEqual(torn, 2, "Ledset's documented torn frames, and no more")

        captured = tuple(position for position, _ in runs)
        # The capture stops part-way through the video, so it can only ever be
        # a *prefix* of the video's walk. A floor for how long that prefix must
        # be is what keeps this an assertion rather than a formality: without
        # it, a mutation that collapsed the walk to a single run would pass.
        # Today's capture yields 8; a recapture to completion yields 11 and
        # needs no edit here.
        self.assertGreaterEqual(len(captured), 8, "the capture resolves 8 positions")
        self.assertLessEqual(len(captured), len(EXPECTED_WALK))
        self.assertEqual(
            captured,
            EXPECTED_WALK[: len(captured)],
            "decoded walk is not a prefix of the walk in test-patterns/07-tilewalk.avi",
        )

        for index, (position, frames) in enumerate(runs[:-1], start=1):
            self.assertIn(
                frames,
                FRAMES_PER_POSITION,
                f"walk position {index} {position} held for {frames} frames",
            )
        # The last run is short only because the capture ends mid-position —
        # today, 7 frames into position 8 `(0,4)`. On a complete capture the
        # walk runs out at the same time the video does and the last run is
        # full-length, so both are accepted.
        self.assertGreaterEqual(runs[-1][1], 1)
        if len(captured) < len(EXPECTED_WALK):
            self.assertLess(
                runs[-1][1],
                min(FRAMES_PER_POSITION),
                "the capture is documented as truncated mid-position",
            )
        else:
            self.assertIn(runs[-1][1], FRAMES_PER_POSITION)


if __name__ == "__main__":
    unittest.main()
