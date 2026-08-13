#!/usr/bin/env python3
"""Turn arbitrary media into a floor-resolution clip `mapper.avi.read_video` accepts.

This is a pre-step, not part of `mapper`: `mapper` itself has zero third-party
dependencies, and stays that way. ffmpeg is a prerequisite of *this script
only* — it does the decoding, scaling and re-encoding; `mapper` never shells
out to anything.

The output is uncompressed 24-bit `BI_RGB` in an AVI container, fitted to the
exact pixel geometry of the target floor (`FloorConfig`, so this can never
drift from the mapper's own idea of the geometry), at a fixed frame rate. That
is exactly the shape `mapper.avi.read_video` requires and refuses to guess at.

**`--scaler` matters more than it looks.** A pattern generator authoring *at*
floor resolution wants `flags=neighbor`, because it must keep hard 8-pixel tile
boundaries that any smooth filter would blur — `tools/oracle/make-gradient-avi.ps1`
writes at floor resolution for exactly that reason.
That reasoning does not survive contact with real footage: a 1080p source is
24x the floor's width and a 4K source is 48x, and nearest-neighbour at 48:1
keeps one pixel out of every 48x48 block and throws away the other 2303. On
anything with motion that reads as crawling noise. `area` -- box averaging over
the whole block -- is the correct filter for a downscale that large, and is the
default here. Choose `neighbor` only for a source already at floor resolution.

**`--fit` was a content decision, and it has been made.** The floor is 2:1 and
most footage is 16:9. `letterbox` preserves the whole frame and leaves exactly 9
of the floor's 80 columns permanently black -- measured, columns 0-3 and 75-79;
`cover` fills the floor and crops 5 rows of the content. Roughly 11% either way,
of the floor or of the picture. Both were played on the floor on 2026-08-08 and
`cover` won outright: on a surface people stand on, dead columns down the long
edges read as the floor being broken, while the crop is not noticed at all.
`cover` is the default. `letterbox` stays for full-bleed content whose edges
carry meaning.
"""

import argparse
import shutil
import subprocess
import sys

from mapper.avi import read_video
from mapper.floors import FLOOR_TYPES, FloorConfig
from mapper.sender import DEFAULT_FPS


#: Nearest-neighbour is right only for a source already at floor resolution;
#: `area` is right for the 24x-48x downscales real footage arrives at. The rest
#: are here so the choice can be compared rather than argued about.
SCALERS = ("area", "neighbor", "bilinear", "bicubic", "lanczos")

FITS = ("letterbox", "cover")


def build_filter_chain(config: FloorConfig, scaler: str, fit: str) -> str:
    """The `-vf` chain: fit the source to the floor, exactly, one way or another."""
    w, h = config.width_px, config.height_px
    if fit == "cover":
        # Scale until the frame covers the floor in both axes, then take the
        # middle. Nothing is letterboxed; the overhang is cropped.
        return (
            f"scale={w}:{h}:flags={scaler}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h}"
        )
    # Scale until the frame fits inside the floor, then centre it on black.
    return (
        f"scale={w}:{h}:flags={scaler}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
    )


def build_ffmpeg_args(
    input_path: str,
    output_path: str,
    config: FloorConfig,
    fps: int,
    scaler: str = "area",
    fit: str = "cover",
) -> list[str]:
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(input_path),
        # No audio. `read_video` ignores an `01wb` stream rather than rejecting
        # it, so a muxed audio track would sit in the file undetected and make
        # the container something other than what this script promises.
        "-an",
        "-vf", build_filter_chain(config, scaler, fit),
        "-r", str(fps),
        "-c:v", "rawvideo", "-pix_fmt", "bgr24",
        str(output_path),
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="make_clip", description="Convert media to a floor-resolution AVI"
    )
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--type", required=True, choices=sorted(FLOOR_TYPES))
    parser.add_argument("--cols", required=True, type=int, help="tile columns")
    parser.add_argument("--rows", required=True, type=int, help="tile rows")
    # Shared with the sender rather than restated, so a clip cannot be written
    # at one rate and played back at another by default. `play` does not read a
    # clip's own rate -- `avi.py` skips `avih` and `strh` -- so converting at a
    # rate `play` is not told about plays the whole clip at the wrong speed,
    # and nothing in the wire bytes would show it.
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    parser.add_argument(
        "--scaler",
        default="area",
        choices=SCALERS,
        help="ffmpeg scale filter. `area` for real footage (a 24x-48x downscale); "
        "`neighbor` only for a source already at floor resolution",
    )
    parser.add_argument(
        "--fit",
        default="cover",
        choices=FITS,
        help="`cover` fills the floor and crops the overhang; `letterbox` keeps "
        "the whole frame and leaves 9 of the floor's 80 columns black",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if shutil.which("ffmpeg") is None:
        # Named as a prerequisite of this script, not of mapper -- mapper's
        # own AVI reader (mapper/avi.py) is stdlib-only and never touches ffmpeg.
        print(
            "error: ffmpeg not found on PATH. ffmpeg is a prerequisite of "
            "tools/make_clip.py (mapper itself has no third-party dependencies).",
            file=sys.stderr,
        )
        return 2

    config = FloorConfig.of(args.type, args.cols, args.rows)
    ffmpeg_args = build_ffmpeg_args(
        args.input, args.output, config, args.fps, args.scaler, args.fit
    )
    try:
        subprocess.run(ffmpeg_args, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"error: ffmpeg exited {exc.returncode}", file=sys.stderr)
        return 2

    # This script's one promise is an output `mapper` accepts. Check it here
    # rather than leaving it to a test that skips wherever ffmpeg is absent --
    # a clip that fails at the floor is the expensive place to find out.
    try:
        video = read_video(args.output)
    except ValueError as exc:
        print(f"error: ffmpeg wrote something mapper cannot read: {exc}", file=sys.stderr)
        return 2
    if (video.width, video.height) != (config.width_px, config.height_px):
        print(
            f"error: output is {video.width}x{video.height}, expected "
            f"{config.width_px}x{config.height_px}",
            file=sys.stderr,
        )
        return 2

    print(f"wrote {args.output}: {video.width}x{video.height}, {len(video.frames)} frames")
    return 0


if __name__ == "__main__":
    sys.exit(main())
