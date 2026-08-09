#!/usr/bin/env python3
"""Turn arbitrary media into a floor-resolution clip `mapper.avi.read_video` accepts.

This is a pre-step, not part of `mapper`: `mapper` itself has zero third-party
dependencies, and stays that way. ffmpeg is a prerequisite of *this script
only* — it does the decoding, scaling and re-encoding; `mapper` never shells
out to anything.

The output is uncompressed 24-bit `BI_RGB` in an AVI container, scaled and
letterboxed to the exact pixel geometry of the target floor (`FloorConfig`,
so this can never drift from the mapper's own idea of the geometry), at a
fixed frame rate. That is exactly the shape `mapper.avi.read_video` requires
and refuses to guess at.

Scaling uses `flags=neighbor` (nearest-neighbour), not the default bilinear/
bicubic resampling. At 80x40 the floor's tiles are 8 pixels wide, and soft
scaling bleeds light across tile boundaries -- the same reason
`tools/make_test_patterns.py` renders its own patterns with
`scale=flags=neighbor` rather than trusting a smooth resize.
"""

import argparse
import shutil
import subprocess
import sys

from mapper.floors import FLOOR_TYPES, FloorConfig


def build_ffmpeg_args(input_path: str, output_path: str, config: FloorConfig, fps: int) -> list[str]:
    w, h = config.width_px, config.height_px
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(input_path),
        "-vf",
        f"scale={w}:{h}:flags=neighbor:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
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
    parser.add_argument("--fps", type=int, default=10)
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
    ffmpeg_args = build_ffmpeg_args(args.input, args.output, config, args.fps)
    subprocess.run(ffmpeg_args, check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
