# `mapper/` — the geometry-independent mapper

Python implementation of `docs/PROTOCOL.md` for **any** legal floor: any floor
type, any tile-column count, any tile-row count. The PowerShell sender works for
exactly one layout; this works for all 2,400.

No dependencies. Python 3.12. On the Windows machine, `python3` is the Microsoft
Store stub and will fail — use `python` or `py`.

## Use

```bash
# what goes on the wire for the current rig
python -m mapper plan --type 8x8_4P --cols 10 --rows 5

# the invariant suite, over every legal geometry
python -m mapper matrix

# regenerate the conformance fixtures
python -m mapper fixtures --out fixtures

# a Ledset mapper XML, for driving the oracle without UI automation
python -m mapper xml --type 8x8_4P --cols 10 --rows 5 --out "…/Test 3.xml"

# diff a capture against what we would have sent
python -m mapper verify captures/02-white.pcapng \
    --type 8x8_8P --cols 8 --rows 5 --pattern white

# send. --dry-run prints the plan and touches nothing.
python -m mapper send --type 8x8_4P --cols 10 --rows 5 \
    --pattern gradient24 --duration 5 --dry-run
```

```bash
python -m unittest discover -t . -s mapper/tests    # ~19 s
```

## Layout

| Module | Holds |
|---|---|
| `floors.py` | Protocol constants, the four floor types with their scan tables, and every size derived from a `(type, cols, rows)`. |
| `plan.py` | The packet plan — headers, lengths and offsets for one frame, no payload. |
| `orientation.py` | The whole of the cabling freedom: `rotate180`, `mirrorX`, `reverseColumnsPerController`. |
| `frame.py` | Framebuffer ↔ send buffer ↔ datagrams, both directions. |
| `patterns.py` | Framebuffer sources, including the per-pixel-unique `gradient24`. |
| `pcapng.py` | Dependency-free capture reader, Ethernet/IPv4/UDP only. |
| `verify.py` | Capture-versus-expected diff, reported as a table. |
| `fixtures.py` | Conformance fixture generation. |
| `mapper_xml.py` | Ledset mapper XML, read and written. |
| `sender.py` | UDP broadcast, set up as `screenSend.dll` does. |

## What is checked, and against what

**Invariants**, over all 2,400 legal `(type, cols, rows)`:

- every logical pixel occupies exactly one `(controller, port, packet, offset)`,
  and every wire slot is filled — no holes, no padding, no collisions;
- each port's payload is tiled by its packets: contiguous, no gaps, no overlap,
  summing to `portDataSize`;
- exactly one end-of-frame flag per controller per frame, on the last packet of
  its last active port;
- no datagram exceeds 512 bytes, and the packet index never collides with the
  `0x80` flag;
- totals agree with the closed-form `packetsPerFrame` and `bytesPerFrame`.

**Against Ledset**, using the 2026-08-06 captures, which are the vendor's own
bytes:

- headers and lengths match our plan on every frame of five captures;
- our generated frame is byte-identical to Ledset's — 43 of 46 frames of
  `02-white`, with the other three being Ledset's two documented loop-boundary
  blanks and one documented torn frame;
- decoding Ledset's frames *back* through our mapping reproduces the picture the
  source video showed: `06-halves` is a clean vertical split, and every frame of
  `07-tilewalk` is exactly one fully lit, tile-aligned square.

That last check is the one that matters. A solid colour cannot detect a
permutation — every wrong mapping of a white frame is still a white frame. The
same sampling bias produced two earlier self-consistent-but-wrong conclusions
(the "512-byte packet" and "byte 4 always 0x00" findings). Fixtures therefore
use `gradient24`, which is unique per pixel.

## What is *not* proven

- **No multi-controller layout has ever touched hardware.** Everything above is
  invariants plus a single-controller oracle. The 10 × 5 `8x8_4P` rig is the
  acceptance geometry and has not been run.
- **Broadcast propagation through the controllers' daisy chain is unproven** —
  see `docs/PROTOCOL.md` §1. Verify it before concluding anything about mapping.
- **Orientation has never been exercised as a code path.** The 180° result in
  `CAPTURE_RESULTS.md` was observed with a tool that applies no transform, on a
  rig that has since been re-patched. It needs confirming in more than one
  cabling arrangement.
- **6 × 6 floor types are carried as data and are unsupported.** The transpose
  scan table is implemented and round-trips, but there is no 6 × 6 hardware, so
  no claim is made.

## Fixtures

`fixtures/` is the contract the eventual Swift engine is graded against.

- `manifests/*.json` — derived sizes, the full
  `(controller, port, packetIndex, byte4, length)` header table, and SHA-256
  over both the payload and the whole frame.
- `golden/*.bin` — full byte dumps for five configs, so a failing implementation
  can be diffed rather than merely told it is wrong.

The fixture set is **branch-targeted, not a sweep**: one controller exactly
full, a partial last controller on both 4P and 8P, the maximum of each type,
the minimum floor where the only packet is also the last, a port payload under
507 bytes, both orientation flags, and one 6 × 6 config. `test_fixtures.py`
regenerates them and fails on any drift, so a contract change shows up as a
reviewed diff.

## Relationship to `tools/Send-FloorTest.ps1`

At the floor, **Python is primary and the PS1 is the fallback**. The PS1 stays
exactly as it is — no orientation transform, no generalisation beyond what it
already has. Its value is that it is dumb: raw protocol, known byte-identical to
Ledset at 8 × 5 `8x8_8P`. Two independent implementations of the orientation
transform is how you get a discrepancy you cannot diagnose at 1am.
