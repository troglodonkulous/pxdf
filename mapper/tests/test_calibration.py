"""`mapper.calibration` — per-region RGB gain applied ahead of packing.

Calibration exists to hide a tile-hardware defect (see the module docstring
in `mapper/calibration.py`), not to model anything about the wire. These
tests therefore check the arithmetic and the file format in isolation, the
same way `test_invariants.py` checks the packet plan in isolation: build a
framebuffer whose bytes are distinctive enough that a wrong offset or a wrong
rounding rule is visible, and check exact bytes.
"""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path

from mapper.calibration import SCHEMA, Calibration, Region, identity, load
from mapper.floors import FloorConfig
from mapper.patterns import black, gradient24

#: The rig's real geometry, and the geometry `identity-calibration.json` is
#: authored for.
RIG = FloorConfig.of("8x8_4P", 10, 5)

#: One tile, small enough to hand-check every pixel.
TINY = FloorConfig.of("8x8_4P", 1, 1)

DATA_DIR = Path(__file__).parent / "data"


def _pixel(framebuffer: bytes | bytearray, config: FloorConfig, x: int, y: int) -> tuple[int, int, int]:
    i = (y * config.width_px + x) * 3
    return tuple(framebuffer[i : i + 3])


def _with_pixel(config: FloorConfig, x: int, y: int, rgb: tuple[int, int, int]) -> bytearray:
    frame = black(config)
    i = (y * config.width_px + x) * 3
    frame[i : i + 3] = bytes(rgb)
    return frame


def _expected_channel(value: int, gain: float) -> int:
    return max(0, min(255, math.floor(value * gain + 0.5)))


class IdentityAndNoOpTest(unittest.TestCase):
    def test_identity_has_no_regions(self):
        self.assertEqual(identity().regions, ())
        self.assertIsNone(identity().floor)

    def test_identity_apply_is_byte_identical(self):
        frame = gradient24(RIG)
        out = identity().apply(RIG, frame)
        self.assertEqual(bytes(out), bytes(frame))

    def test_all_one_gain_region_is_byte_identical(self):
        frame = gradient24(RIG)
        cal = Calibration(
            regions=(Region(x=0, y=0, w=RIG.width_px, h=RIG.height_px, gain=(1.0, 1.0, 1.0)),)
        )
        out = cal.apply(RIG, frame)
        self.assertEqual(bytes(out), bytes(frame))

    def test_apply_returns_a_new_object(self):
        frame = gradient24(RIG)
        out = identity().apply(RIG, frame)
        self.assertIsNot(out, frame)


class GainRectAndBorderTest(unittest.TestCase):
    """A gain must land exactly on its rect and touch nothing else."""

    def test_gain_applies_inside_and_borders_are_untouched(self):
        frame = gradient24(RIG)
        x, y, w, h = 24, 8, 8, 4
        gain = (1.0, 0.5, 0.25)
        cal = Calibration(regions=(Region(x=x, y=y, w=w, h=h, gain=gain, note="test tile"),))
        out = cal.apply(RIG, frame)

        for dy in range(h):
            for dx in range(w):
                px, py = x + dx, y + dy
                r, g, b = _pixel(frame, RIG, px, py)
                expected = (
                    _expected_channel(r, gain[0]),
                    _expected_channel(g, gain[1]),
                    _expected_channel(b, gain[2]),
                )
                self.assertEqual(
                    _pixel(out, RIG, px, py), expected, f"pixel ({px},{py}) inside region"
                )

        # One-pixel ring immediately outside the rect on all four sides.
        border_points = set()
        for dx in range(-1, w + 1):
            border_points.add((x + dx, y - 1))
            border_points.add((x + dx, y + h))
        for dy in range(-1, h + 1):
            border_points.add((x - 1, y + dy))
            border_points.add((x + w, y + dy))

        for px, py in border_points:
            if not (0 <= px < RIG.width_px and 0 <= py < RIG.height_px):
                continue
            self.assertEqual(
                _pixel(out, RIG, px, py), _pixel(frame, RIG, px, py), f"border pixel ({px},{py})"
            )


class RoundingAndClampingTest(unittest.TestCase):
    """Fixed points from the spec, checked one at a time on a single pixel."""

    def _check(self, value: int, gain: float, expected: int):
        frame = _with_pixel(TINY, 0, 0, (value, value, value))
        cal = Calibration(regions=(Region(x=0, y=0, w=1, h=1, gain=(gain, gain, gain)),))
        out = cal.apply(TINY, frame)
        self.assertEqual(_pixel(out, TINY, 0, 0), (expected, expected, expected))

    def test_255_at_half_gain_rounds_to_128(self):
        self._check(255, 0.5, 128)

    def test_0_stays_0(self):
        self._check(0, 0.5, 0)

    def test_1_at_point_9_rounds_up_to_1(self):
        self._check(1, 0.9, 1)

    def test_255_at_full_gain_is_unchanged(self):
        self._check(255, 1.0, 255)

    def test_255_at_zero_gain_is_0(self):
        self._check(255, 0.0, 0)

    # Discriminating cases: Python's `round()` is banker's rounding (rounds
    # a tie to even), which agrees with round-half-up at 255*0.5 (both give
    # 128, since 127.5 isn't a tie under `round()`'s float behaviour either)
    # but disagrees at these three exact ties. Swapping the implementation
    # for `round(value * gain)` must fail here even though it passed every
    # case above.

    def test_1_at_half_gain_rounds_up_to_1_not_banker_0(self):
        self._check(1, 0.5, 1)

    def test_5_at_half_gain_rounds_up_to_3_not_banker_2(self):
        self._check(5, 0.5, 3)

    def test_2_at_quarter_gain_rounds_up_to_1_not_banker_0(self):
        self._check(2, 0.25, 1)


class NoMutationTest(unittest.TestCase):
    def test_input_framebuffer_is_not_mutated(self):
        frame = gradient24(RIG)
        before = bytes(frame)
        cal = Calibration(regions=(Region(x=0, y=0, w=8, h=8, gain=(0.5, 0.5, 0.5)),))
        cal.apply(RIG, frame)
        self.assertEqual(bytes(frame), before)


class DisjointRegionsTest(unittest.TestCase):
    def test_two_disjoint_regions_both_apply(self):
        frame = gradient24(TINY)
        gain_a = (0.5, 0.5, 0.5)
        gain_b = (0.25, 0.25, 0.25)
        cal = Calibration(
            regions=(
                Region(x=0, y=0, w=4, h=8, gain=gain_a, note="left"),
                Region(x=4, y=0, w=4, h=8, gain=gain_b, note="right"),
            )
        )
        out = cal.apply(TINY, frame)

        for y in range(8):
            for x in range(4):
                r, g, b = _pixel(frame, TINY, x, y)
                expected = tuple(_expected_channel(c, g_) for c, g_ in zip((r, g, b), gain_a))
                self.assertEqual(_pixel(out, TINY, x, y), expected)
            for x in range(4, 8):
                r, g, b = _pixel(frame, TINY, x, y)
                expected = tuple(_expected_channel(c, g_) for c, g_ in zip((r, g, b), gain_b))
                self.assertEqual(_pixel(out, TINY, x, y), expected)


class RejectionTest(unittest.TestCase):
    """Every listed rejection path raises ValueError, never AssertionError."""

    def test_rect_x_negative_rejected_at_construction(self):
        """Negative coordinates are illegal at every floor size, so `Region`
        itself rejects them -- it does not wait for `apply`/`validate` to see
        a `FloorConfig`. See the comment in `Region.__post_init__` for why a
        negative `x` reaching a slice assignment is worse than merely wrong.
        """
        with self.assertRaises(ValueError):
            Region(x=-1, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))

    def test_rect_y_negative_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=-1, w=4, h=4, gain=(1.0, 1.0, 1.0))

    def test_negative_x_is_also_caught_by_validate_in_depth(self):
        """Defense in depth: even a `Region` that bypassed `__post_init__`
        (e.g. a future refactor that moves construction) is still caught by
        `Calibration.validate`'s own `region.x < 0` check, not just relying
        on `Region` to have gotten there first. Without this second check, a
        negative `x` reaching `apply` would make `start = (y*width+x)*3`
        negative, and a negative-start bytearray slice assignment silently
        *wraps* to the tail of the buffer instead of raising.
        """
        region = Region.__new__(Region)
        object.__setattr__(region, "x", -1)
        object.__setattr__(region, "y", 0)
        object.__setattr__(region, "w", 4)
        object.__setattr__(region, "h", 1)
        object.__setattr__(region, "gain", (0.0, 0.0, 0.0))
        object.__setattr__(region, "note", "")
        cal = Calibration.__new__(Calibration)
        object.__setattr__(cal, "regions", (region,))
        object.__setattr__(cal, "floor", None)

        with self.assertRaises(ValueError):
            cal.apply(TINY, gradient24(TINY))

    def test_rect_beyond_width_rejected_at_apply(self):
        cal = Calibration(
            regions=(Region(x=RIG.width_px - 2, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0)),)
        )
        with self.assertRaises(ValueError):
            cal.apply(RIG, gradient24(RIG))

    def test_rect_beyond_height_rejected_at_apply(self):
        cal = Calibration(
            regions=(Region(x=0, y=RIG.height_px - 2, w=4, h=4, gain=(1.0, 1.0, 1.0)),)
        )
        with self.assertRaises(ValueError):
            cal.apply(RIG, gradient24(RIG))

    def test_validate_raises_for_a_config_dependent_bound_without_apply(self):
        """`validate` must be independently callable and independently correct,
        not merely a side effect of what `apply` happens to also check --
        this is what lets the CLI fail before opening a socket."""
        cal = Calibration(
            regions=(Region(x=RIG.width_px - 2, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0)),)
        )
        with self.assertRaises(ValueError):
            cal.validate(RIG)

    def test_validate_called_directly_raises_on_floor_mismatch(self):
        """Reached only via `validate()` here, not through `apply` at all."""
        cal = Calibration(regions=(), floor=("8x8_4P", 8, 5))
        with self.assertRaises(ValueError):
            cal.validate(RIG)

    def test_w_below_1_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=0, h=4, gain=(1.0, 1.0, 1.0))

    def test_h_below_1_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=0, gain=(1.0, 1.0, 1.0))

    def test_gain_above_1_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=4, gain=(1.01, 1.0, 1.0))

    def test_gain_below_0_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=4, gain=(-0.1, 1.0, 1.0))

    def test_gain_wrong_length_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=4, gain=(1.0, 1.0))

    def test_overlapping_regions_rejected_at_construction(self):
        a = Region(x=0, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))
        b = Region(x=2, y=2, w=4, h=4, gain=(1.0, 1.0, 1.0))
        with self.assertRaises(ValueError):
            Calibration(regions=(a, b))

    def test_touching_but_not_overlapping_regions_are_accepted(self):
        a = Region(x=0, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))
        b = Region(x=4, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))
        Calibration(regions=(a, b))  # must not raise

    def test_missing_schema_rejected_at_load(self):
        with self._tmp_json({"regions": []}) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_wrong_schema_rejected_at_load(self):
        with self._tmp_json({"schema": "not-the-schema", "regions": []}) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_floor_mismatch_rejected_at_apply(self):
        cal = Calibration(regions=(), floor=("8x8_4P", 8, 5))
        with self.assertRaises(ValueError):
            cal.apply(RIG, gradient24(RIG))

    def test_malformed_json_rejected_at_load(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.json"
            path.write_text("{not valid json", encoding="utf-8")
            with self.assertRaises(ValueError):
                load(path)

    def test_missing_regions_key_rejected_at_load(self):
        with self._tmp_json({"schema": SCHEMA}) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_region_missing_key_rejected_at_load(self):
        with self._tmp_json({"schema": SCHEMA, "regions": [{"x": 0, "y": 0, "w": 1}]}) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_region_wrong_type_rejected_at_load(self):
        payload = {
            "schema": SCHEMA,
            "regions": [{"x": 0, "y": 0, "w": 1, "h": 1, "gain": "not-a-list"}],
        }
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    # --- item 1: bool must not sneak through float() coercion in load() ----

    def test_bool_in_gain_rejected_at_load(self):
        """`bool` is an `int` subclass, so `float(False) == 0.0` and
        `float(True) == 1.0` both pass `Region`'s own bool guard once they
        reach it as plain floats -- a red channel of `false` would load as a
        silently-zeroed 0.0 and `dumps()` would re-emit it looking deliberate.
        `load` must reject the bool before it ever reaches `float()`.
        """
        payload = {
            "schema": SCHEMA,
            "regions": [{"x": 0, "y": 0, "w": 1, "h": 1, "gain": [False, True, 0.5]}],
        }
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    # --- item 3: x/y/w/h must be integers, not just non-negative -----------

    def test_x_non_integer_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=1.5, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))

    def test_w_bool_rejected_at_construction(self):
        # bool is an int subclass; must still be rejected as not a real int.
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=True, h=4, gain=(1.0, 1.0, 1.0))

    # --- item 4: every construction-time rejection is ValueError, never
    # TypeError/AttributeError --------------------------------------------

    def test_gain_not_a_sequence_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=4, gain=0.5)  # type: ignore[arg-type]

    def test_gain_none_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=4, gain=None)  # type: ignore[arg-type]

    def test_non_region_in_regions_rejected_at_construction(self):
        region = Region(x=0, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))
        with self.assertRaises(ValueError):
            Calibration(regions=(region, 7))  # type: ignore[arg-type]

    # --- item 5: a list of regions must not survive as a mutable field -----

    def test_calibration_freezes_a_list_of_regions_to_a_tuple(self):
        a = Region(x=0, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))
        b = Region(x=4, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0))
        cal = Calibration(regions=[a, b])  # type: ignore[arg-type]
        self.assertIsInstance(cal.regions, tuple)
        self.assertEqual(cal.regions, (a, b))

    # --- item 6: floor type name must be a real floor type -----------------

    def test_unknown_floor_type_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Calibration(regions=(), floor=("no-such-floor", 10, 5))

    def test_unknown_floor_type_rejected_at_load(self):
        payload = {"schema": SCHEMA, "floor": {"type": "no-such-floor", "cols": 10, "rows": 5}, "regions": []}
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    # --- item 7: unknown keys must be rejected, not silently dropped -------

    def test_unknown_top_level_key_rejected_at_load(self):
        payload = {"schema": SCHEMA, "regions": [], "extra": True}
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_unknown_floor_key_rejected_at_load(self):
        payload = {
            "schema": SCHEMA,
            "floor": {"type": "8x8_4P", "cols": 10, "rows": 5, "extra": 1},
            "regions": [],
        }
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_unknown_region_key_rejected_at_load(self):
        """A typo'd key (`nte` for `note`) must fail, not silently drop the note."""
        payload = {
            "schema": SCHEMA,
            "regions": [{"x": 0, "y": 0, "w": 1, "h": 1, "gain": [1.0, 1.0, 1.0], "nte": "typo"}],
        }
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    # --- item 10: additional mutant-killing rejection cases -----------------

    def test_regions_as_dict_rejected_at_load(self):
        payload = {"schema": SCHEMA, "regions": {"x": 0}}
        with self._tmp_json(payload) as path:
            with self.assertRaises(ValueError):
                load(path)

    def test_nan_gain_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=1, h=1, gain=(float("nan"), 1.0, 1.0))

    def test_positive_infinity_gain_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=1, h=1, gain=(float("inf"), 1.0, 1.0))

    def test_negative_infinity_gain_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=1, h=1, gain=(float("-inf"), 1.0, 1.0))

    def test_nan_gain_rejected_at_load(self):
        # json.loads accepts the bare `NaN` literal (a documented Python
        # extension over strict JSON), so this must reach `load`'s own path,
        # not just the direct-construction path above.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cal.json"
            text = (
                '{"schema": "%s", "regions": '
                '[{"x": 0, "y": 0, "w": 1, "h": 1, "gain": [NaN, 1.0, 1.0]}]}' % SCHEMA
            )
            path.write_text(text, encoding="utf-8")
            with self.assertRaises(ValueError):
                load(path)

    def test_four_item_gain_rejected_at_construction(self):
        with self.assertRaises(ValueError):
            Region(x=0, y=0, w=4, h=4, gain=(1.0, 1.0, 1.0, 1.0))

    def test_wrong_size_framebuffer_rejected_at_apply(self):
        with self.assertRaises(ValueError):
            identity().apply(RIG, b"\x00" * 10)

    def test_apply_accepts_an_immutable_bytes_framebuffer(self):
        frame = bytes(gradient24(RIG))
        cal = Calibration(regions=(Region(x=0, y=0, w=8, h=8, gain=(0.5, 0.5, 0.5)),))
        out = cal.apply(RIG, frame)  # must not raise
        self.assertIsInstance(out, bytearray)
        expected_pixel = tuple(_expected_channel(c, 0.5) for c in _pixel(frame, RIG, 0, 0))
        self.assertEqual(_pixel(out, RIG, 0, 0), expected_pixel)

    # --- item 9: pin type, cols and rows of the floor block independently --

    def test_floor_type_mismatch_alone_rejected(self):
        cal = Calibration(regions=(), floor=("8x8_8P", RIG.tile_cols, RIG.tile_rows))
        with self.assertRaises(ValueError):
            cal.validate(RIG)

    def test_floor_cols_mismatch_alone_rejected(self):
        cal = Calibration(regions=(), floor=(RIG.type.name, RIG.tile_cols - 1, RIG.tile_rows))
        with self.assertRaises(ValueError):
            cal.validate(RIG)

    def test_floor_rows_mismatch_alone_rejected(self):
        cal = Calibration(regions=(), floor=(RIG.type.name, RIG.tile_cols, RIG.tile_rows - 1))
        with self.assertRaises(ValueError):
            cal.validate(RIG)

    def test_floor_exact_match_on_all_three_fields_accepted(self):
        cal = Calibration(regions=(), floor=(RIG.type.name, RIG.tile_cols, RIG.tile_rows))
        cal.validate(RIG)  # must not raise

    def _tmp_json(self, payload: dict):
        return _TempJson(payload)


class _TempJson:
    """Context manager: write `payload` as JSON to a temp file, yield its path."""

    def __init__(self, payload: dict):
        self.payload = payload
        self._dir: tempfile.TemporaryDirectory | None = None

    def __enter__(self) -> Path:
        self._dir = tempfile.TemporaryDirectory()
        path = Path(self._dir.name) / "cal.json"
        path.write_text(json.dumps(self.payload), encoding="utf-8")
        return path

    def __exit__(self, *exc):
        self._dir.cleanup()


class RoundTripTest(unittest.TestCase):
    def test_round_trip_without_floor(self):
        cal = Calibration(
            regions=(
                Region(x=1, y=2, w=3, h=4, gain=(1.0, 0.5, 0.0), note="a note"),
                Region(x=10, y=2, w=3, h=4, gain=(0.9, 0.9, 0.9)),
            )
        )
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cal.json"
            path.write_text(cal.dumps(), encoding="utf-8")
            loaded = load(path)
        self.assertEqual(loaded, cal)

    def test_round_trip_with_floor_and_note(self):
        cal = Calibration(
            regions=(Region(x=24, y=8, w=8, h=4, gain=(1.0, 0.93, 0.90), note="orange tile"),),
            floor=("8x8_4P", 10, 5),
        )
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cal.json"
            path.write_text(cal.dumps(), encoding="utf-8")
            loaded = load(path)
        self.assertEqual(loaded, cal)
        self.assertEqual(loaded.regions[0].note, "orange tile")
        self.assertEqual(loaded.floor, ("8x8_4P", 10, 5))

    def test_dumps_uses_the_schema_constant(self):
        cal = identity()
        self.assertEqual(json.loads(cal.dumps())["schema"], SCHEMA)


class IdentityFixtureTest(unittest.TestCase):
    """The fixture consumed by another package's digest-guard test."""

    def test_identity_fixture_matches_the_rig_and_is_a_no_op(self):
        cal = load(DATA_DIR / "identity-calibration.json")
        self.assertEqual(cal.floor, ("8x8_4P", 10, 5))
        self.assertEqual(len(cal.regions), 1)
        region = cal.regions[0]
        self.assertEqual((region.x, region.y, region.w, region.h), (0, 0, RIG.width_px, RIG.height_px))
        self.assertEqual(region.gain, (1.0, 1.0, 1.0))

        frame = gradient24(RIG)
        out = cal.apply(RIG, frame)
        self.assertEqual(bytes(out), bytes(frame))


if __name__ == "__main__":
    unittest.main()
