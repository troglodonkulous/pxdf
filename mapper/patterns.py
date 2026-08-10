"""Framebuffer sources.

Fixtures use `gradient24`, which is unique per pixel. A solid colour cannot
detect a permutation — every wrong mapping of a white frame is still a white
frame, which is exactly how two earlier self-consistent-but-wrong conclusions
survived as long as they did.
"""

from __future__ import annotations

from typing import Callable

from .floors import FloorConfig


def solid(config: FloorConfig, r: int, g: int, b: int) -> bytearray:
    return bytearray(bytes((r, g, b)) * config.pixel_count)


def black(config: FloorConfig) -> bytearray:
    return solid(config, 0, 0, 0)


def white(config: FloorConfig) -> bytearray:
    return solid(config, 255, 255, 255)


def gradient24(config: FloorConfig) -> bytearray:
    """Per-pixel-unique 24-bit encoding of the pixel's own coordinates.

    Blue carries x, green carries y — both fit in a byte, since the largest
    legal floor is 256 x 200 px. Red carries the tile index, which is redundant
    but makes a tile-level swap obvious by eye as well as by hash.
    """
    width, height = config.width_px, config.height_px
    tile_px = config.type.tile_px
    tile_cols = config.tile_cols
    frame = bytearray(width * height * 3)
    i = 0
    for y in range(height):
        tile_row = y // tile_px
        for x in range(width):
            frame[i] = ((tile_row * tile_cols + x // tile_px) * 7 + 1) & 0xFF
            frame[i + 1] = y & 0xFF
            frame[i + 2] = x & 0xFF
            i += 3
    return frame


def tile(config: FloorConfig, tile_col: int, tile_row: int) -> bytearray:
    """One lit tile, for corner checks at the floor."""
    frame = black(config)
    tile_px = config.type.tile_px
    for dy in range(tile_px):
        y = tile_row * tile_px + dy
        for dx in range(tile_px):
            i = (y * config.width_px + tile_col * tile_px + dx) * 3
            frame[i : i + 3] = b"\xff\xff\xff"
    return frame


PATTERNS = {
    "black": black,
    "white": white,
    "gradient24": gradient24,
    "red": lambda c: solid(c, 255, 0, 0),
    "green": lambda c: solid(c, 0, 255, 0),
    "blue": lambda c: solid(c, 0, 0, 255),
}

#: The eight grey levels `steps` bands the floor into.
STEP_LEVELS = (32, 64, 96, 128, 160, 192, 224, 255)


def steps(config: FloorConfig) -> bytearray:
    """Horizontal grey bands at each of `STEP_LEVELS`, full floor width.

    A row's band is `y * len(STEP_LEVELS) // height` -- scale the row into
    `0..len(STEP_LEVELS)` and truncate. At the rig's 40 px this lands on exact
    5-row boundaries (40 / 8 = 5), which is the case this pattern was written
    to check: a per-tile gain or threshold defect against a target other than
    full white. At a height that does not divide evenly, the truncation
    spreads the remainder rows across the later bands one at a time rather
    than dumping them all in the last band, and it never indexes past
    `STEP_LEVELS[-1]` or produces an empty band for any height >= 8.
    """
    width, height = config.width_px, config.height_px
    n = len(STEP_LEVELS)
    frame = bytearray(width * height * 3)
    for y in range(height):
        level = STEP_LEVELS[y * n // height]
        row = bytes((level, level, level)) * width
        offset = y * width * 3
        frame[offset : offset + len(row)] = row
    return frame


def _bad_spec(spec: str) -> str:
    names = ", ".join(sorted(PATTERNS))
    return (
        f"unknown pattern {spec!r}; legal forms are: a name ({names}), "
        f"'level:N' (solid grey, 0-255), 'solid:R,G,B' (0-255 each), "
        f"'steps' (horizontal grey bands), or 'tile:col,row' (one lit tile)"
    )


def resolve(spec: str) -> Callable[[FloorConfig], bytearray]:
    """Turn a `--pattern` argument into a `FloorConfig -> bytearray` callable.

    Accepted, in order: a plain name already in `PATTERNS`; `level:N` for a
    solid grey (the discriminator between a proportional gain error and a
    threshold effect at the floor); `solid:R,G,B` for an arbitrary solid;
    `steps` for the full band ladder; and `tile:col,row` for the existing
    single-tile check. A spec that matches none of these raises `ValueError`
    naming the spec and the legal forms, rather than failing later with a
    `KeyError` that says nothing about what was typed.
    """
    if spec in PATTERNS:
        return PATTERNS[spec]
    if spec == "steps":
        return steps
    if spec.startswith("level:"):
        try:
            level = int(spec[len("level:") :])
        except ValueError:
            raise ValueError(_bad_spec(spec)) from None
        if not 0 <= level <= 255:
            raise ValueError(_bad_spec(spec))
        return lambda config: solid(config, level, level, level)
    if spec.startswith("solid:"):
        parts = spec[len("solid:") :].split(",")
        if len(parts) != 3:
            raise ValueError(_bad_spec(spec))
        try:
            r, g, b = (int(p) for p in parts)
        except ValueError:
            raise ValueError(_bad_spec(spec)) from None
        if not all(0 <= v <= 255 for v in (r, g, b)):
            raise ValueError(_bad_spec(spec))
        return lambda config: solid(config, r, g, b)
    if spec.startswith("tile:"):
        parts = spec[len("tile:") :].split(",")
        if len(parts) != 2:
            raise ValueError(_bad_spec(spec))
        try:
            tile_col, tile_row = (int(p) for p in parts)
        except ValueError:
            raise ValueError(_bad_spec(spec)) from None

        def _resolved_tile(
            config: FloorConfig, tile_col: int = tile_col, tile_row: int = tile_row
        ) -> bytearray:
            # Unlike level/solid, an out-of-range tile is not visible as a
            # ValueError from int() -- a negative index wraps in tile()'s slice
            # assignment and lights a pixel in the middle of the floor instead
            # of raising, and an index too large builds a wrong-length buffer
            # that only fails later, inside frame.pack_send_buffer, outside
            # every caller's `except ValueError`. Bounds-check here, against
            # the config, which is only known once this closure is called.
            if not (0 <= tile_col < config.tile_cols and 0 <= tile_row < config.tile_rows):
                raise ValueError(
                    f"pattern {spec!r}: tile ({tile_col}, {tile_row}) is outside "
                    f"the {config.tile_cols}x{config.tile_rows} tile grid"
                )
            return tile(config, tile_col, tile_row)

        return _resolved_tile
    raise ValueError(_bad_spec(spec))
