# ddf — dance floor sender

macOS control software for a TOP Dance TP-878 pixel LED dance floor.
Speaks the controller's native UDP protocol directly.

## Status

**Protocol solved and verified on hardware.** `screenSend.dll` was decompiled in
full, so the wire format, pixel mapping, and framing were read directly from the
vendor's own transmit path — then confirmed against the real rig on 2026-08-06.
Our PowerShell sender's output is **byte-for-byte identical** to Ledset's across
a full frame, and the floor responds to it correctly.

```
UDP broadcast -> 255.255.255.255:60001, ~10 fps
packet = FF | controller | 01 | port | packetIndex(|0x80 on frame end) | body
body   = BGR, 507 bytes max; each port's last packet is short
port   = one tile column; 8 ports per controller (floor-type dependent)
```

The three things code could not answer are now closed, none of them
architectural:

- **Orientation** — logical `(0,0)` is the bottom-right tile; a pure 180°
  rotation on this rig. Cabling-dependent, so it stays a parameter.
- **End-of-frame flag** — **required**. It is the frame latch; without it the
  controller never displays a completed frame.
- **966-byte packet** — never appeared across 7,725 captured packets. Not ours,
  not needed, ignore it.

Evidence: [`docs/CAPTURE_RESULTS.md`](docs/CAPTURE_RESULTS.md) and
[`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md).

## Goal

Reliable, seamless playback from a Mac to the floor. Content authoring
(Resolume via Syphon/NDI) comes after the transport works.

**Target rig:** up to 14 × 10 tiles, 2 controllers × 4 ports (master/slave),
plus arbitrary smaller layouts.

Two hard requirements come straight from watching the vendor software fail, both
sender-side bugs rather than protocol limits:

- **Gapless loops.** Ledset emits two all-black frames (~210 ms) at every clip
  boundary — the floor-goes-black-between-loops defect. Never emit a blank frame
  at a loop point.
- **Double buffering.** Ledset's send thread reads the capture buffer while the
  decoder is still writing it, so it ships torn frames. Ours must not.

## Docs

| File | Purpose |
|---|---|
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | **The spec.** Build against this. Claims marked confirmed / likely / open / refuted. |
| [`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md) | Evidence behind the spec, cited to vendor function names. |
| [`docs/CAPTURE_RESULTS.md`](docs/CAPTURE_RESULTS.md) | **Hardware verification, 2026-08-06.** Wire captures + floor observations; closes Q1–Q4. |
| `tools/Send-FloorTest.ps1` | Reference implementation (PowerShell). `-DryRun` prints the packet plan for any geometry. |
| `tools/New-PatternAvi.ps1` | Generates Ledset-loadable uncompressed AVI patterns (Windows). |
| `tools/Test-LedsetCanLoad.ps1` | Checks a pattern against Ledset's own two load gates without launching it. |
| `tools/make_test_patterns.py` | Generates test media for any tile layout (macOS/Python). |
| `test-patterns/` | Pre-rendered media at 64 × 40. **AVI only for Ledset** — it has no image code path. |
| `decompiled/` | Vendor decompiler output. **Gitignored** — reference only, never a source for our code. |

Superseded, kept for provenance: `docs/CAPTURE_PLAN.md` (the session it planned
is done — see `CAPTURE_RESULTS.md`), `docs/WINDOWS_BRIEF.md`,
`docs/WINDOWS_REPLY_1.md`, `docs/WINDOWS_REPORT_2.md`.

```bash
# regenerate for a different floor
python3 tools/make_test_patterns.py --cols 14 --rows 10 --out test-patterns-14x10
```

## Plan

1. ~~Settle the mapping~~ ✅ **Done** — read from the vendor's code.
2. ~~Verify at the floor~~ ✅ **Done 2026-08-06** — spec confirmed end-to-end,
   our sender byte-identical to the vendor's. See `CAPTURE_RESULTS.md`.
3. **Engine + CLI** ← *current*. Swift package: pixel mapper, UDP sender, test
   patterns. Build to the now-verified spec: 180° orientation as the default but
   still a parameter, end-of-frame flag always set, gapless loops, double
   buffering.
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
