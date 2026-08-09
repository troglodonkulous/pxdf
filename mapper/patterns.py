"""Framebuffer sources.

Fixtures use `gradient24`, which is unique per pixel. A solid colour cannot
detect a permutation — every wrong mapping of a white frame is still a white
frame, which is exactly how two earlier self-consistent-but-wrong conclusions
survived as long as they did.
"""

from __future__ import annotations

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
