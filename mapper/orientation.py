"""Physical orientation of the floor, applied at the framebuffer read step.

The wire mapping in `plan.py` and `frame.py` is fixed by the vendor's code and
says nothing about which physical tile is logical (0, 0) — that depends on how
the floor was cabled at load-in. This module holds the whole of that freedom,
and it is applied *before* packing. Packet order, `packetIndex` and
`bodyOffset` are never touched to achieve an orientation.

Only 0 deg and 180 deg are offered. 90 deg and 270 deg are physically
impossible: `port = tileCol % ports_per_controller` binds tile columns to the
port axis, so a quarter turn would need one port to carry part of every column.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Orientation:
    """How logical framebuffer coordinates land on the wire.

    Applied in this order to a logical pixel `(x, y)`:

    1. `rotate_180` — the floor is entered from the opposite corner.
    2. `mirror_x` — the grid is handed the other way about the vertical axis.
    3. `reverse_columns_per_controller` — each controller's ports are cabled
       from its far end, so its tile columns run backwards. This permutes whole
       tile columns within one controller's group; it does not mirror pixels
       inside a tile, and it never moves a column across a controller boundary.
    """

    rotate_180: bool = False
    mirror_x: bool = False
    reverse_columns_per_controller: bool = False

    @property
    def is_identity(self) -> bool:
        return not (self.rotate_180 or self.mirror_x or self.reverse_columns_per_controller)

    def to_wire(self, config, x: int, y: int) -> tuple[int, int]:
        """Logical pixel -> the wire coordinate the vendor mapping should use."""
        if self.rotate_180:
            x = config.width_px - 1 - x
            y = config.height_px - 1 - y
        if self.mirror_x:
            x = config.width_px - 1 - x
        if self.reverse_columns_per_controller:
            tile_px = config.type.tile_px
            ports = config.type.ports_per_controller
            tile_col, within = divmod(x, tile_px)
            controller, port = divmod(tile_col, ports)
            port = config.ports_on(controller) - 1 - port
            x = (controller * ports + port) * tile_px + within
        return x, y

    def describe(self) -> str:
        if self.is_identity:
            return "identity"
        parts = []
        if self.rotate_180:
            parts.append("rotate180")
        if self.mirror_x:
            parts.append("mirrorX")
        if self.reverse_columns_per_controller:
            parts.append("reverseColumnsPerController")
        return "+".join(parts)

    def to_json(self) -> dict[str, bool]:
        return {
            "rotate180": self.rotate_180,
            "mirrorX": self.mirror_x,
            "reverseColumnsPerController": self.reverse_columns_per_controller,
        }

    @classmethod
    def parse(cls, spec: str) -> "Orientation":
        """Parse a `+`-separated spec, e.g. `rotate180+mirrorX`."""
        aliases = {
            "identity": (),
            "none": (),
            "0": (),
            "rotate180": ("rotate_180",),
            "180": ("rotate_180",),
            "mirrorx": ("mirror_x",),
            "mirror": ("mirror_x",),
            "reversecolumnspercontroller": ("reverse_columns_per_controller",),
            "reversecolumns": ("reverse_columns_per_controller",),
        }
        flags: dict[str, bool] = {}
        for token in spec.split("+"):
            key = token.strip().lower().replace("_", "").replace("-", "")
            if not key:
                continue
            if key not in aliases:
                raise ValueError(f"unknown orientation token {token!r}")
            for name in aliases[key]:
                flags[name] = True
        return cls(**flags)


#: What Ledset itself does: no transform at all, and what this project sends —
#: `CLAUDE.md` settles orientation as `identity`, permanently, because the floor
#: is cabled left-to-right and monotonically. The non-identity flags above stay
#: as the cabling knob for a floor that is patched differently, and as the
#: non-trivial permutations `test_invariants` runs the packing bijection over.
IDENTITY = Orientation()
