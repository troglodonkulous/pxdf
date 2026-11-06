# pxdf — pixel dance floor

Control software for a TOP Dance TP-878 pixel LED floor: a geometry-independent
sender speaking the controller's UDP protocol directly, and a macOS Electron app
that drives it. It replaces the vendor's Ledset software.

## What was hard, and how it was verified

The wire protocol was reverse-engineered from the vendor's binaries, decompiled
for interoperability. The decompiler output is not published; the written
specification is [docs/PROTOCOL.md](docs/PROTOCOL.md), with evidence in
[docs/DECOMP_FINDINGS.md](docs/DECOMP_FINDINGS.md). On 2026-08-06, the sender's
output was byte-identical to the vendor's own sender across a full frame on
hardware ([capture results](docs/CAPTURE_RESULTS.md)).

```text
UDP broadcast -> 255.255.255.255:60001
packet = FF | controller | 01 | port | packetIndex(|0x80 on frame end) | body
body   = BGR, 507 bytes max; each port's last packet is short
port   = one tile column; 4 or 8 ports per controller (floor-type dependent)
```

The Python mapper checks its invariants across all 2,400 legal configurations
and reproduces captured vendor frames byte for byte. On 2026-08-08, `mapper play`
beat Ledset on the wire with the same content and geometry: **80/80 frames exact,
0 tolerated defects**, against Ledset's **68/72 exact, 4 tolerated** (three
loop-boundary blanks and one torn frame). The captures and grading are recorded
in [the runsheet](docs/RUNSHEET-10x5-4P.md), §11, P4-7; the invariant checks are
explained in [mapper/README.md](mapper/README.md).

## Status

At this HEAD, the protocol and CLI sender are hardware-verified. The Electron,
TypeScript and React app drives `mapper/` as a Python sidecar. Play and Mapping
are implemented: cue stack, GO, transport, Live/Preview, BLACKOUT, Master,
runtime floor geometry, jack-level wiring diagram, NIC selection and Rotation.
Packaging and later media, error-reporting, network-recovery and cadence work
have also merged. The planned layer editor/compositor, generators, project-file
saving and crash recovery remain unfinished; see [the app plan](docs/APP-PLAN.md).

The app ran its first real show on 2026-09-05, with a 10 × 10 tile floor
(80 × 80 px). The show succeeded with operator workarounds for playback
failures; it was not a clean reliability pass, and its exact build was not
recorded. [docs/JOBS.md](docs/JOBS.md) keeps the record and limitations.
Arrival-paced streaming is opt-in and still awaits a floor capture; the default
remains clock-paced. The app plan also records that unattended operation for
hours has not been soak-tested.

## Try it, no hardware needed

Run from the repository root. `mapper/` uses Python 3.12 and the standard
library only. No ffmpeg is needed for these commands; `tools/make_clip.py`
requires it when converting other media to floor-sized uncompressed AVI.
The app needs Node.js and npm; development sends to localhost by default.

```bash
# Packet plan for the shop rig.
python3 -m mapper plan --type 8x8_4P --cols 10 --rows 5

# Decode the tracked clip and generate the same pattern independently.
python3 -m mapper play tools/oracle/media/09-gradient24-8x8_4P-10x5.avi \
    --type 8x8_4P --cols 10 --rows 5 --dry-run | tail -1
python3 -m mapper send --type 8x8_4P --cols 10 --rows 5 \
    --pattern gradient24 --dry-run | tail -1
# Both frame-0 digests: 10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057

# Compare a tracked capture against the sender's expected bytes.
python3 -m mapper verify captures/20-ours-white.pcapng \
    --type 8x8_8P --cols 8 --rows 5 --pattern white

# Check invariants over all legal geometries.
python3 -m mapper matrix

# Grade stored captures; dry-run is the default, with no network access.
python3 -m tools.oracle.harness run --only 02-white --only 20-ours-white \
    --json-out /tmp/pxdf-oracle-report.json

# Launch the macOS app in development mode.
cd app && npm ci && npm run dev
```

The harness example grades a vendor capture with its measured defect budget
and a clean sender capture. Its unfiltered default list also includes a row
without a capture, which reports an error in dry-run mode.

## How this repo works

[CLAUDE.md](CLAUDE.md) is the working agreement for the AI coding agents used to
build this project: the verification bar, decision index and traps.
[docs/DECISIONS.md](docs/DECISIONS.md) holds every standing decision and what
would reopen it. [docs/POSTMORTEMS.md](docs/POSTMORTEMS.md) records the times a
result looked right and was not.

## Docs

| File | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Working agreement and verification bar. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Standing decisions, evidence and reopening conditions. |
| [docs/POSTMORTEMS.md](docs/POSTMORTEMS.md) | Failures in implementation and verification. |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Wire specification with confidence labels. |
| [docs/DECOMP_FINDINGS.md](docs/DECOMP_FINDINGS.md) | Protocol findings cited to vendor function names. |
| [docs/CAPTURE_RESULTS.md](docs/CAPTURE_RESULTS.md) | Hardware verification from 2026-08-06. |
| [docs/RUNSHEET-10x5-4P.md](docs/RUNSHEET-10x5-4P.md) | Hardware sessions, measurements and capture grades. |
| [docs/APP-PLAN.md](docs/APP-PLAN.md) | App architecture, scope, build order, gates and remaining work. |
| [docs/MAPPING-DIAGRAM.md](docs/MAPPING-DIAGRAM.md) | Written wiring-diagram specification used by the independent Mapping implementation. |
| [docs/JOBS.md](docs/JOBS.md) | Dated show records and their evidence. |
| [docs/HARDWARE-TILE-DEFECT.md](docs/HARDWARE-TILE-DEFECT.md) | Orange tiles, sagging power rails and the calibration revert. |
| [docs/PRE-PROBE.md](docs/PRE-PROBE.md) | Preparation for hardware sessions. |
| [docs/ORACLE_HARNESS.md](docs/ORACLE_HARNESS.md) | Capture grading, budgets and live-capture safeguards. |
| [docs/DELEGATION.md](docs/DELEGATION.md) | Agent task and review conventions. |
| [mapper/README.md](mapper/README.md) | Engine, CLI, conformance fixtures and verification. |
| [app/README.md](app/README.md) | Development commands and sidecar environment variables. |
| [design/](design/) | Mockups, design system and tokens; mockups include unimplemented features. |
| [fixtures/](fixtures/) | Conformance manifests, golden bytes and retained mapper XML. |
| [tools/oracle/](tools/oracle/) | Capture-and-grade harness. |
| [tools/make_clip.py](tools/make_clip.py) | ffmpeg-based conversion to floor-sized uncompressed AVI. |
| [tools/Send-FloorTest.ps1](tools/Send-FloorTest.ps1) | Independent fallback sender for 8×8 floor types; pass `-PortsPerController 4` for the shop rig. |
| [tools/ledset/set-config.ps1](tools/ledset/set-config.ps1) | Sets Ledset geometry through UI Automation. |
| [tools/ledset/sweep.ps1](tools/ledset/sweep.ps1) | Sweeps Ledset geometries and captures screenshots. |
| [tools/Test-LedsetCanLoad.ps1](tools/Test-LedsetCanLoad.ps1) | Checks media against Ledset's load gates. |
| [tools/oracle/make-gradient-avi.ps1](tools/oracle/make-gradient-avi.ps1) | Generates Ledset-loadable gradient media at a chosen geometry. |
| [test-patterns/](test-patterns/) | Generated test media; consult its README for dimensions. |
| [captures/](captures/) | Packet captures and logs retained as evidence. |
| [captures/measurements/README.md](captures/measurements/README.md) | Measurement methods, limitations and captured commit-ID mapping. |

## Rigs and hard requirements

The shop rig is 10 × 5 tiles of `8x8_4P`: 80 × 40 px, three controllers
chained OUTPUT → INPUT, using 4/4/2 ports. The deep test geometry is 10 × 12,
80 × 96 px, with the same port allocation but five packets per port: 50 packets
and 23,290 bytes per frame. That geometry has not run on hardware. The target
is up to 14 × 10 tiles and smaller rectangles; controller count is derived as
`ceil(tileColumns / portsPerController)`. Per-show geometries belong in the
dated [show records](docs/JOBS.md).

- **Gapless loops.** No blank frame at a loop boundary. Ledset's measured
  two-frame black gap was a sender defect, not a protocol requirement.
- **Double buffering.** The sender must not read a frame while it is being
  written; Ledset's shared capture buffer produced torn frames.
- **Black frames on idle.** Stopping packets does not black the floor.
  Controller 1 in Master/IR mode reverts to local content after about five
  seconds; in slave mode it holds its last frame, as controllers 2 and 3 do.
  BLACKOUT, cue gaps and idle must therefore keep sending black frames.

## Declined, on purpose

- **Colour calibration.** Reverted on 2026-08-11: the affected tiles' sagging
  5 V rails make the required correction load-dependent.
- **Orientation as a feature.** Identity is the settled wiring orientation;
  cabling compensation stays separate from the app's presentation Rotation.
- **Irregular layouts.** Rectangles only.

## Show-night fallback

The controller's DMX512 XLR input is independent of this software: a lighting
console supplies the hard override, with IR remote and SD-card programs as
fallbacks. Power down the controllers before moving data cables. Never run
Ledset and a project sender at the same time.

## Legal posture

Interoperability reverse engineering of hardware the operator owns. Vendor
binaries were read for protocol facts only; implementation was written from
the written specification in [docs/PROTOCOL.md](docs/PROTOCOL.md), never from
decompiler output. The decompiler output is not published.

## Naming

The project was called `ddf` until publication. Captured artifacts and dated
records in `captures/`, `docs/JOBS.md`, `docs/POSTMORTEMS.md` and
`docs/media-internals-capture.txt` keep that name because they are evidence.
The renamed PXDF Sender app uses a new settings location derived from its app
name, so an existing install starts with fresh settings for the selected network
interface and last media directory.

## Redactions

For publication, people's names and local user paths were replaced with
placeholders throughout history, including the show log and `docs/JOBS.md`.
Packet captures remain byte-exact and retain their capture-machine metadata.
Commit IDs changed; [captures/measurements/README.md](captures/measurements/README.md)
maps the old IDs cited in captured files to this history.

© 2026 Rob Maxey. All rights reserved for first-party code. Source published for
review. Third-party components are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
