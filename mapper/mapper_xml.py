"""Ledset mapper XML, read and written.

Writing this file is the better oracle control path: set it, restart Ledset,
and `ReadParam` / `OpenFile` load the geometry with no UI automation at all.

The file carries no wiring table — just the four integers below. `Width` and
`Height` are logical pixels; the `FeetOf*Index` values are dropdown indices,
where Ledset believes `feet = (index + 1) * 2` and a tile is 2 ft. That belief
is wrong — a tile is 500 mm — but the indices are still exactly `tiles - 1`, so
round-tripping is lossless.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from .floors import FLOOR_TYPES_BY_INDEX, FloorConfig

_NAMESPACES = (
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
)


def to_xml(config: FloorConfig) -> str:
    """Serialise, byte-for-byte in the shape Ledset itself writes."""
    return (
        '<?xml version="1.0"?>\n'
        f'<Mapper {_NAMESPACES} Width="{config.width_px}" Height="{config.height_px}">\n'
        f"  <TypeIndex>{config.type.type_index}</TypeIndex>\n"
        f"  <FeetOfWidthIndex>{config.feet_of_width_index}</FeetOfWidthIndex>\n"
        f"  <FeetOfHeightIndex>{config.feet_of_height_index}</FeetOfHeightIndex>\n"
        "</Mapper>"
    )


def from_xml(text: str) -> FloorConfig:
    """Parse a mapper file into a config, preferring the indices over Width/Height.

    The indices are the tile counts; `Width`/`Height` are pixels and therefore
    redundant. Where they disagree the file is malformed, and we say so rather
    than silently picking one.
    """
    root = ET.fromstring(text)
    type_index = int(root.findtext("TypeIndex", ""))
    tile_cols = int(root.findtext("FeetOfWidthIndex", "")) + 1
    tile_rows = int(root.findtext("FeetOfHeightIndex", "")) + 1

    config = FloorConfig(FLOOR_TYPES_BY_INDEX[type_index], tile_cols, tile_rows)
    width, height = root.get("Width"), root.get("Height")
    if width is not None and int(width) != config.width_px:
        raise ValueError(f"Width={width} contradicts {tile_cols} tile columns")
    if height is not None and int(height) != config.height_px:
        raise ValueError(f"Height={height} contradicts {tile_rows} tile rows")
    return config


def read(path: str | Path) -> FloorConfig:
    return from_xml(Path(path).read_text(encoding="utf-8"))
