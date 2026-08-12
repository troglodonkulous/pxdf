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
UDP broadcast -> 255.255.255.255:60001
packet = FF | controller | 01 | port | packetIndex(|0x80 on frame end) | body
body   = BGR, 507 bytes max; each port's last packet is short
port   = one tile column; 4 or 8 ports per controller (floor-type dependent)
```

The vendor sends at 10 fps. **We do not** — the floor was measured at
10/15/24/30/60 and drops frames at none of them, so `DEFAULT_FPS = 30`. See
`docs/RUNSHEET-10x5-4P.md` §11.

**The mapper is now geometry-independent.** `mapper/` is a Python
implementation covering any legal floor type, tile-column and tile-row
combination, rather than the single 8 × 5 `8x8_8P` layout the PowerShell sender
was written for. Its invariants hold across all 2,400 legal configurations, and
it reproduces Ledset's own captured frames byte for byte. See
[`mapper/README.md`](mapper/README.md).

The three things code could not answer are now closed, none of them
architectural:

- **Orientation** — on the 2026-08-06 rig, logical `(0,0)` was the bottom-right
  tile: a pure 180° rotation. That is a fact about one rig's cabling, not about
  the hardware, and that rig has since been re-patched. It stays a parameter
  with no default.
- **End-of-frame flag** — **required**. It is the frame latch; without it the
  controller never displays a completed frame.
- **966-byte packet** — never appeared across 7,725 captured packets. Not ours,
  not needed, ignore it.

Evidence: [`docs/CAPTURE_RESULTS.md`](docs/CAPTURE_RESULTS.md) and
[`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md).

## Goal

Reliable, seamless playback from a Mac to the floor, driven by a cue-based
macOS app. Transport is done; the app is next — see
[`docs/APP-PLAN.md`](docs/APP-PLAN.md). Live inputs (Resolume via Syphon, NDI)
come after that.

**Shop rig (since 2026-08-07):** 10 × 5 tiles, floor type `8x8_4P`, **three
controllers** daisy-chained `OUTPUT` → `INPUT`, with Device Order set on each.
The last controller is partial — it drives 2 of its 4 ports. This is the
acceptance geometry; nothing before it exercised multiple controllers or a
partial one.

**Job rig:** 10 × 12 tiles of `8x8_4P` = 80 × 96 px. Same controller topology —
three units, ports 4/4/2 — but five packets per port instead of two. Every
number for it is derived from `mapper plan`; none has been seen on hardware.

**Target rig:** up to 14 × 10 tiles, plus arbitrary smaller *rectangular*
layouts. Controller count is not chosen — it is
`ceil(tileColumns / portsPerController)`, exactly as the vendor derives it.
Irregular layouts are shelved; `docs/APP-PLAN.md` says why.

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
| [`mapper/README.md`](mapper/README.md) | **The geometry-independent mapper.** Python. Packet plans, payloads, fixtures, capture diffs. |
| [`docs/APP-PLAN.md`](docs/APP-PLAN.md) | **The app plan.** Stack, render pipeline, build order. Supersedes plan steps 4–6 below. |
| `docs/REQUIREMENTS-v1.pdf` | Feature scope, with the operator's annotations. Wins over the mockups where they disagree. |
| `design/` | The mockups, the design system and its tokens. `design/mockups.html` is the visual spec. |
| `fixtures/` | Conformance fixtures. Manifests for every fixture config, golden byte dumps for five. Any reimplementation of the mapping is graded against these. |
| `tools/Send-FloorTest.ps1` | Fallback sender (PowerShell), 8×8 floor types. Deliberately dumb: raw protocol, no orientation transform. `-DryRun` prints the packet plan. |
| `tools/ledset/set-config.ps1` | Drives Ledset's mapper page to one geometry via UI Automation. |
| `tools/ledset/sweep.ps1` | Batches that across many geometries, ~1.3 s each including a screenshot. |
| `tools/New-PatternAvi.ps1` | Generates Ledset-loadable uncompressed AVI patterns (Windows). |
| `tools/Test-LedsetCanLoad.ps1` | Checks a pattern against Ledset's own two load gates without launching it. |
| `tools/make_test_patterns.py` | Generates test media for any tile layout (macOS/Python). |
| `test-patterns/` | Pre-rendered media at 64 × 40. **AVI only for Ledset** — it has no image code path. |
| `decompiled/` | Vendor decompiler output. Reference only — never a source for our code. |
| `captures/` | Packet captures from hardware sessions. Tracked for cross-machine development. |
| `reference/ledset-diagrams/` | Ledset's rendered wiring diagrams across floor types. Reference for a future generator. |

Superseded, kept for provenance: `docs/CAPTURE_PLAN.md` (the session it planned
is done — see `CAPTURE_RESULTS.md`), `docs/WINDOWS_BRIEF.md`,
`docs/WINDOWS_REPLY_1.md`, `docs/WINDOWS_REPORT_2.md`.

```bash
# regenerate test media for a different floor
python tools/make_test_patterns.py --cols 14 --rows 10 --out test-patterns-14x10

# what would we put on the wire for the current rig?
python -m mapper plan --type 8x8_4P --cols 10 --rows 5

# does a capture match what we would have sent?
python -m mapper verify captures/02-white.pcapng --type 8x8_8P --cols 8 --rows 5 --pattern white
```

> `python3` is the Microsoft Store stub on the Windows machine and will fail.
> Use `python` or `py`.

## Plan

1. ~~Settle the mapping~~ ✅ **Done** — read from the vendor's code.
2. ~~Verify at the floor~~ ✅ **Done 2026-08-06** — spec confirmed end-to-end,
   our sender byte-identical to the vendor's. See `CAPTURE_RESULTS.md`.
3. ~~Generalise the mapping to any geometry~~ ✅ **Done** — `mapper/`, invariants
   green across all 2,400 legal configurations and byte-identical to Ledset's
   captures.
4. ~~Engine + CLI~~ ✅ **Done 2026-08-08** — and **not in Swift**. `mapper play`
   beat Ledset on the wire (80/80 frames exact against 68/72), so the Python
   mapper *is* the engine. Ledset went reference-only the same session.
   Orientation settled as `identity`, permanently.
5. **The app** ← *current*. Electron + TypeScript + React wrapping `mapper/` as
   a sidecar process, built from `design/mockups.html` to
   `docs/REQUIREMENTS-v1.pdf`. **Read [`docs/APP-PLAN.md`](docs/APP-PLAN.md)
   before writing any of it** — it holds the render pipeline, the geometry
   rules, the gates and the build order. Lives in `app/`.
6. **Live inputs** — NDI and Syphon, as a helper process speaking the same
   sidecar frame protocol. Deferred, not blocked.

> **Superseded 2026-08-11.** Steps 4 and 5 previously called for a Swift package
> graded against `fixtures/`, then a SwiftUI GUI. That predates `mapper play`
> beating Ledset on the wire. `docs/APP-PLAN.md` records the reasoning; do not
> restart the port.

## Show-night fallback

The controller has a DMX512 XLR input, entirely independent of this software.
A DMX line from the lighting console is the designed-in hard override, and the
IR remote + SD-card programs are the panic button. Neither depends on this app
running.

## Reference material

`reference/` holds vendor artifacts (mapper XML, configs, release notes).
`decompiled/` holds decompiler output — tracked so both machines share the same
evidence, still reference only.
`captures/` holds session `.pcapng` files and related dumps from hardware
verification.

## Legal posture

Interoperability reverse engineering of hardware the company owns. Vendor
binaries are read for protocol facts only; implementation is written from the
written spec in `docs/PROTOCOL.md`, **never** from decompiler output.
`decompiled/` is evidence, not a source tree — describe behaviour in the written
spec instead of pasting from it.
