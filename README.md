# pxdf — pixel dance floor

Show-control software for a TOP Dance TP-878 pixel LED dance floor, built to
replace the vendor's own. `pxdf` speaks the floor controllers' UDP protocol
directly — reverse-engineered from the vendor's binaries and verified
byte-for-byte on hardware — and wraps it in a cue-based macOS app that has run
a real eight-hour show.

It is two parts:

- **`mapper/`** — a geometry-independent sender engine in Python (standard
  library only). Given a floor type and a tile count, it plans, encodes and
  paces every packet the controllers need.
- **`app/`** — an Electron + TypeScript + React operator app: cue stack, GO,
  transport, Live/Preview, BLACKOUT, Master, a jack-level wiring diagram, NIC
  selection and rotation. It drives `mapper/` as a sidecar process.

Everything below runs without the floor. See [Try it yourself](#try-it-yourself).

<div align="center">
  <video src="https://github.com/user-attachments/assets/0a8ceace-bec8-4cd1-9aac-7c9842fb74a0"></video>
</div>

## The problem

The floor is a grid of 8 × 8-pixel LED tiles chained to small network
controllers. The only software that could drive it was the vendor's Windows
application, Ledset, and watching it fail at events set the requirements:

- **It goes black between loops.** Ledset sends two all-black frames (~210 ms)
  at every clip boundary. On a dance floor that is a visible flash every loop.
- **It tears frames.** Its send thread reads the capture buffer while the
  decoder is still writing it.
- **It is slow and rigid.** It sends at 10 fps, and the only alternative, a
  PowerShell sender, was written for a single 8 × 5 layout.
- **Nothing documents the protocol.** There was no published spec to build a
  replacement against.

The goal was reliable, seamless playback from a Mac, driven by a cue-based
show app, at any floor size the hardware allows.

## The solution

```
 macOS app (Electron + React)                     mapper (Python sidecar)
 ┌──────────────────────────────┐   raw RGB      ┌──────────────────────────┐   UDP broadcast
 │ cue stack · GO · Live/Preview│   frames on    │ packet plan for the floor │ ─────────────────▶ controllers
 │ composite at floor px × 8,   │ ─── stdin ───▶ │ type and tile count;      │   255.255.255.255   (1..n, daisy-
 │ downsample once              │                │ encode, latch, pace       │   :60001             chained)
 └──────────────────────────────┘                └──────────────────────────┘
```

The wire format, recovered and written up in [docs/PROTOCOL.md](docs/PROTOCOL.md):

```text
UDP broadcast -> 255.255.255.255:60001
packet = FF | controller | 01 | port | packetIndex(|0x80 on frame end) | body
body   = BGR, 507 bytes max; each port's last packet is short
port   = one tile column; 4 or 8 ports per controller (floor-type dependent)
```

What it does that the vendor software does not:

- **Any legal geometry.** Controller count, ports per controller and packets
  per port are derived, never assumed — the mapper's invariants are checked
  across all **2,400** legal floor configurations
  (`ceil(tileColumns / portsPerController)` controllers, exactly as the vendor
  derives them).
- **Gapless loops and double buffering.** No blank frame at a loop point, and no
  frame is read while it is being written.
- **Black frames on idle.** Stopping the send does *not* black the floor — one
  controller reverts to local content after ~5 s, the others hold their last
  frame — so BLACKOUT, cue gaps and idle all send black frames, and the socket
  opens with the show file and never closes.
- **30 fps by default**, measured on the floor at 10/15/24/30/60 with no
  dropped frames at any of them.

## How it was verified

Every claim in this repository is graded off-hardware by tooling in this
repository, and every hardware claim cites a dated session record.

- **Byte-identical to the vendor on hardware.** On 2026-08-06 our sender's
  output matched Ledset's own, byte for byte, across a full frame
  ([capture results](docs/CAPTURE_RESULTS.md)).
- **Beat the vendor on the wire.** On 2026-08-08, same content and geometry:
  `mapper play` **80/80 frames exact, 0 tolerated defects**; Ledset **68/72
  exact, 4 tolerated** (three loop-boundary blanks and one torn frame). Graded by
  the project's oracle harness, which captures a sender on the wire and compares
  every packet against the mapper's plan ([runsheet](docs/RUNSHEET-10x5-4P.md)
  §11, P4-7). That session made the Python mapper the engine and Ledset
  reference-only.
- **Conformance fixtures.** Manifests for every fixture configuration and golden
  byte dumps for five, so any reimplementation of the mapping can be graded
  ([fixtures/](fixtures/)).
- **One digest grades the cutover.** A clip decoded from disk and the same
  pattern generated in code must produce the same frame digest — at the shop
  rig's geometry and at a second, deeper one that catches packets-per-port
  assumptions.
- **An end-to-end gate for the app.** `app/test/e2e/wire.mjs` launches the built
  app, plays real cues and asserts on the UDP packets the sidecar actually
  sends, alongside the vitest unit suite.

## The process

**1. Reverse-engineering (early August 2026).** The vendor's transmit DLL and
application were decompiled for interoperability. Nothing was copied: what they
showed was written up as a specification with every claim labelled *confirmed /
likely / open / refuted*, and the code was written from that spec
([PROTOCOL.md](docs/PROTOCOL.md), [DECOMP_FINDINGS.md](docs/DECOMP_FINDINGS.md)).
The decompiler output is not published.

**2. Proving it on the floor.** Packet captures from the real rig (tracked in
[captures/](captures/)) confirmed the spec end to end and closed the open
questions — orientation, the end-of-frame latch, a 966-byte packet that never
appeared in 7,725 captured packets.

**3. Generalising.** The original sender handled one 8 × 5 layout. The mapper
was rebuilt to cover every floor type and size, then proven on a three-controller
rig with a partially used last controller — the first configuration to exercise
either.

**4. Choosing the app's architecture.** The plan was a Swift port of the
mapper. Once `mapper play` beat Ledset on the wire, porting proven code became
risk without benefit, so the app became Electron + TypeScript + React driving
the Python mapper as a sidecar ([DECISIONS.md](docs/DECISIONS.md) D-04, D-11).

**5. Saying no on evidence.** Colour calibration was built, merged and then
reverted in full: four tiles read orange at high white because of sagging 5 V
rails on the tiles' own converters, so the correction a gain would need is
load-dependent and no constant can track it
([HARDWARE-TILE-DEFECT.md](docs/HARDWARE-TILE-DEFECT.md)). Irregular layouts
and orientation-as-a-feature were declined the same way.

**6. A real show (2026-09-05).** The app ran an eight-hour event on a 10 × 10
tile floor. It succeeded — nobody in the room noticed a problem — but the
operator worked around a steady stream of playback failures all night. The
log recorded **483 heartbeats**, **46 of 320 live-cue attempts failing**, three
NIC dropouts that auto-recovered in ~2 s, and a renderer composing at 60 fps for
a sender consuming 30 ([JOBS.md](docs/JOBS.md)).

**7. Fixing what the show found.** The work after the show is what that log
pointed at: media errors that named a cue but not the file, how the app serves
media to Chromium (`Content-Length` and byte-range requests), and frame
cadence. Cadence was
measured before it was fixed: errors on the wire at 30 fps went from 4.59 /
2.53 / 2.83 % per run to 0.00 / 0.00 / 0.59 % by keeping the video element's
frame callback armed for the source's whole life
([measurements](captures/measurements/README.md)).

### How the work was run

The project was built by directing AI coding agents (Claude Code orchestrating,
Codex as builder and critic), and most of what makes it trustworthy is the
discipline around them:

- [CLAUDE.md](CLAUDE.md) is the working agreement every session reads: the
  verification bar, an index of standing decisions, and the traps.
- [docs/DECISIONS.md](docs/DECISIONS.md) records every standing decision with
  what it protects, its evidence and what would reopen it — so a rule is argued
  with, never worked around.
- [docs/POSTMORTEMS.md](docs/POSTMORTEMS.md) records ten conclusions this
  project held and acted on that were wrong, and finds one mechanism behind all
  of them: *the disproof already existed and had no path to anyone who would
  see it.* A packet-length filter discarded the very packets that disproved a
  512-byte assumption. A gate reported green while `node_modules` was empty. A
  `SecurityError` thrown sixty times a second froze the floor while nothing
  reported an error. Every fix since adds a channel for bad news: instruments
  carry positive controls, and fixes are mutation-checked.
- [docs/DELEGATION.md](docs/DELEGATION.md) records what may and may not be
  delegated to an agent — tests never are — and why.

## Try it yourself

No floor is needed. In development the app sends to `127.0.0.1`, never to the
network broadcast address.

**Prerequisites:** macOS, Node.js with npm, and Python 3.11 or newer. ffmpeg is needed
only for `tools/make_clip.py`.

### Run the app in dev mode

```bash
git clone https://github.com/troglodonkulous/pxdf.git
cd pxdf/app
npm ci
npm run dev
```

The app window opens on the **Mapping** surface and the sidecar starts
streaming to `127.0.0.1:60001` at 30 fps. Then:

1. **Mapping** sets the floor type and size at runtime and redraws the
   jack-level wiring diagram. The default is the shop rig, 10 × 5 tiles of
   `8x8_4P`.
2. **Open Player**, then **Add cue → Upload media…** and pick a video. The tracked
   `test-patterns/11-white-8x8_4P-10x5.mp4` works, as does any `.mp4`, `.m4v`,
   `.mov`, `.webm` or `.mkv` of your own. The AVIs in `test-patterns/` are for
   the vendor software; Chromium cannot open AVI.
3. **GO** sends the cue live; Preview shows what the floor would display.
   BLACKOUT and Master behave as they would at a show.

To watch the packets themselves, run this in a second terminal while the app is
open. Every header starts `ff <controller> 01 <port> <packetIndex>`:

```bash
python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('127.0.0.1', 60001)); [print(s.recv(2048)[:5].hex(' ')) for _ in range(20)]"
```

### Run the engine and its graders

From the repository root:

```bash
# The packet plan for the shop rig: 10 × 5 tiles, three controllers.
python3 -m mapper plan --type 8x8_4P --cols 10 --rows 5

# Decode a tracked clip, then generate the same pattern in code.
# Both print the same frame digest: 10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057
python3 -m mapper play tools/oracle/media/09-gradient24-8x8_4P-10x5.avi \
    --type 8x8_4P --cols 10 --rows 5 --dry-run | tail -1
python3 -m mapper send --type 8x8_4P --cols 10 --rows 5 \
    --pattern gradient24 --dry-run | tail -1

# Compare a real hardware capture against the bytes the sender would send.
python3 -m mapper verify captures/20-ours-white.pcapng \
    --type 8x8_8P --cols 8 --rows 5 --pattern white

# Check the invariants across all 2,400 legal geometries.
python3 -m mapper matrix

# Grade stored captures with the oracle harness (dry-run, no network).
python3 -m tools.oracle.harness run --only 02-white --only 20-ours-white \
    --json-out /tmp/pxdf-oracle-report.json

# The app's checks.
cd app && npm run typecheck && npm test
```

The full verification bar — every suite that must pass before anything here is
called done — is in [CLAUDE.md](CLAUDE.md#the-verification-bar).

## Repository map

| Path | What it is |
|---|---|
| [mapper/](mapper/) | The engine: packet plans, encoding, pacing, CLI, conformance fixtures ([README](mapper/README.md)). |
| [app/](app/) | The Electron app and its unit and end-to-end tests ([README](app/README.md)). |
| [tools/oracle/](tools/oracle/) | The capture-and-grade harness ([ORACLE_HARNESS.md](docs/ORACLE_HARNESS.md)). |
| [fixtures/](fixtures/) | Conformance manifests and golden bytes for any reimplementation. |
| [captures/](captures/) | Hardware packet captures, the show log and measurements, kept as evidence. |
| [design/](design/) | Mockups and the design system the app was built from; the mockups show more than ships. |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The wire specification. |
| [docs/APP-PLAN.md](docs/APP-PLAN.md) | The app's architecture, scope, gates and remaining work. |
| [docs/MAPPING-DIAGRAM.md](docs/MAPPING-DIAGRAM.md) | The written spec the wiring diagram was built from. |
| [docs/RUNSHEET-10x5-4P.md](docs/RUNSHEET-10x5-4P.md), [docs/PRE-PROBE.md](docs/PRE-PROBE.md) | Hardware sessions, and how each one was prepared. |
| [tools/Send-FloorTest.ps1](tools/Send-FloorTest.ps1) | A deliberately simple, independent fallback sender, kept unmodified as a second implementation. |

## Status

The protocol and the command-line sender are hardware-verified. The app's Play
and Mapping surfaces, packaging, media and error reporting, network recovery and
cadence work are merged. Still planned: a layer compositor, generators, project
files and crash recovery; unattended multi-hour operation is not yet
soak-tested. Arrival-paced streaming is opt-in until it has been captured on the
floor ([APP-PLAN.md](docs/APP-PLAN.md)).

At the venue, the controllers' DMX512 input and IR remote are the hard override,
independent of this software.

## Legal posture

Interoperability reverse engineering of hardware the operator owns. Vendor
binaries were read for protocol facts only; the implementation was written from
the written specification in [docs/PROTOCOL.md](docs/PROTOCOL.md), never from
decompiler output, which is not published.

## Naming and redactions

The project was called `ddf` until publication. Captured artifacts and dated
records (`captures/`, `docs/JOBS.md`, `docs/POSTMORTEMS.md`,
`docs/media-internals-capture.txt`) keep that name, because they are evidence.

For publication, people's names and local user paths were replaced with
placeholders throughout history, including the show log and `docs/JOBS.md`.
Packet captures are byte-exact and keep their capture-machine metadata. Commit
IDs changed; [captures/measurements/README.md](captures/measurements/README.md)
maps the old IDs cited in captured files to this history.

---

© 2026 Rob Maxey. All rights reserved for first-party code. Source published for
review. Third-party components are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
