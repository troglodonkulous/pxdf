# ddf — dance floor sender

macOS control software for a TOP Dance TP-878 pixel LED dance floor.
Speaks the controller's native UDP protocol directly.

## Status

**Pre-implementation.** Protocol is ~90% understood; one open question
(channel→physical mapping) blocks a working sender. See
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) §4.

## Goal

Reliable, seamless playback from a Mac to the floor. Content authoring
(Resolume via Syphon/NDI) comes after the transport works.

**Target rig:** up to 14 × 10 tiles, 2 controllers × 4 ports (master/slave),
plus arbitrary smaller layouts.

## Docs

| File | Purpose |
|---|---|
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Wire protocol spec. Every claim marked confirmed / likely / open / refuted. |
| [`docs/CAPTURE_PLAN.md`](docs/CAPTURE_PLAN.md) | Step-by-step packet-capture session at the floor. |
| [`docs/WINDOWS_BRIEF.md`](docs/WINDOWS_BRIEF.md) | Decompilation task, to hand to Claude Code on the Windows machine. |
| `test-patterns/` | Ready-to-play capture media (uncompressed AVI + PNG), pre-rendered at 64 × 40. |
| `tools/make_test_patterns.py` | Regenerates that media for any tile layout. |

```bash
# regenerate for a different floor
python3 tools/make_test_patterns.py --cols 14 --rows 10 --out test-patterns-14x10
```

## Plan

1. **Settle the mapping** — packet capture (`CAPTURE_PLAN.md`) + decompilation
   (`WINDOWS_BRIEF.md`), in parallel. Capture proves, decompilation explains.
2. **Engine + CLI** — Swift package: pixel mapper, UDP sender, test patterns.
   Debug against the real floor here, where the risk lives.
3. **GUI** — SwiftUI app wrapping the proven engine.
4. **Inputs** — Syphon first (zero-copy, same-machine), NDI second (cross-machine).

## Show-night fallback

The controller has a DMX512 XLR input, entirely independent of this software.
A DMX line from the lighting console is the designed-in hard override, and the
IR remote + SD-card programs are the panic button. Neither depends on this app
running.

## Reference material

`reference/` holds vendor artifacts (mapper XML, configs, release notes).
The vendor software, DLLs, and firmware images live on the USB volume and are
**the only copy** — back them up.

## Legal posture

Interoperability reverse engineering of hardware the company owns. Vendor
binaries are read for protocol facts only; implementation is written from the
written spec in `docs/PROTOCOL.md`, not from decompiler output.
