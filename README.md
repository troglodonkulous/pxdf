# ddf — Distinctive Dance Floor

Control software for a TOP Dance TP-878 pixel LED dance floor: a
geometry-independent sender that speaks the controller's native UDP protocol
directly, plus the macOS app that drives it. It replaces the vendor's Ledset
software, which has been reference-only here since 2026-08-08.

**The name.** `ddf` is *Distinctive Dance Floor*. The floor belongs to
**Distinctive Event Solutions**, the event-production company this is built for
and at; the name is theirs, not a description of the hardware.

## Status

**Protocol solved and verified on hardware.** `screenSend.dll` was decompiled in
full, so the wire format, pixel mapping, and framing were read directly from the
vendor's own transmit path — then confirmed against the real rig on 2026-08-06,
where our sender's output was byte-for-byte identical to Ledset's across a full
frame.

```
UDP broadcast -> 255.255.255.255:60001
packet = FF | controller | 01 | port | packetIndex(|0x80 on frame end) | body
body   = BGR, 507 bytes max; each port's last packet is short
port   = one tile column; 4 or 8 ports per controller (floor-type dependent)
```

The vendor sends at 10 fps. **We do not** — the floor was measured at
10/15/24/30/60 and drops frames at none of them, so `DEFAULT_FPS = 30`. See
`docs/RUNSHEET-10x5-4P.md` §11.

**`mapper/` is the engine, and it is geometry-independent.** A Python
implementation covering any legal floor type, tile-column and tile-row
combination, rather than the single 8 × 5 `8x8_8P` layout the original
PowerShell sender was written for. Its invariants hold across all 2,400 legal
configurations, it reproduces Ledset's own captured frames byte for byte, and on
2026-08-08 `mapper play` beat Ledset on the wire — **80/80 frames exact with 0
tolerated defects, against Ledset's 68/72 with 4**. That session is what made
the Python mapper the engine instead of a step toward one. See
[`mapper/README.md`](mapper/README.md).

**The app is in progress.** Electron + TypeScript + React in `app/`, driving
`mapper/` as a sidecar process. Three of its seven PRs have merged: `mapper
stream`, the app shell with the one composite pass, and the Play surface (cue
stack, GO, transport, Live/Preview, BLACKOUT, Master). The Mapping surface is
next — see [`docs/APP-PLAN.md`](docs/APP-PLAN.md), which is the app's only plan.

The three things code could not answer are closed, none of them architectural:

- **Orientation** — **`identity`, permanently.** On the 2026-08-06 rig, logical
  `(0,0)` was the bottom-right tile, a pure 180° rotation; that was a fact about
  one rig's cabling and that rig has since been re-patched left-to-right.
  `mapper/orientation.py` remains as *cabling compensation* for a mis-patched
  floor. It is not a feature, and it is not the app's Rotation control.
- **End-of-frame flag** — **required**. It is the frame latch; without it the
  controller never displays a completed frame.
- **966-byte packet** — never appeared across 7,725 captured packets. Not ours,
  not needed, ignore it.

Evidence: [`docs/CAPTURE_RESULTS.md`](docs/CAPTURE_RESULTS.md) and
[`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md).

## Goal

Reliable, seamless playback from a Mac to the floor, driven by a cue-based macOS
app. Transport is done; the app is what remains. Live inputs (Resolume via
Syphon, NDI) come after that, as a helper process speaking the same sidecar
frame protocol — deferred, not blocked.

**Shop rig (since 2026-08-07):** 10 × 5 tiles, floor type `8x8_4P`, 80 × 40 px,
**three controllers** daisy-chained `OUTPUT` → `INPUT` with Device Order set on
each. The last controller is partial — it drives 2 of its 4 ports. This is the
acceptance geometry; nothing before it exercised multiple controllers or a
partial one.

**Job rig:** 10 × 12 tiles of `8x8_4P` = **80 × 96 px**. Same controller
topology — three units, ports 4/4/2 — but five packets per port instead of two:
50 packets and 23,290 bytes per frame. Every number for it is derived from
`mapper plan`; none has been seen on hardware, and twelve tiles deep per chain
is not rehearsed by the shop rig.

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

A third is a property of the hardware rather than of Ledset: **stopping the send
does not black the floor.** In Master/IR mode, controller 1 times out ~5 s after
packets stop and reverts to its local content, while controllers 2 and 3 hold
the last frame forever; controller 1 can also run in slave mode, in which case
it holds its last frame too. Either way, BLACKOUT, cue gaps and idle therefore
all send *black frames*, and the socket opens with the show file and never
closes.

## Try it

```bash
# what would we put on the wire for the current rig?
python -m mapper plan --type 8x8_4P --cols 10 --rows 5

# the cutover's whole grade: a clip decoded and a pattern generated must agree
# byte for byte. These two must print the same digest.
python -m mapper play test-patterns/09-gradient24-8x8_4P-10x5.avi \
    --type 8x8_4P --cols 10 --rows 5 --dry-run | tail -1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 --dry-run | tail -1
#   -> 10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057

# does a capture match what we would have sent?
python -m mapper verify captures/02-white.pcapng --type 8x8_8P --cols 8 --rows 5 --pattern white

# convert real media to a clip the floor's geometry accepts (needs ffmpeg)
python -m tools.make_clip "input.mp4" out.avi --type 8x8_4P --cols 10 --rows 5

# the app
cd app && npm install && npm run dev
```

`CLAUDE.md` holds the full verification bar — every suite that must be green
before anything here is claimed done. All of it runs off-hardware.

> On the Windows machine `python3` is the Microsoft Store stub and will fail —
> use `python` or `py`. On the Mac, where the app work happens, `python3` is
> fine.

## Docs

| File | Purpose |
|---|---|
| `CLAUDE.md` | **Read first.** The verification bar, the settled decisions, the traps, and this project's one failure mode. |
| [`docs/POSTMORTEMS.md`](docs/POSTMORTEMS.md) | The ten times a result looked right and was not. Read it *before believing* a result, not after. |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | **The spec.** Build against this. Claims marked confirmed / likely / open / refuted. §3–§4 closed. |
| [`docs/DECOMP_FINDINGS.md`](docs/DECOMP_FINDINGS.md) | Evidence behind the spec, cited to vendor function names. |
| [`docs/CAPTURE_RESULTS.md`](docs/CAPTURE_RESULTS.md) | **Hardware verification, 2026-08-06.** Wire captures + floor observations; closes Q1–Q4. |
| [`docs/RUNSHEET-10x5-4P.md`](docs/RUNSHEET-10x5-4P.md) | The hardware sessions themselves. §10 gate-4 tables and §11 Phase 4 media are what every hardware claim here cites. |
| [`docs/APP-PLAN.md`](docs/APP-PLAN.md) | **The app plan, and the app's only copy.** Stack, render pipeline, build order, gates, traps. Supersedes plan steps 4–6 below. |
| [`docs/MAPPING-DIAGRAM.md`](docs/MAPPING-DIAGRAM.md) | The wiring diagram's rules, so PR 3 needs no trip back into `decompiled/`. |
| [`docs/HARDWARE-TILE-DEFECT.md`](docs/HARDWARE-TILE-DEFECT.md) | The four orange tiles: sagging 5 V rails, why no software gain can correct them, and why calibration was reverted in full. |
| [`docs/PRE-PROBE.md`](docs/PRE-PROBE.md) | What to settle before a hardware session, so floor time is spent measuring. |
| [`docs/ORACLE_HARNESS.md`](docs/ORACLE_HARNESS.md) | The capture-and-grade harness: configs, budgets, and what `--live` refuses to do. |
| [`docs/DELEGATION.md`](docs/DELEGATION.md) | Handing work to Codex — builder, critic, any `--write` task. |
| `docs/REQUIREMENTS-v1.pdf` | Feature scope, with the operator's annotations. Wins over the mockups where they disagree. |
| [`mapper/README.md`](mapper/README.md) | **The engine.** Packet plans, payloads, fixtures, capture diffs, the frame-rate/scaler/fit findings. |
| [`app/README.md`](app/README.md) | The Electron app: dev server, sidecar environment, the commands its gates run. |
| `design/` | The mockups, the design system and its tokens. `design/mockups.html` is the visual spec — and renders a superset of what ships. |
| `fixtures/` | Conformance fixtures. Manifests for every fixture config, golden byte dumps for five. Any reimplementation of the mapping is graded against these. |
| `tools/oracle/` | The oracle harness — captures a sender on the wire and grades it against the mapper's plan. |
| `tools/make_clip.py` | Converts real media to an uncompressed AVI at the floor's exact geometry. Needs ffmpeg. |
| `tools/Send-FloorTest.ps1` | Fallback sender (PowerShell), 8×8 floor types. Deliberately dumb: raw protocol, no orientation transform. Its value is being an *independent* second implementation — **do not modify it**, and pass `-PortsPerController 4` on this rig. |
| `tools/ledset/set-config.ps1` | Drives Ledset's mapper page to one geometry via UI Automation. |
| `tools/ledset/sweep.ps1` | Batches that across many geometries, ~1.3 s each including a screenshot. |
| `tools/Test-LedsetCanLoad.ps1` | Checks a pattern against Ledset's own two load gates without launching it. |
| `tools/oracle/make-gradient-avi.ps1` | Generates a Ledset-loadable uncompressed AVI of `gradient24` at any geometry. The only pattern generator left — see `test-patterns/README.md`. |
| `test-patterns/` | Pre-rendered media. `01`–`08` are **64 × 40**, for the retired 8 × 5 rig, and `play` rejects them on this floor; only `09` and `10` are 80 × 40. **AVI only for Ledset** — it has no image code path. |
| `captures/` | Packet captures from hardware sessions. Tracked, on purpose: they are evidence. |
| `decompiled/` | Vendor decompiler output. Reference only — never a source for our code, and it has misled this project before. |
| `reference/ledset-diagrams/` | Ledset's rendered wiring diagrams across floor types. Reference for the Mapping surface's generator. |

Superseded, kept for provenance: `docs/CAPTURE_PLAN.md` (the session it planned
is done — see `CAPTURE_RESULTS.md`), `docs/WINDOWS_BRIEF.md`,
`docs/WINDOWS_REPLY_1.md`, `docs/WINDOWS_REPORT_2.md`.

## Plan

1. ~~Settle the mapping~~ ✅ **Done** — read from the vendor's code.
2. ~~Verify at the floor~~ ✅ **Done 2026-08-06** — spec confirmed end-to-end,
   our sender byte-identical to the vendor's. See `CAPTURE_RESULTS.md`.
3. ~~Generalise the mapping to any geometry~~ ✅ **Done** — `mapper/`, invariants
   green across all 2,400 legal configurations and byte-identical to Ledset's
   captures.
4. ~~Engine + CLI~~ ✅ **Done 2026-08-08** — and **not in Swift**. `mapper play`
   beat Ledset on the wire, so the Python mapper *is* the engine. Ledset went
   reference-only the same session. Orientation settled as `identity`,
   permanently.
5. **The app** ← *current*. Electron + TypeScript + React wrapping `mapper/` as
   a sidecar process, built from `design/mockups.html` to
   `docs/REQUIREMENTS-v1.pdf`. **Read [`docs/APP-PLAN.md`](docs/APP-PLAN.md)
   before writing any of it** — it holds the render pipeline, the geometry
   rules, the gates and the build order. Lives in `app/`.

   | PR | Scope | State |
   |---|---|---|
   | B · `mapper-stream` | `mapper stream`, `--emit-digest` | ✅ merged |
   | 1 · `app-shell` | Electron + Vite + React, sidecar supervision, the one composite pass | ✅ merged |
   | 2 · `app-player` | Play surface: cue stack, GO, transport, Live/Preview, BLACKOUT, Master | ✅ merged |
   | 3 · `app-mapping` | Mapping surface: floor type/size, wiring diagram, NIC picker, Rotation. Geometry becomes a runtime variable end to end | ← next |
   | 4 · `app-compositor` | Layer stack, normalised transforms, colour adjustment, timeline, speed/loop, fades | |
   | 5 · `app-generators` | Generators, text, auto-fit, cue rotate/mirror, project files + crash recovery | |
   | 6 · `app-hardening` | Packaging, codesign, notarize, failure drills | |

6. **Live inputs** — NDI and Syphon, as a helper process speaking the same
   sidecar frame protocol. Deferred, not blocked.

> **Superseded 2026-08-11.** Steps 4 and 5 previously called for a Swift package
> graded against `fixtures/`, then a SwiftUI GUI. That predates `mapper play`
> beating Ledset on the wire. `docs/APP-PLAN.md` records the reasoning; do not
> restart the port.

### Declined, on purpose

- **Colour calibration.** Built, merged and reverted in full on 2026-08-11. Four
  tiles read orange at high white, but the cause is a sagging 5 V rail on each
  tile's own buck converter, so the gain a correction would need is
  load-dependent and no per-region constant can track it. See
  `docs/HARDWARE-TILE-DEFECT.md`.
- **Orientation as a feature.** Settled at `identity`; the floor is cabled
  left-to-right. The app's Rotation is a *presentation* transform in the
  compositor and must never be merged with it.
- **Irregular floor layouts.** Rectangles only.

## Show-night fallback

The controller has a DMX512 XLR input, entirely independent of this software. A
DMX line from the lighting console is the designed-in hard override, and the IR
remote + SD-card programs are the panic button. Neither depends on this app
running.

Two operating rules that are not software: power down all three controllers
before moving any data cable, and **never run Ledset and either sender at the
same time**.

## Reference material

`reference/` holds vendor artifacts (mapper XML, configs, release notes).
`decompiled/` holds decompiler output — tracked so both machines share the same
evidence, still reference only.
`captures/` holds session `.pcapng` files and related dumps from hardware
verification.

Large media (`test-patterns/Test Clips/`, ~188 MB) and `tools/oracle/out/` are
gitignored. Captures and test-pattern AVIs under ~1 MB **are** tracked, on
purpose — they are evidence.

## Legal posture

Interoperability reverse engineering of hardware the company owns. Vendor
binaries are read for protocol facts only; implementation is written from the
written spec in `docs/PROTOCOL.md`, **never** from decompiler output.
`decompiled/` is evidence, not a source tree — describe behaviour in the written
spec instead of pasting from it.
