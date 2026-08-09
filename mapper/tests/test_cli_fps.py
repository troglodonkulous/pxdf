"""How `play` picks a send rate.

This is the one piece of Phase 4 that was decided by looking at the floor rather
than by reasoning, so it is also the piece most likely to be "tidied" back into
something reasonable-looking and wrong. The rule is:

* the clip's own authored rate wins by default -- sending a 25 fps clip at some
  other rate plays it at the wrong speed, and no byte comparison in this project
  can see that, because every frame is individually correct;
* capped at `MAX_ADOPTED_FPS`, because the floor renders 60 fps faithfully and
  still judders on fast motion at it, for no gain over 30;
* except that an explicit `--fps` wins over both and is never capped. The cap
  exists to protect the automatic path, not to overrule the operator;
* and `DEFAULT_FPS` covers only the case where the file carries no rate at all.

Measured at the floor 2026-08-08: the rate ceiling probe at 10/15/24/30/60 fps
found no dropped frames at any rate, which is what made adopting viable in the
first place.
"""

from __future__ import annotations

import contextlib
import io
import unittest
from types import SimpleNamespace

from mapper.cli import _resolve_fps
from mapper.sender import DEFAULT_FPS, MAX_ADOPTED_FPS


def resolve(clip_fps: float | None, fps: int | None = None) -> tuple[int, str]:
    """`_resolve_fps` plus whatever it said on stderr."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        rate = _resolve_fps(SimpleNamespace(fps=fps), clip_fps)
    return rate, err.getvalue()


class ResolveFpsTest(unittest.TestCase):
    def test_a_clips_own_rate_is_adopted(self):
        """The A/B this replaced sent a 25 fps clip at 10 -- 0.40x speed."""
        rate, err = resolve(25.0)
        self.assertEqual(rate, 25)
        self.assertEqual(err, "")

    def test_a_rate_above_the_cap_is_capped_and_says_so(self):
        rate, err = resolve(60.0)
        self.assertEqual(rate, MAX_ADOPTED_FPS)
        self.assertIn("60", err)
        self.assertIn(str(MAX_ADOPTED_FPS), err)

    def test_an_explicit_rate_wins_over_the_clips_own(self):
        self.assertEqual(resolve(25.0, fps=10)[0], 10)

    def test_an_explicit_rate_is_never_capped(self):
        """The operator asked for 60 by name. The cap is not a veto."""
        rate, err = resolve(60.0, fps=60)
        self.assertEqual(rate, 60)
        self.assertEqual(err, "")

    def test_an_explicit_rate_wins_even_with_no_clip_rate(self):
        self.assertEqual(resolve(None, fps=15)[0], 15)

    def test_a_file_with_no_rate_falls_back_to_the_default(self):
        rate, err = resolve(None)
        self.assertEqual(rate, DEFAULT_FPS)
        self.assertEqual(err, "")

    def test_a_fractional_rate_rounds_and_says_so(self):
        """30000/1001. `run` takes a whole number of frames per second.

        `make_clip` normalises the rate on the way through, so a fractional one
        only ever reaches here from a file this repo did not write.
        """
        rate, err = resolve(30000 / 1001)
        self.assertEqual(rate, 30)
        self.assertIn("29.970", err)

    def test_a_fractional_rate_above_the_cap_rounds_then_caps(self):
        rate, err = resolve(60000 / 1001)
        self.assertEqual(rate, MAX_ADOPTED_FPS)
        self.assertIn("59.940", err)
        self.assertIn(str(MAX_ADOPTED_FPS), err)


if __name__ == "__main__":
    unittest.main()
