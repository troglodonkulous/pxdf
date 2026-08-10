"""Per-region RGB gain applied to the framebuffer before it is packed.

**This is cosmetic masking of a hardware defect, not a repair.** One or two
tiles on the rig read orange at full white — confirmed as tile hardware by
swapping tiles physically. There is no vendor calibration mechanism, so a gain
below 1.0 is applied to the affected region(s) to bring the *good* tiles down
to match, before the framebuffer is handed to `frame.pack_send_buffer`. A
calibration file is a record of "we dimmed these tiles to hide a defect", not
a measurement of the floor, the wire, or anything this project's other
tooling checks. A future session must not read one as evidence of anything
beyond "someone judged this region too bright by eye on this date".

Region coordinates are in the **logical framebuffer / pre-orientation**
space: the same `(x, y)` space `patterns.tile()` and `patterns.gradient24()`
address, top-left origin, before `orientation.Orientation` or the wire
mapping in `frame.py` touch anything. Orientation on this rig is permanently
`identity` (see `CLAUDE.md`), so in practice this is also physical floor
space left-to-right — but that equivalence is a fact about this rig's
cabling, not about this module, and it would stop holding the moment a
non-identity orientation was ever introduced.

There is no headroom above 255 on the wire: a gain can only ever bring a
channel *down*. A gain greater than 1.0 has no sensible meaning here (it
would just clip), so it is rejected at load rather than silently clamped —
a file that asked for more brightness than exists would otherwise look like
it worked and quietly do nothing.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .floors import FLOOR_TYPES, FloorConfig

SCHEMA = "ddf-calibration/1"


@dataclass(frozen=True)
class Region:
    """One rectangle of the framebuffer and the per-channel gain applied to it.

    `x, y, w, h` are in logical framebuffer pixels (see module docstring for
    the coordinate space). Whether the rectangle actually fits the floor can
    only be known once a `FloorConfig` is, so that check lives in
    `Calibration.validate`/`apply`, not here.
    """

    x: int
    y: int
    w: int
    h: int
    gain: tuple[float, float, float]
    note: str = ""

    def __post_init__(self) -> None:
        # x/y/w/h: integer, and non-negative/positive respectively. Unlike the
        # "does it fit the floor" bounds (config-dependent, checked in
        # `Calibration.validate`), negative coordinates are illegal at *every*
        # floor size, so they belong here. This matters beyond tidiness: a
        # negative `x`/`y` turns `start = (y * width + x) * 3` negative, and a
        # negative-start slice assignment on a bytearray silently wraps to the
        # end of the buffer instead of raising -- `apply` would then return a
        # wrong-but-correctly-sized frame with no error at all.
        for name, value in (("x", self.x), ("y", self.y), ("w", self.w), ("h", self.h)):
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(
                    f"region {self._label()}: {name}={value!r} must be an integer"
                )
        if self.x < 0:
            raise ValueError(f"region {self._label()}: x={self.x} must be >= 0")
        if self.y < 0:
            raise ValueError(f"region {self._label()}: y={self.y} must be >= 0")
        if self.w < 1:
            raise ValueError(f"region {self._label()}: w={self.w} must be >= 1")
        if self.h < 1:
            raise ValueError(f"region {self._label()}: h={self.h} must be >= 1")

        if not isinstance(self.gain, (tuple, list)):
            raise ValueError(
                f"region {self._label()}: gain must be a sequence of 3 numbers, got {self.gain!r}"
            )
        gain = tuple(self.gain)
        if len(gain) != 3:
            raise ValueError(
                f"region {self._label()}: gain must have exactly 3 values (r, g, b), got {gain!r}"
            )
        checked = []
        for channel, value in zip("rgb", gain):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(
                    f"region {self._label()}: gain channel {channel} must be a number, got {value!r}"
                )
            # NaN and +/-inf fail every branch of `0.0 <= value <= 1.0` (a NaN
            # comparison is always False), so they fall through to this same
            # rejection rather than reaching `_channel_table`, which cannot
            # build a table from a non-finite gain.
            if not (0.0 <= value <= 1.0):
                raise ValueError(
                    f"region {self._label()}: gain channel {channel}={value} outside [0.0, 1.0] "
                    "-- there is no headroom above 255 on the wire, so calibration can only bring "
                    "a channel down, never up"
                )
            checked.append(float(value))
        object.__setattr__(self, "gain", tuple(checked))

    def _label(self) -> str:
        return f"({self.x}, {self.y}, {self.w}x{self.h}){f' {self.note!r}' if self.note else ''}"

    def _overlaps(self, other: "Region") -> bool:
        return (
            self.x < other.x + other.w
            and other.x < self.x + self.w
            and self.y < other.y + other.h
            and other.y < self.y + self.h
        )


def _round_half_up_clamped(value: int, gain: float) -> int:
    scaled = math.floor(value * gain + 0.5)
    if scaled < 0:
        return 0
    if scaled > 255:
        return 255
    return scaled


@lru_cache(maxsize=None)
def _channel_table(gain: float) -> bytes:
    """256-entry `bytes.translate` table for one channel's gain, cached by value."""
    return bytes(_round_half_up_clamped(v, gain) for v in range(256))


@lru_cache(maxsize=None)
def _gain_tables(gain: tuple[float, float, float]) -> tuple[bytes, bytes, bytes]:
    """The three per-channel tables for one gain triple, cached by triple."""
    return tuple(_channel_table(g) for g in gain)


@dataclass(frozen=True)
class Calibration:
    """A set of non-overlapping gain regions, optionally pinned to one floor."""

    regions: tuple[Region, ...] = field(default_factory=tuple)
    #: `(floor type name, tile cols, tile rows)` this file was authored for.
    #: `None` means "no claim made"; `apply`/`validate` then skip the check.
    floor: tuple[str, int, int] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.regions, (tuple, list)):
            raise ValueError(f"regions must be a sequence of Region, got {self.regions!r}")
        regions = tuple(self.regions)
        for i, r in enumerate(regions):
            if not isinstance(r, Region):
                raise ValueError(f"regions[{i}] must be a Region, got {r!r}")
        # Freeze to a tuple even if a list was passed in: a frozen dataclass
        # holding a mutable, unhashable field defeats the point of freezing it.
        object.__setattr__(self, "regions", regions)

        if self.floor is not None:
            floor_type_name = self.floor[0]
            if floor_type_name not in FLOOR_TYPES:
                raise ValueError(
                    f"floor type {floor_type_name!r} is not a known floor type "
                    f"(known: {sorted(FLOOR_TYPES)})"
                )

        for i in range(len(self.regions)):
            for j in range(i + 1, len(self.regions)):
                a, b = self.regions[i], self.regions[j]
                if a._overlaps(b):
                    raise ValueError(
                        f"region {i} {a._label()} and region {j} {b._label()} overlap; "
                        "calibration regions must be disjoint -- 'last one wins' is a silent trap"
                    )

    # --- floor-dependent checks -------------------------------------------------

    def validate(self, config: FloorConfig) -> None:
        """Check this calibration against a concrete floor, without applying it.

        Lets a caller (the CLI) fail before opening a socket rather than
        discovering a bad region mid-send.
        """
        if self.floor is not None:
            actual = (config.type.name, config.tile_cols, config.tile_rows)
            if self.floor != actual:
                raise ValueError(
                    f"calibration was authored for floor {self.floor}, "
                    f"but config is {actual}"
                )
        width, height = config.width_px, config.height_px
        for i, region in enumerate(self.regions):
            if (
                region.x < 0
                or region.y < 0
                or region.x + region.w > width
                or region.y + region.h > height
            ):
                raise ValueError(
                    f"region {i} {region._label()} is outside the {width}x{height} floor"
                )

    def apply(self, config: FloorConfig, framebuffer: bytes | bytearray) -> bytearray:
        """Apply every region's gain. Returns a new buffer; never mutates the input."""
        self.validate(config)
        expected = config.pixel_count * 3
        if len(framebuffer) != expected:
            raise ValueError(f"framebuffer is {len(framebuffer)} bytes, expected {expected}")

        out = bytearray(framebuffer)
        width = config.width_px
        for region in self.regions:
            tables = _gain_tables(region.gain)
            row_len = region.w * 3
            for dy in range(region.h):
                y = region.y + dy
                start = (y * width + region.x) * 3
                seg = bytes(out[start : start + row_len])
                rebuilt = bytearray(row_len)
                rebuilt[0::3] = seg[0::3].translate(tables[0])
                rebuilt[1::3] = seg[1::3].translate(tables[1])
                rebuilt[2::3] = seg[2::3].translate(tables[2])
                out[start : start + row_len] = rebuilt
        return out

    # --- (de)serialisation --------------------------------------------------

    def dumps(self) -> str:
        payload: dict = {"schema": SCHEMA}
        if self.floor is not None:
            payload["floor"] = {
                "type": self.floor[0],
                "cols": self.floor[1],
                "rows": self.floor[2],
            }
        payload["regions"] = [
            {
                "x": r.x,
                "y": r.y,
                "w": r.w,
                "h": r.h,
                "gain": list(r.gain),
                "note": r.note,
            }
            for r in self.regions
        ]
        return json.dumps(payload, indent=2)


def identity() -> Calibration:
    """No regions. `apply` returns a byte-identical copy of the framebuffer."""
    return Calibration(regions=())


def _fail(path: Path, message: str) -> "ValueError":
    return ValueError(f"calibration file {path}: {message}")


def _reject_unknown_keys(path: Path, obj: dict, allowed: set, where: str) -> None:
    """A typo'd key (e.g. `"nte"` for `"note"`) must fail loudly, not vanish.

    `note` in particular is the whole provenance record this format exists to
    carry ("someone judged this region too bright, here's why"); silently
    dropping it on a typo is exactly the kind of unnoticed data loss this
    project's docs warn about.
    """
    extra = set(obj) - allowed
    if extra:
        raise _fail(path, f"{where}: unknown key(s) {sorted(extra)}")


def load(path: str | Path) -> Calibration:
    """Load and fully validate (schema, gain range, overlap) a calibration file.

    Never raises `AssertionError` or lets a parse exception escape -- every
    malformed-input path is normalised to `ValueError`.
    """
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise _fail(p, f"cannot read file: {exc}") from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _fail(p, f"malformed JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise _fail(p, "top level must be a JSON object")

    _reject_unknown_keys(p, data, {"schema", "floor", "regions"}, "top level")

    schema = data.get("schema")
    if schema != SCHEMA:
        raise _fail(p, f"schema is {schema!r}, expected {SCHEMA!r}")

    floor: tuple[str, int, int] | None = None
    if "floor" in data:
        floor_data = data["floor"]
        if not isinstance(floor_data, dict):
            raise _fail(p, "'floor' must be an object")
        _reject_unknown_keys(p, floor_data, {"type", "cols", "rows"}, "'floor'")
        try:
            floor_type, cols, rows = floor_data["type"], floor_data["cols"], floor_data["rows"]
        except KeyError as exc:
            raise _fail(p, f"'floor' missing key {exc}") from exc
        if not isinstance(floor_type, str) or isinstance(cols, bool) or isinstance(rows, bool):
            raise _fail(p, "'floor' has the wrong types for type/cols/rows")
        if not isinstance(cols, int) or not isinstance(rows, int):
            raise _fail(p, "'floor' cols/rows must be integers")
        floor = (floor_type, cols, rows)

    regions_data = data.get("regions")
    if not isinstance(regions_data, list):
        raise _fail(p, "'regions' must be a list")

    regions: list[Region] = []
    for i, rd in enumerate(regions_data):
        if not isinstance(rd, dict):
            raise _fail(p, f"region {i} must be an object")
        _reject_unknown_keys(p, rd, {"x", "y", "w", "h", "gain", "note"}, f"region {i}")
        try:
            x, y, w, h, gain = rd["x"], rd["y"], rd["w"], rd["h"], rd["gain"]
        except KeyError as exc:
            raise _fail(p, f"region {i} missing key {exc}") from exc
        if any(isinstance(v, bool) or not isinstance(v, int) for v in (x, y, w, h)):
            raise _fail(p, f"region {i}: x/y/w/h must be integers")
        if not isinstance(gain, list):
            raise _fail(p, f"region {i}: gain must be a list")
        note = rd.get("note", "")
        if not isinstance(note, str):
            raise _fail(p, f"region {i}: note must be a string")
        # Checked here, before the float() coercion below: `bool` is a `int`
        # subclass, so `float(True)` silently succeeds as `1.0` and a
        # boolean-in-a-gain-slot would sail past `Region.__post_init__`'s own
        # bool guard, which only ever sees the already-coerced float.
        for g in gain:
            if isinstance(g, bool) or not isinstance(g, (int, float)):
                raise _fail(
                    p, f"region {i}: gain values must be numbers (not booleans), got {g!r}"
                )
        gain_tuple = tuple(float(g) for g in gain)
        try:
            regions.append(Region(x=x, y=y, w=w, h=h, gain=gain_tuple, note=note))
        except ValueError as exc:
            raise _fail(p, str(exc)) from exc

    try:
        return Calibration(regions=tuple(regions), floor=floor)
    except ValueError as exc:
        raise _fail(p, str(exc)) from exc
