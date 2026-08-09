"""Geometry-independent mapper for the TP-878 floor controller wire protocol.

Implements `docs/PROTOCOL.md` for any legal combination of floor type, tile
columns and tile rows, rather than the single 8x5 `8x8_8P` layout the original
PowerShell sender was written for.

Written from the specification in `docs/DECOMP_FINDINGS.md`. Contains no vendor
code.
"""

from .floors import (
    BODY_MAX,
    CONST_BYTE2,
    DEST_ADDRESS,
    DEST_PORT,
    EOF_FLAG,
    FLOOR_TYPES,
    MAGIC,
    MAX_TILE_COLS,
    TILE_PITCH_MM,
    FloorConfig,
    FloorType,
    floor_type,
    legal_configs,
)
from .frame import Address, build_frame, pack_send_buffer, pixel_address
from .orientation import Orientation
from .plan import PacketSpec, build_plan

__all__ = [
    "Address",
    "BODY_MAX",
    "CONST_BYTE2",
    "DEST_ADDRESS",
    "DEST_PORT",
    "EOF_FLAG",
    "FLOOR_TYPES",
    "FloorConfig",
    "FloorType",
    "MAGIC",
    "MAX_TILE_COLS",
    "Orientation",
    "PacketSpec",
    "TILE_PITCH_MM",
    "build_frame",
    "build_plan",
    "floor_type",
    "legal_configs",
    "pack_send_buffer",
    "pixel_address",
]
