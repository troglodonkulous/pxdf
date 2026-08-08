"""The config list -- what the harness runs, one entry per row of the report.

A JSON file: either a bare array of entries, or `{"configs": [...]}`. Each
entry maps 1:1 onto a floor geometry plus what pattern it should be showing,
so the same list doubles as documentation of a capture session's plan.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mapper.floors import FloorConfig
from mapper.orientation import Orientation


@dataclass(frozen=True)
class OracleConfig:
    """One row of the config list.

    `capture` is the dry-run source: a `*.pcapng` path, relative to the repo
    root, holding a real (or previously captured) transmission of `pattern`
    at this geometry. It is `None` for a config that has no capture yet --
    the harness still emits a row for it, marked as blocked rather than
    silently skipped, which is the honest way to represent "this geometry
    has no oracle" (`mapper/README.md`'s own soft spot #3).

    `max_tolerated` is how many frames of this capture may be written off as a
    known Ledset defect. It **must be measured, per capture, and justified in
    `notes`** -- it is the bound that stops "explained" from being an unbounded
    output counter, and an unbounded tolerance is how a mapping fault gets
    laundered into a PASS. It defaults to **0** on purpose: a new config gets no
    budget until someone has looked at the capture and written the number down.
    """

    name: str
    type: str
    cols: int
    rows: int
    pattern: str = "white"
    orientation: str = "identity"
    eof: bool = True
    capture: str | None = None
    tile_col: int = 0
    tile_row: int = 0
    max_tolerated: int = 0
    notes: str = ""

    @property
    def floor_config(self) -> FloorConfig:
        return FloorConfig.of(self.type, self.cols, self.rows)

    @property
    def orientation_obj(self) -> Orientation:
        return Orientation.parse(self.orientation)


def load(path: str | Path) -> list[OracleConfig]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = data["configs"] if isinstance(data, dict) else data
    known = {f.name for f in OracleConfig.__dataclass_fields__.values()}
    out = []
    for i, entry in enumerate(entries):
        unknown = set(entry) - known
        if unknown:
            raise ValueError(f"config list entry {i}: unknown field(s) {sorted(unknown)}")
        out.append(OracleConfig(**entry))
    return out
