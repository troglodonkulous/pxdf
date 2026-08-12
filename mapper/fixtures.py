"""Conformance fixtures — the contract any reimplementation of the mapping is
graded on.

Written when a Swift port of this module was the plan. That plan is retired —
`mapper/` is the engine, and the app drives it as a sidecar (`docs/APP-PLAN.md`)
— but the fixtures outlive it: they are still the only thing outside the 8 × 5
`8x8_8P` captures that would notice a tile column landing on the wrong port.

Tiered, because a full byte dump of every legal geometry is 2,400 files nobody
will read:

* **manifest** for each fixture config — derived sizes plus the full
  `(controller, port, packetIndex, byte4, length)` header table, and a SHA-256
  over the payload and over the whole frame. Cheap to store, exact to compare.
* **golden** byte dumps for a handful of configs, so a failing implementation
  can be diffed rather than merely told it is wrong.

The source pattern is `gradient24`, which is unique per pixel. A solid colour
would pass under any permutation of the mapping.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .floors import FloorConfig
from .frame import build_frame
from .orientation import IDENTITY, Orientation
from .patterns import PATTERNS
from .plan import build_plan

SCHEMA = "ddf-mapper-fixture/1"


class FixturesExist(Exception):
    """Raised rather than silently overwrite an existing fixture set."""


@dataclass(frozen=True)
class FixtureSpec:
    config: FloorConfig
    why: str
    golden: bool = False
    orientation: Orientation = IDENTITY
    pattern: str = "gradient24"

    @property
    def name(self) -> str:
        stem = f"{self.config.type.name}_{self.config.tile_cols}x{self.config.tile_rows}"
        if not self.orientation.is_identity:
            stem += "_" + self.orientation.describe()
        return stem


def fixture_specs() -> tuple[FixtureSpec, ...]:
    """Branch-targeted, not a broad sweep.

    The mapper *diagram* sweep is the cheap broad one; a packet oracle costs a
    capture per config, so these are chosen to cover the branches the send loop
    actually has.
    """
    return (
        FixtureSpec(
            FloorConfig.of("8x8_8P", 8, 5),
            "the 2026-08-06 capture rig — one controller, exactly full",
            golden=True,
        ),
        FixtureSpec(
            FloorConfig.of("8x8_4P", 10, 5),
            "the current rig — three controllers, partial last controller",
            golden=True,
        ),
        FixtureSpec(
            FloorConfig.of("8x8_4P", 10, 5),
            "the current rig with the controllers moved to the opposite end",
            orientation=Orientation(rotate_180=True),
            golden=True,
        ),
        FixtureSpec(
            FloorConfig.of("8x8_8P", 32, 11),
            "the maximum 8P floor — 4 controllers, packetsPerPort = 5",
            golden=True,
        ),
        FixtureSpec(
            FloorConfig.of("8x8_4P", 1, 1),
            "the minimum floor — one port, one packet, which is also the last",
            golden=True,
        ),
        FixtureSpec(FloorConfig.of("8x8_8P", 8, 2), "port payload under 507 bytes"),
        FixtureSpec(FloorConfig.of("8x8_8P", 9, 5), "partial last controller on an 8P floor"),
        FixtureSpec(FloorConfig.of("8x8_4P", 4, 5), "one controller, exactly full, 4P"),
        FixtureSpec(FloorConfig.of("8x8_4P", 32, 22), "the maximum 4P floor — 8 controllers"),
        FixtureSpec(
            FloorConfig.of("8x8_4P", 10, 5),
            "per-controller column reverse, on the partial-controller rig",
            orientation=Orientation(reverse_columns_per_controller=True),
        ),
        FixtureSpec(
            FloorConfig.of("6x6_4P", 7, 3),
            "6x6 transpose scan — carried as data, no hardware, unverified",
        ),
    )


def build_manifest(spec: FixtureSpec) -> tuple[dict, list[bytes]]:
    config = spec.config
    framebuffer = PATTERNS[spec.pattern](config)
    datagrams = build_frame(config, framebuffer, spec.orientation)
    plan = build_plan(config)

    payload = b"".join(d[5:] for d in datagrams)
    whole = b"".join(datagrams)

    manifest = {
        "schema": SCHEMA,
        "name": spec.name,
        "why": spec.why,
        "config": {
            "floorType": config.type.name,
            "typeIndex": config.type.type_index,
            "tileCols": config.tile_cols,
            "tileRows": config.tile_rows,
        },
        "derived": {
            "widthPx": config.width_px,
            "heightPx": config.height_px,
            "pixelCount": config.pixel_count,
            "portsPerController": config.type.ports_per_controller,
            "portDataSize": config.port_data_size,
            "packetsPerPort": config.packets_per_port,
            "controllerCount": config.controller_count,
            "lastControllerPortCount": config.last_controller_port_count,
            "packetsPerFrame": config.packets_per_frame,
            "bytesPerFrame": config.bytes_per_frame,
            "widthMm": config.width_mm,
            "heightMm": config.height_mm,
        },
        "orientation": spec.orientation.to_json(),
        "pattern": spec.pattern,
        "colorOrder": "BGR",
        "hardwareVerified": config.type.hardware_verified,
        "packets": [list(p.as_row()) for p in plan],
        "payloadSha256": hashlib.sha256(payload).hexdigest(),
        "frameSha256": hashlib.sha256(whole).hexdigest(),
    }
    return manifest, datagrams


def existing_fixtures(out_dir: str | Path) -> list[Path]:
    """Fixture files already present at `out_dir`."""
    out = Path(out_dir)
    found = list((out / "manifests").glob("*.json")) + list((out / "golden").glob("*.bin"))
    if (out / "index.json").exists():
        found.append(out / "index.json")
    return sorted(found)


def emit(out_dir: str | Path, force: bool = False) -> list[Path]:
    """Write every fixture. Returns the paths written, in order.

    Refuses to overwrite an existing set without `force`. See `FixturesExist`
    below for why that is worth a guard rather than a convenience.
    """
    out = Path(out_dir)
    present = existing_fixtures(out)
    if present and not force:
        raise FixturesExist(
            f"refusing to overwrite {len(present)} existing fixture file(s) in "
            f"{out.resolve()}.\n"
            "\n"
            "`fixtures/` is the only tripwire in the suite on the tile-to-port\n"
            "mapping. `test_fixtures` compares the committed bytes against what\n"
            "the mapper produces right now; at geometries the captures do not\n"
            "cover -- which is every geometry except 8x5 8x8_8P -- nothing else\n"
            "would notice a tile column placed on the wrong port or controller.\n"
            "Regenerating over a red `test_fixtures` converts the alarm into a\n"
            "silently updated contract, and the bug becomes the new baseline.\n"
            "\n"
            "If `test_fixtures` is failing, that is the alarm working. Read the\n"
            "diff in the mapper first. Only once the contract change is intended\n"
            "and reviewed:\n"
            "\n"
            f"    python -m mapper fixtures --out {out} --force\n"
            "\n"
            "and commit the fixture diff in the same change as the code that\n"
            "caused it, so a reviewer sees both."
        )

    (out / "manifests").mkdir(parents=True, exist_ok=True)
    (out / "golden").mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    index = []
    for spec in fixture_specs():
        manifest, datagrams = build_manifest(spec)
        path = out / "manifests" / f"{spec.name}.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        written.append(path)
        if spec.golden:
            golden = out / "golden" / f"{spec.name}.bin"
            golden.write_bytes(b"".join(datagrams))
            written.append(golden)
        index.append(
            {
                "name": spec.name,
                "why": spec.why,
                "golden": spec.golden,
                "frameSha256": manifest["frameSha256"],
            }
        )

    index_path = out / "index.json"
    index_path.write_text(
        json.dumps({"schema": SCHEMA, "fixtures": index}, indent=2) + "\n", encoding="utf-8"
    )
    written.append(index_path)
    return written
