"""Floor types and the sizes derived from a floor configuration.

Every constant here is cited to the vendor source in `docs/DECOMP_FINDINGS.md`.
Nothing in this module knows about pixels or packets; it answers "how big is
this floor, and how does the controller carve it up".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import ceil
from typing import Iterator

# --- protocol constants -------------------------------------------------------
# All from `SendData` / `ScreenSendInit` in screenSend.dll.

MAGIC = 0xFF
CONST_BYTE2 = 0x01
EOF_FLAG = 0x80
HEADER_LEN = 5
BODY_MAX = 507
DEST_ADDRESS = "255.255.255.255"
DEST_PORT = 60001

#: Physical tile pitch. Ledset's "feet" dropdowns call a tile 2 ft, which is
#: wrong by 2.4% per tile; 500 mm is the real dimension off the product data.
TILE_PITCH_MM = 500.0

#: The mapper UI offers the same 32 width entries for every floor type.
MAX_TILE_COLS = 32


def _identity_scan(n: int) -> tuple[int, ...]:
    """Row-major, no serpentine. The 8x8 floor types use this."""
    return tuple(range(n * n))


def _transpose_scan(n: int) -> tuple[int, ...]:
    """`table[k + n*j] = n*k + j` — the 6x6 floor types use this."""
    table = [0] * (n * n)
    for j in range(n):
        for k in range(n):
            table[k + n * j] = n * k + j
    return tuple(table)


@dataclass(frozen=True)
class FloorType:
    """One entry of the vendor's `FloorType` enum, with its scan table.

    `scan_table[slot]` is the index of the source pixel within the tile that
    the controller expects at output slot `slot`. Packing needs the inverse,
    which is precomputed as `slot_of_source`.
    """

    name: str
    type_index: int
    tile_px: int
    ports_per_controller: int
    max_tile_rows: int
    scan_table: tuple[int, ...]
    #: In scope for this implementation. 6x6 is carried as data so it can drop
    #: in later, but we have no 6x6 hardware and make no claim about it.
    supported: bool
    #: Verified byte-identical against a Ledset capture on real hardware.
    hardware_verified: bool
    slot_of_source: tuple[int, ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        inverse = [0] * len(self.scan_table)
        for slot, source in enumerate(self.scan_table):
            inverse[source] = slot
        object.__setattr__(self, "slot_of_source", tuple(inverse))

    @property
    def pixels_per_tile(self) -> int:
        return self.tile_px * self.tile_px

    @property
    def bytes_per_tile(self) -> int:
        return self.pixels_per_tile * 3


FLOOR_TYPES: dict[str, FloorType] = {
    t.name: t
    for t in (
        FloorType("6x6_4P", 0, 6, 4, 25, _transpose_scan(6), False, False),
        FloorType("6x6_8P", 1, 6, 8, 17, _transpose_scan(6), False, False),
        FloorType("8x8_4P", 2, 8, 4, 22, _identity_scan(8), True, False),
        FloorType("8x8_8P", 3, 8, 8, 11, _identity_scan(8), True, True),
    )
}

#: Indexed by the mapper XML's `TypeIndex`, and by `ScreenSendInit`'s
#: `floorType` argument — the vendor uses the same ordering for both.
FLOOR_TYPES_BY_INDEX: dict[int, FloorType] = {t.type_index: t for t in FLOOR_TYPES.values()}


def floor_type(key: str | int | FloorType) -> FloorType:
    """Resolve a floor type from its name, its `TypeIndex`, or itself."""
    if isinstance(key, FloorType):
        return key
    if isinstance(key, int):
        return FLOOR_TYPES_BY_INDEX[key]
    return FLOOR_TYPES[key]


@dataclass(frozen=True)
class FloorConfig:
    """A legal floor: a type plus a tile grid."""

    type: FloorType
    tile_cols: int
    tile_rows: int

    def __post_init__(self) -> None:
        if not 1 <= self.tile_cols <= MAX_TILE_COLS:
            raise ValueError(
                f"tile_cols {self.tile_cols} outside 1..{MAX_TILE_COLS}"
            )
        if not 1 <= self.tile_rows <= self.type.max_tile_rows:
            raise ValueError(
                f"tile_rows {self.tile_rows} outside 1..{self.type.max_tile_rows} "
                f"for floor type {self.type.name}"
            )

    @classmethod
    def of(cls, type_key: str | int | FloorType, tile_cols: int, tile_rows: int) -> "FloorConfig":
        return cls(floor_type(type_key), tile_cols, tile_rows)

    # --- pixel geometry -------------------------------------------------------

    @property
    def width_px(self) -> int:
        return self.tile_cols * self.type.tile_px

    @property
    def height_px(self) -> int:
        return self.tile_rows * self.type.tile_px

    @property
    def pixel_count(self) -> int:
        return self.width_px * self.height_px

    @property
    def width_mm(self) -> float:
        return self.tile_cols * TILE_PITCH_MM

    @property
    def height_mm(self) -> float:
        return self.tile_rows * TILE_PITCH_MM

    # --- how the controller carves it up --------------------------------------

    @property
    def port_data_size(self) -> int:
        """Bytes one port carries: one whole tile column of the logical grid."""
        return self.type.bytes_per_tile * self.tile_rows

    @property
    def controller_data_size(self) -> int:
        return self.port_data_size * self.type.ports_per_controller

    @property
    def packets_per_port(self) -> int:
        return ceil(self.port_data_size / BODY_MAX)

    @property
    def controller_count(self) -> int:
        return ceil(self.tile_cols / self.type.ports_per_controller)

    @property
    def last_controller_port_count(self) -> int:
        """Ports active on the final controller — a full set when it divides."""
        remainder = self.tile_cols % self.type.ports_per_controller
        return remainder or self.type.ports_per_controller

    def ports_on(self, controller: int) -> int:
        if not 0 <= controller < self.controller_count:
            raise IndexError(f"controller {controller} outside 0..{self.controller_count - 1}")
        if controller == self.controller_count - 1:
            return self.last_controller_port_count
        return self.type.ports_per_controller

    @property
    def packets_per_frame(self) -> int:
        return self.tile_cols * self.packets_per_port

    @property
    def bytes_per_frame(self) -> int:
        return self.packets_per_frame * HEADER_LEN + self.tile_cols * self.port_data_size

    # --- Ledset mapper XML interop --------------------------------------------
    # `feet = (index + 1) * 2`, then `tiles = feet / 2`, so index = tiles - 1.
    # Ledset's feet are wrong (it assumes a 2 ft tile); we only use the indices.

    @property
    def feet_of_width_index(self) -> int:
        return self.tile_cols - 1

    @property
    def feet_of_height_index(self) -> int:
        return self.tile_rows - 1

    def describe(self) -> str:
        return (
            f"{self.type.name} {self.tile_cols}x{self.tile_rows} tiles "
            f"= {self.width_px}x{self.height_px} px, "
            f"{self.controller_count} controller(s), "
            f"{self.packets_per_frame} packets/frame, "
            f"{self.bytes_per_frame} bytes/frame"
        )


def legal_configs(
    types: tuple[FloorType, ...] | None = None,
    supported_only: bool = False,
) -> Iterator[FloorConfig]:
    """Every `(type, cols, rows)` the mapper UI will accept."""
    pool = types if types is not None else tuple(FLOOR_TYPES.values())
    for t in pool:
        if supported_only and not t.supported:
            continue
        for cols in range(1, MAX_TILE_COLS + 1):
            for rows in range(1, t.max_tile_rows + 1):
                yield FloorConfig(t, cols, rows)
