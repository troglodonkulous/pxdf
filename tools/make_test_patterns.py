#!/usr/bin/env python3
"""Generate test patterns for the floor packet-capture session.

The floor is a grid of 8x8-pixel tiles. Every pattern is rendered at the
floor's exact logical resolution (tiles * 8) so that no scaling happens
anywhere in the chain -- a scaled frame would blur tile boundaries and ruin
the tile-walk test, which depends on exactly one tile being lit.

Outputs PNGs for the static patterns and an MP4 plus a timing sheet for the
tile walk.
"""

import argparse
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

TILE_PX = 8  # pixels per tile side, fixed by the hardware

# Uncompressed RGB in an AVI container. Deliberately not H.264: lossless x264
# lands in "High 4:4:4 Predictive" profile, which QuickTime's decoder and most
# consumer players reject outright. Uncompressed costs nothing at 64x40 (a few
# MB) and the vendor's own content library is almost entirely .avi, so this is
# the format its bundled codec pack is most certain to handle.
#
# Why lossless at all: the tile-walk test depends on exactly one 8x8 tile being
# lit with hard edges. Any chroma subsampling or lossy compression bleeds light
# into neighbouring tiles and makes the capture ambiguous.
ENCODE_ARGS = ["-c:v", "rawvideo", "-pix_fmt", "bgr24"]
VIDEO_EXT = "avi"


def tile_walk_positions(cols, rows):
    """Tile coordinates to visit, in order.

    Chosen to disambiguate the candidate mappings: a run along the top row
    and a run down the left column separate row-major from column-major
    ordering, the far corners bound the address space, and the centre
    catches off-by-one errors in the middle of a port's range.
    """
    seq = []

    for c in range(min(4, cols)):  # top row, left to right
        seq.append((c, 0))
    for r in range(1, min(5, rows)):  # left column, downward
        seq.append((0, r))

    for pos in [(cols - 1, 0), (cols - 1, rows - 1), (0, rows - 1)]:  # corners
        if pos not in seq:
            seq.append(pos)

    centre = (cols // 2, rows // 2)
    if centre not in seq:
        seq.append(centre)

    return seq


def solid(path, w, h, colour):
    Image.new("RGB", (w, h), colour).save(path)


def halves(path, w, h):
    img = Image.new("RGB", (w, h), (0, 0, 0))
    ImageDraw.Draw(img).rectangle([0, 0, w // 2 - 1, h - 1], fill=(255, 255, 255))
    img.save(path)


def lit_tile(w, h, col, row):
    img = Image.new("RGB", (w, h), (0, 0, 0))
    x, y = col * TILE_PX, row * TILE_PX
    ImageDraw.Draw(img).rectangle(
        [x, y, x + TILE_PX - 1, y + TILE_PX - 1], fill=(255, 255, 255)
    )
    return img


def build_tile_walk(outdir, cols, rows, hold_s, fps):
    w, h = cols * TILE_PX, rows * TILE_PX
    positions = tile_walk_positions(cols, rows)

    frames = outdir / "tilewalk_frames"
    frames.mkdir(exist_ok=True)
    for f in frames.glob("*.png"):
        f.unlink()

    # A black lead-in gives a clean, unambiguous "nothing lit" baseline at the
    # start of the capture, so the first transition is easy to spot.
    n = 0
    for _ in range(int(hold_s * fps)):
        Image.new("RGB", (w, h), (0, 0, 0)).save(frames / f"{n:05d}.png")
        n += 1

    sheet = ["# Tile-walk timing sheet", ""]
    sheet.append(f"Floor: {cols} x {rows} tiles ({w} x {h} px), {hold_s}s per position.")
    sheet.append("")
    sheet.append("Times are from the START OF THE VIDEO, not the start of the capture.")
    sheet.append("Note when playback begins, then add these offsets.")
    sheet.append("")
    sheet.append("| # | tile (col,row) | starts at | ends at |")
    sheet.append("|---|---|---|---|")
    sheet.append(f"| 0 | (black lead-in) | 0.0s | {hold_s:.1f}s |")

    for i, (col, row) in enumerate(positions):
        start = (i + 1) * hold_s
        img = lit_tile(w, h, col, row)
        for _ in range(int(hold_s * fps)):
            img.save(frames / f"{n:05d}.png")
            n += 1
        sheet.append(
            f"| {i + 1} | ({col},{row}) | {start:.1f}s | {start + hold_s:.1f}s |"
        )

    (outdir / "tilewalk_timing.md").write_text("\n".join(sheet) + "\n")

    # GIF fallback: palette-based, so still lossless for these two-colour
    # frames, and playable essentially everywhere if the AVI is rejected.
    gif_frames = sorted(frames.glob("*.png"))
    first = Image.open(gif_frames[0])
    first.save(
        outdir / "07-tilewalk.gif",
        save_all=True,
        append_images=[Image.open(f) for f in gif_frames[1:]],
        duration=int(1000 / fps),
        loop=0,
    )

    mp4 = outdir / f"07-tilewalk.{VIDEO_EXT}"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(fps),
            "-i", str(frames / "%05d.png"),
            *ENCODE_ARGS,
            str(mp4),
        ],
        check=True,
    )
    return positions, mp4


def build_sweep(outdir, cols, rows, fps, seconds):
    """A single tile-wide white column travelling left to right."""
    w, h = cols * TILE_PX, rows * TILE_PX
    frames = outdir / "sweep_frames"
    frames.mkdir(exist_ok=True)
    for f in frames.glob("*.png"):
        f.unlink()

    total = int(fps * seconds)
    for i in range(total):
        img = Image.new("RGB", (w, h), (0, 0, 0))
        x = int((i / total) * w)
        ImageDraw.Draw(img).rectangle(
            [x, 0, min(x + TILE_PX - 1, w - 1), h - 1], fill=(255, 255, 255)
        )
        img.save(frames / f"{i:05d}.png")

    mp4 = outdir / f"08-sweep.{VIDEO_EXT}"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(fps),
            "-i", str(frames / "%05d.png"),
            "-vf", "scale=flags=neighbor",
            "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "0",
            str(mp4),
        ],
        check=True,
    )
    return mp4


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cols", type=int, default=8, help="tiles across")
    ap.add_argument("--rows", type=int, default=5, help="tiles down")
    ap.add_argument("--hold", type=float, default=2.0, help="seconds per tile position")
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--out", default="test-patterns")
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    w, h = args.cols * TILE_PX, args.rows * TILE_PX

    solid(outdir / "01-black.png", w, h, (0, 0, 0))
    solid(outdir / "02-white.png", w, h, (255, 255, 255))
    solid(outdir / "03-red.png", w, h, (255, 0, 0))
    solid(outdir / "04-green.png", w, h, (0, 255, 0))
    solid(outdir / "05-blue.png", w, h, (0, 0, 255))
    halves(outdir / "06-halves.png", w, h)

    positions, walk = build_tile_walk(outdir, args.cols, args.rows, args.hold, args.fps)
    sweep = build_sweep(outdir, args.cols, args.rows, args.fps, 10)

    print(f"Floor: {args.cols} x {args.rows} tiles = {w} x {h} px")
    print(f"Output: {outdir.resolve()}")
    print(f"Tile walk: {len(positions)} positions, "
          f"{(len(positions) + 1) * args.hold:.0f}s total -> {walk.name}")
    print(f"Sweep: {sweep.name}")
    print("Timing sheet: tilewalk_timing.md")


if __name__ == "__main__":
    sys.exit(main())
