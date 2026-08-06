# ddf — dance floor sender

macOS control software for a TOP Dance TP-878 pixel LED dance floor.
Speaks the controller's native UDP protocol directly.

## Status

**Protocol solved. Ready to build.** `screenSend.dll` compiled to MSIL and was
decompiled in full, so the wire format, pixel mapping, and framing are read
directly from the vendor's own transmit path — not inferred. See
[`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md).

```
UDP broadcast -> 255.255.255.255:60001, ~10 fps
packet = FF | controller | 01 | port | packetIndex(|0x80 on frame end) | body
body   = BGR, 507 bytes max; each port's last packet is short
port   = one tile column; 8 ports per controller (floor-type dependent)
```

Three things code could not answer, all resolved by one trip to the floor and
none of them architectural: physical orientation of logical `(0,0)`, whether the
end-of-frame flag is required to latch, and what emits a stray 966-byte packet.

## Goal

Reliable, seamless playback from a Mac to the floor. Content authoring
(Resolume via Syphon/NDI) comes after the transport works.

**Target rig:** up to 14 × 10 tiles, 2 controllers × 4 ports (master/slave),
plus arbitrary smaller layouts.

## Docs

| File | Purpose |
|---|---|
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | **The spec.** Build against this. Claims marked confirmed / likely / open / refuted. |
| [`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md) | Evidence behind the spec, cited to vendor function names. |
| [`docs/CAPTURE_PLAN.md`](docs/CAPTURE_PLAN.md) | Floor session — now verification, not discovery. |
| `tools/Send-FloorTest.ps1` | Reference implementation (PowerShell). `-DryRun` prints the packet plan for any geometry. |
| `tools/make_test_patterns.py` | Generates test media for any tile layout. |
| `test-patterns/` | Pre-rendered media (uncompressed AVI + PNG) at 64 × 40. |
| `decompiled/` | Vendor decompiler output. **Gitignored** — reference only, never a source for our code. |

Superseded, kept for provenance: `docs/WINDOWS_BRIEF.md`,
`docs/WINDOWS_REPLY_1.md`, `docs/WINDOWS_REPORT_2.md`.

```bash
# regenerate for a different floor
python3 tools/make_test_patterns.py --cols 14 --rows 10 --out test-patterns-14x10
```

## Plan

1. ~~Settle the mapping~~ ✅ **Done** — read from the vendor's code.
2. **Engine + CLI** ← *current*. Swift package: pixel mapper, UDP sender, test
   patterns. Orientation stays a parameter and the end-of-frame flag a toggle,
   so the floor visit tunes rather than redesigns.
3. **Verify at the floor** — `CAPTURE_PLAN.md`. One command should turn the
   floor white.
4. **GUI** — SwiftUI app wrapping the proven engine.
5. **Inputs** — Syphon first (zero-copy, same-machine), NDI second (cross-machine).

## Show-night fallback

The controller has a DMX512 XLR input, entirely independent of this software.
A DMX line from the lighting console is the designed-in hard override, and the
IR remote + SD-card programs are the panic button. Neither depends on this app
running.

## Reference material

`reference/` holds vendor artifacts (mapper XML, configs, release notes).
`decompiled/` holds decompiler output — on disk, gitignored.

## Legal posture

Interoperability reverse engineering of hardware the company owns. Vendor
binaries are read for protocol facts only; implementation is written from the
written spec in `docs/PROTOCOL.md`, **never** from decompiler output. That is
why `decompiled/` is gitignored: it is evidence, not a source tree.
