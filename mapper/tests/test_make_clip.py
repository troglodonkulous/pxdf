"""Round-trips `tools/make_clip.py` through `mapper.avi.read_video`.

Converts an existing test-pattern clip to a *different* target geometry than
it was recorded at, so a pass actually proves the scale/pad step ran rather
than the source simply passing through untouched.

Skipped when ffmpeg is absent: ffmpeg is a prerequisite of
`tools/make_clip.py` only, never of `mapper`.
"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from mapper.avi import read_video
from mapper.floors import FloorConfig
from tools.make_clip import build_ffmpeg_args, main

ROOT = Path(__file__).resolve().parents[2]
VIDEOS = ROOT / "test-patterns"

#: Source is 64x40 (8x5 tiles of 8x8_8P); target is a different geometry,
#: 80x40 (10x5 tiles of 8x8_4P), so a pass proves the scale/pad actually ran.
SOURCE = VIDEOS / "07-tilewalk.avi"


class FfmpegArgsTest(unittest.TestCase):
    """The arg list, pinned without ffmpeg.

    The round-trip test below skips wherever ffmpeg is absent, which would
    leave the only thing this script actually does — the ffmpeg invocation —
    asserted by nothing at all on those machines.
    """

    def test_encodes_uncompressed_24bit_at_the_floor_geometry(self):
        config = FloorConfig.of("8x8_4P", 10, 5)
        args = build_ffmpeg_args("in.mp4", "out.avi", config, 10)

        self.assertEqual(args[0], "ffmpeg")
        self.assertEqual(args[-1], "out.avi")
        # Uncompressed 24-bit BI_RGB is the only thing `read_video` accepts.
        self.assertIn("rawvideo", args)
        self.assertIn("bgr24", args)
        self.assertIn("-an", args)

        chain = args[args.index("-vf") + 1]
        self.assertIn("scale=80:40:flags=neighbor", chain)
        self.assertIn("force_original_aspect_ratio=decrease", chain)
        self.assertIn("pad=80:40", chain)
        self.assertEqual(args[args.index("-r") + 1], "10")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is a prerequisite of tools/make_clip.py only")
class MakeClipRoundTripTests(unittest.TestCase):
    def test_scales_to_target_floor_geometry(self) -> None:
        config = FloorConfig.of("8x8_4P", 10, 5)

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "clip.avi"
            rc = main(
                [
                    str(SOURCE),
                    str(output),
                    "--type", "8x8_4P",
                    "--cols", "10",
                    "--rows", "5",
                ]
            )
            self.assertEqual(rc, 0)

            video = read_video(output)
            self.assertEqual((video.width, video.height), (config.width_px, config.height_px))
            self.assertTrue(video.frames)


if __name__ == "__main__":
    unittest.main()
