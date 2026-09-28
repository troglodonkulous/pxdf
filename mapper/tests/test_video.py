"""The AVI -> framebuffer seam that `play` is built on.

`sender.run` has always taken a `frame_source`; `avi.read_video` has always
decoded the test clips. `video.framebuffers` is the only new code between them,
so it carries the whole risk of the cutover off Ledset.

Grading it costs nothing. All 60 frames of
`tools/oracle/media/09-gradient24-8x8_4P-10x5.avi` are byte-identical to each other,
and frame 0 is pixel-for-pixel equal to `patterns.gradient24` at that geometry.
`gradient24` is per-pixel-unique, so this single equality pins the converter
completely: a vertical flip, a BGR/RGB swap, a stride miscount or an off-by-one
row all break it. A solid-colour clip would have caught none of them.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from mapper.avi import Video, read_video
from mapper.floors import FloorConfig
from mapper.patterns import gradient24
from mapper.sender import dry_run
from mapper.video import framebuffers

ROOT = Path(__file__).resolve().parents[2]
VIDEOS = ROOT / "test-patterns"

#: The rig, floor-confirmed at gate 4. Orientation is `identity` permanently.
RIG = FloorConfig.of("8x8_4P", 10, 5)

#: 80x40, 60 frames, top-down. Lives under tools/oracle/media/, not
#: test-patterns/ — it is also the gate-2 oracle capture's source clip, and
#: that is the only copy ever committed. A same-named file under
#: test-patterns/ is a hand-copy some worktree made locally; it is untracked
#: and this test must not depend on it existing.
GRADIENT = ROOT / "tools" / "oracle" / "media" / "09-gradient24-8x8_4P-10x5.avi"

#: 64x40 — the 8x5 `8x8_8P` rig the 2026-08-06 captures were taken on, and so
#: the wrong asset for `RIG`.
TILEWALK = VIDEOS / "07-tilewalk.avi"


class ConverterTest(unittest.TestCase):
    def test_gradient_clip_decodes_to_the_pattern(self):
        frames = framebuffers(read_video(GRADIENT), RIG)
        self.assertEqual(len(frames), 60)
        expected = bytes(gradient24(RIG))
        self.assertEqual(len(expected), RIG.pixel_count * 3)
        for index, frame in enumerate(frames):
            with self.subTest(frame=index):
                self.assertEqual(frame, expected)

    def test_wrong_geometry_names_both_shapes(self):
        with self.assertRaises(ValueError) as caught:
            framebuffers(read_video(TILEWALK), RIG)
        message = str(caught.exception)
        self.assertIn("64x40", message)
        self.assertIn("80x40", message)

    def test_bottom_up_rows_are_flipped(self):
        """`biHeight`'s sign is the classic silent DIB bug.

        Assuming the default of bottom-up mirrors every frame vertically and
        still decodes to something plausible — `avi.py`'s own docstring says so.
        Row `y` here is `(B, G, R) = (y, 100 + y, 200 + y)`, so the first pixel
        of the framebuffer names both the row it came from and the channel
        order it was read in.
        """
        tiny = FloorConfig.of("8x8_4P", 1, 1)
        rows = [bytes((y, 100 + y, 200 + y)) * 8 for y in range(8)]
        raw = b"".join(rows)

        top_down = framebuffers(Video(8, 8, True, [raw]), tiny)[0]
        self.assertEqual(top_down[:3], bytes((200, 100, 0)))

        bottom_up = framebuffers(Video(8, 8, False, [raw]), tiny)[0]
        self.assertEqual(bottom_up[:3], bytes((207, 107, 7)))


class AcceptanceTest(unittest.TestCase):
    """`play` on the gradient clip must be indistinguishable from `send`.

    The CLI-level form of this is the plan's free acceptance check; asserting it
    in-process keeps it in the suite without a subprocess. Its real weight is
    that `captures/oracle/acceptance-gradient24-identity.pcapng` — a real gate-2
    capture off the floor — is therefore already a valid oracle for `play`, with
    no new harness vocabulary and no change anywhere in `tools/oracle/`.
    """

    def test_play_frame_source_matches_the_pattern_source(self):
        frames = framebuffers(read_video(GRADIENT), RIG)
        played = list(dry_run(RIG, lambda n: frames[n % len(frames)]))
        pattern = gradient24(RIG)
        sent = list(dry_run(RIG, lambda n: pattern))
        self.assertEqual(played, sent)


if __name__ == "__main__":
    unittest.main()
