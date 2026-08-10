"""`mapper.patterns` — framebuffer sources and the `resolve` spec grammar.

`resolve` exists so the CLI's `--pattern` can grow discriminators (a level,
an arbitrary solid, a band ladder) without ever touching `PATTERNS` itself --
`fixtures.py`, `tools/oracle/config_list.py` and stored JSON configs resolve
patterns by the exact names in that dict, so the bar here is: every existing
name keeps behaving exactly as before, and the digest this project already
uses as its cutover acceptance bar (see `CLAUDE.md`) does not move.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from mapper.cli import main as cli_main
from mapper.floors import FloorConfig
from mapper.patterns import PATTERNS, STEP_LEVELS, resolve, solid, steps, tile

RIG = FloorConfig.of("8x8_4P", 10, 5)

#: `6x6_4P` tiles are 6 px, so a single-tile floor is 6 px tall -- not a
#: multiple of 8, which is exactly the case `steps` must not crash on.
NOT_A_MULTIPLE_OF_EIGHT = FloorConfig.of("6x6_4P", 1, 1)

DIGEST_GRADIENT24_10x5 = (
    "10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057"
)

DATA_DIR = Path(__file__).parent / "data"
IDENTITY_CALIBRATION = DATA_DIR / "identity-calibration.json"

ROOT = Path(__file__).resolve().parents[2]
GRADIENT24_CLIP = ROOT / "test-patterns" / "09-gradient24-8x8_4P-10x5.avi"


def _pixel(framebuffer: bytes | bytearray, config: FloorConfig, x: int, y: int) -> tuple[int, int, int]:
    i = (y * config.width_px + x) * 3
    return tuple(framebuffer[i : i + 3])


def _run_cli(argv: list[str]) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli_main(argv)
    return code, out.getvalue()


def _sha_line(stdout: str) -> str:
    (line,) = [l for l in stdout.splitlines() if l.startswith("frame 0 sha256:")]
    return line.split()[-1]


class ResolvePlainNames(unittest.TestCase):
    """Every name already in `PATTERNS` must resolve to the identical callable behaviour."""

    def test_every_plain_name_matches_patterns_dict(self):
        for name, fn in PATTERNS.items():
            with self.subTest(name=name):
                self.assertEqual(resolve(name)(RIG), fn(RIG))


class ResolveLevel(unittest.TestCase):
    def test_level_is_uniform_grey_of_the_right_length(self):
        frame = resolve("level:128")(RIG)
        self.assertEqual(len(frame), RIG.pixel_count * 3)
        self.assertTrue(all(b == 128 for b in frame))

    def test_level_0_and_255_are_the_endpoints(self):
        self.assertTrue(all(b == 0 for b in resolve("level:0")(RIG)))
        self.assertTrue(all(b == 255 for b in resolve("level:255")(RIG)))

    def test_bad_levels_raise(self):
        for spec in ("level:300", "level:-1", "level:abc"):
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError):
                    resolve(spec)


class ResolveSolid(unittest.TestCase):
    def test_solid_matches_the_existing_red_pattern(self):
        self.assertEqual(resolve("solid:255,0,0")(RIG), PATTERNS["red"](RIG))

    def test_solid_matches_the_solid_helper_directly(self):
        self.assertEqual(resolve("solid:10,20,30")(RIG), solid(RIG, 10, 20, 30))

    def test_bad_solid_specs_raise(self):
        for spec in ("solid:1,2", "solid:1,2,3,4", "solid:1,2,x", "solid:300,0,0"):
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError):
                    resolve(spec)


class ResolveSteps(unittest.TestCase):
    def test_band_count_and_boundaries_at_80x40(self):
        """40 px / 8 bands = 5 rows each -- exact boundaries, per the spec."""
        frame = steps(RIG)
        distinct = set()
        for y in range(RIG.height_px):
            distinct.add(_pixel(frame, RIG, 0, y))
        self.assertEqual(len(distinct), len(STEP_LEVELS))

        for band, level in enumerate(STEP_LEVELS):
            top = band * 5
            bottom = top + 4
            self.assertEqual(_pixel(frame, RIG, 0, top), (level, level, level))
            self.assertEqual(_pixel(frame, RIG, 0, bottom), (level, level, level))
        # And the row just past each boundary has already moved to the next band.
        for band in range(len(STEP_LEVELS) - 1):
            boundary = band * 5 + 5
            self.assertEqual(
                _pixel(frame, RIG, 0, boundary), (STEP_LEVELS[band + 1],) * 3
            )

    def test_full_width_is_banded_too(self):
        frame = steps(RIG)
        row0 = frame[: RIG.width_px * 3]
        self.assertTrue(all(v == STEP_LEVELS[0] for v in row0))

    def test_resolve_steps_matches_the_function(self):
        self.assertEqual(resolve("steps")(RIG), steps(RIG))

    def test_does_not_crash_on_a_height_not_divisible_by_eight(self):
        frame = steps(NOT_A_MULTIPLE_OF_EIGHT)
        self.assertEqual(
            len(frame), NOT_A_MULTIPLE_OF_EIGHT.pixel_count * 3
        )
        # Every value on the frame is one of the eight legal levels -- no stray
        # byte and no out-of-range STEP_LEVELS index.
        self.assertTrue(set(frame) <= set(STEP_LEVELS))


class ResolveTile(unittest.TestCase):
    def test_tile_spec_matches_the_tile_function(self):
        self.assertEqual(resolve("tile:3,1")(RIG), tile(RIG, 3, 1))

    def test_bad_tile_specs_raise(self):
        for spec in ("tile:1", "tile:1,2,3", "tile:a,b"):
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError):
                    resolve(spec)

    def test_negative_tile_index_raises_instead_of_wrapping(self):
        """`tile()`'s slice assignment wraps a negative index instead of raising.

        Without a bounds check that silently lights a pixel in the middle of
        the floor and returns a full-length, otherwise-legal-looking buffer --
        the exact "looks right, isn't" failure class `CLAUDE.md` is about.
        """
        with self.assertRaises(ValueError) as ctx:
            resolve("tile:-1,-1")(RIG)
        self.assertIn("tile:-1,-1", str(ctx.exception))

    def test_tile_index_beyond_the_grid_raises_instead_of_building_a_wrong_length_buffer(self):
        """A too-large index would otherwise build a wrong-length buffer here,

        only to be caught later inside `frame.pack_send_buffer` -- outside
        every caller's `except ValueError` -- as an unhandled traceback.
        """
        with self.assertRaises(ValueError) as ctx:
            resolve("tile:999,999")(RIG)
        self.assertIn("tile:999,999", str(ctx.exception))

    def test_tile_bounds_are_checked_against_the_actual_config(self):
        """`tile:9,4` is the last legal tile on the 10x5 rig but out of range on a 1x1 floor."""
        self.assertEqual(resolve("tile:9,4")(RIG), tile(RIG, 9, 4))
        tiny = FloorConfig.of("8x8_4P", 1, 1)
        with self.assertRaises(ValueError):
            resolve("tile:9,4")(tiny)


class ResolveBadSpecs(unittest.TestCase):
    def test_unknown_name_raises_with_the_spec_and_legal_forms_named(self):
        with self.assertRaises(ValueError) as ctx:
            resolve("nosuchpattern")
        message = str(ctx.exception)
        self.assertIn("nosuchpattern", message)
        self.assertIn("level:N", message)
        self.assertIn("solid:R,G,B", message)
        self.assertIn("steps", message)
        self.assertIn("tile:col,row", message)


class DigestGuard(unittest.TestCase):
    """The cutover's acceptance digest (see `CLAUDE.md`) must not move.

    A calibration whose only region is gain (1.0, 1.0, 1.0) is a no-op on
    every byte, so it must reproduce the same digest as no calibration at
    all; any gain below 1.0 must change at least one byte and therefore the
    digest. This is the regression test for the ordering bug this project has
    already shipped twice elsewhere: a dry run grading something other than
    what the socket would actually carry.
    """

    def test_gradient24_dry_run_digest_is_unchanged(self):
        code, out = _run_cli(
            [
                "send",
                "--type",
                "8x8_4P",
                "--cols",
                "10",
                "--rows",
                "5",
                "--pattern",
                "gradient24",
                "--dry-run",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(_sha_line(out), DIGEST_GRADIENT24_10x5)

    def test_identity_calibration_does_not_change_the_digest(self):
        if not IDENTITY_CALIBRATION.exists():
            self.skipTest(
                f"{IDENTITY_CALIBRATION} not present yet -- written by the "
                "sibling calibration package"
            )
        code, out = _run_cli(
            [
                "send",
                "--type",
                "8x8_4P",
                "--cols",
                "10",
                "--rows",
                "5",
                "--pattern",
                "gradient24",
                "--dry-run",
                "--calibration",
                str(IDENTITY_CALIBRATION),
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(_sha_line(out), DIGEST_GRADIENT24_10x5)

    def test_a_real_gain_changes_the_digest(self):
        payload = {
            "schema": "ddf-calibration/1",
            "regions": [
                {"x": 0, "y": 0, "w": 80, "h": 40, "gain": [0.5, 0.5, 0.5], "note": "test dimming"}
            ],
        }
        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            code, out = _run_cli(
                [
                    "send",
                    "--type",
                    "8x8_4P",
                    "--cols",
                    "10",
                    "--rows",
                    "5",
                    "--pattern",
                    "gradient24",
                    "--dry-run",
                    "--calibration",
                    path,
                ]
            )
        finally:
            os.unlink(path)
        self.assertEqual(code, 0)
        self.assertNotEqual(_sha_line(out), DIGEST_GRADIENT24_10x5)


class PlayDigestGuard(unittest.TestCase):
    """The `play` mirror of `DigestGuard`.

    `cmd_play` builds its calibration wrap independently of `cmd_send` --
    same shape, separate code -- so nothing in `DigestGuard` above would
    notice if a future edit moved the wrap in `cmd_play` to after its
    `if args.dry_run:` check instead of before it. This class is that check,
    run against the same acceptance clip and the same acceptance digest
    `CLAUDE.md` names for `play --pattern gradient24`.
    """

    def setUp(self):
        if not GRADIENT24_CLIP.exists():
            self.skipTest(f"{GRADIENT24_CLIP} not present")

    def test_play_dry_run_digest_matches_send(self):
        code, out = _run_cli(
            [
                "play",
                str(GRADIENT24_CLIP),
                "--type",
                "8x8_4P",
                "--cols",
                "10",
                "--rows",
                "5",
                "--dry-run",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(_sha_line(out), DIGEST_GRADIENT24_10x5)

    def test_identity_calibration_does_not_change_the_play_digest(self):
        if not IDENTITY_CALIBRATION.exists():
            self.skipTest(
                f"{IDENTITY_CALIBRATION} not present yet -- written by the "
                "sibling calibration package"
            )
        code, out = _run_cli(
            [
                "play",
                str(GRADIENT24_CLIP),
                "--type",
                "8x8_4P",
                "--cols",
                "10",
                "--rows",
                "5",
                "--dry-run",
                "--calibration",
                str(IDENTITY_CALIBRATION),
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(_sha_line(out), DIGEST_GRADIENT24_10x5)

    def test_a_real_gain_changes_the_play_digest(self):
        """The finding this class exists to close: if the calibration wrap in
        `cmd_play` ever moved to after the `--dry-run` branch, this would
        start failing -- the digest would stop reflecting the gain at all.
        """
        payload = {
            "schema": "ddf-calibration/1",
            "regions": [
                {"x": 0, "y": 0, "w": 80, "h": 40, "gain": [0.5, 0.5, 0.5], "note": "test dimming"}
            ],
        }
        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            code, out = _run_cli(
                [
                    "play",
                    str(GRADIENT24_CLIP),
                    "--type",
                    "8x8_4P",
                    "--cols",
                    "10",
                    "--rows",
                    "5",
                    "--dry-run",
                    "--calibration",
                    path,
                ]
            )
        finally:
            os.unlink(path)
        self.assertEqual(code, 0)
        self.assertNotEqual(_sha_line(out), DIGEST_GRADIENT24_10x5)


class CliBadPatternExitsClean(unittest.TestCase):
    """A bad --pattern is an operator error: exit 2, message, no traceback.

    Mirrors the treatment `cmd_play` already gives a wrong-geometry asset.
    """

    def test_send_with_a_bad_pattern_exits_2(self):
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(
                [
                    "send",
                    "--type",
                    "8x8_4P",
                    "--cols",
                    "10",
                    "--rows",
                    "5",
                    "--pattern",
                    "nosuchpattern",
                    "--dry-run",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("nosuchpattern", err.getvalue())

    def test_send_with_an_out_of_range_tile_spec_exits_2_not_a_traceback(self):
        """The bug the critic found: `tile:999,999` used to build a wrong-length
        buffer that only failed later inside `frame.pack_send_buffer`, outside
        this command's `except ValueError` -- an unhandled traceback and exit 1.
        """
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(
                [
                    "send",
                    "--type",
                    "8x8_4P",
                    "--cols",
                    "10",
                    "--rows",
                    "5",
                    "--pattern",
                    "tile:999,999",
                    "--dry-run",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("tile:999,999", err.getvalue())

    def test_send_with_a_negative_tile_spec_exits_2_not_a_silently_wrong_frame(self):
        """The other half of the same bug: `tile:-1,-1` used to wrap and return
        an exit-0, full-length buffer with a pixel lit in the wrong place.
        """
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(
                [
                    "send",
                    "--type",
                    "8x8_4P",
                    "--cols",
                    "10",
                    "--rows",
                    "5",
                    "--pattern",
                    "tile:-1,-1",
                    "--dry-run",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("tile:-1,-1", err.getvalue())

    def test_verify_with_an_out_of_range_tile_spec_exits_2(self):
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(
                [
                    "verify",
                    "captures/01-black.pcapng",
                    "--type",
                    "8x8_8P",
                    "--cols",
                    "8",
                    "--rows",
                    "5",
                    "--pattern",
                    "tile:999,999",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("tile:999,999", err.getvalue())

    def test_legacy_tile_col_row_flags_are_bounds_checked_too(self):
        """`--pattern tile --tile-col/--tile-row` routes through the same
        `tile:col,row` spec inside `_framebuffer`, so it must be caught the
        same way rather than reopening the hole through the back door.
        """
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(
                [
                    "send",
                    "--type",
                    "8x8_4P",
                    "--cols",
                    "10",
                    "--rows",
                    "5",
                    "--pattern",
                    "tile",
                    "--tile-col",
                    "999",
                    "--tile-row",
                    "999",
                    "--dry-run",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("999", err.getvalue())


if __name__ == "__main__":
    unittest.main()
