# The app plan

**Canonical.** This supersedes `README.md`'s old plan steps 4–6 (a Swift package
graded against `fixtures/`, then a SwiftUI GUI), decided 2026-08-11.

**This file is the only copy.** `docs/app-plan.html` was a rendered snapshot of
the same material and was deleted on 2026-08-12, because the two forms had
already drifted once on something load-bearing: this file's build order said
"Player window" and nothing more, while the HTML's DAY 1 spelled out a whole
surface. A second form of a plan is a second plan. The artifact at
`https://claude.ai/code/artifact/fea97194-eb00-4547-9611-bca522935813` is stale
and is not maintained.

Feature scope comes from `docs/REQUIREMENTS-v1.pdf`. Visual scope comes from
`design/mockups.html`. **The requirements document wins where the two disagree**
— the mockups render a superset, including Direction and Custom layout, which
this plan shelves.

---

## The decision

1. **Do not port the mapper.** It is the only part of this project graded against
   hardware — 80/80 frames exact against Ledset's 68/72, `RUNSHEET-10x5-4P.md`
   §11 P4-7. A Swift or JS rewrite restarts exactly the risk `CLAUDE.md` exists
   to prevent and buys nothing: the job rig is 7,680 pixels at 30 fps.
2. **Electron + TypeScript + React, with `mapper/` as a sidecar process.** The
   mockups are working HTML against a real token system, the compositor is
   native Canvas2D, and the whole integration is one new subcommand.
3. **Composite at 8× floor resolution, downsample once at the end.** This is the
   architectural centre. Rotation, mirror, master brightness and the resolution
   finding all live in that one pass.
4. **Electron is not a dead end.** Syphon and NDI (§8) arrive later as a
   sidecar-protocol helper — 2–4 days — not a rewrite.

## Two rigs

Derived from `python -m mapper plan`, 2026-08-11. Neither number below has been
seen on 10 × 12 hardware.

| | Shop · 10 × 5 | Job · 10 × 12 |
|---|---|---|
| Floor pixels | 80 × 40 | **80 × 96** |
| Aspect | 2 : 1 landscape | **5 : 6 portrait** |
| Controllers | 3 · ports 4/4/2 | 3 · ports 4/4/2 |
| Packets / port | 2 | **5** |
| Packets / frame | 20 | 50 |
| Bytes / frame | 9,700 | 23,290 |
| At 30 fps | 600 pkt/s · 291 KB/s | 1,500 pkt/s · 699 KB/s |

Controller topology is identical, so the shop rig genuinely rehearses the job
rig's controller layer, EOF placement included. What it does **not** rehearse is
the physical arrangement — twelve tiles deep per chain against five. Controller
ordering is set by cabling at load-in and nothing in this repo predicts it. A
white frame and a per-column walk come before content.

## The render pipeline

Generating at 80 × 40 evaluates the image once per floor pixel: every edge
aliases, and sub-pixel motion does not exist. Generating at 1280 × 640 and
area-downscaling averages 256 samples per floor pixel, which buys **clarity**
(antialiased edges) and **smoothness** (a shape moving 1/16 px changes the
average even when it crosses nothing) at once. 2560 × 1280 is not better —
1,024 samples is indistinguishable from 256. Same physics as `--scaler area`
beating `neighbor` in `RUNSHEET-10x5-4P.md` §11 P4-5, measured from the other
direction.

Three rules follow.

1. **Floor resolution is an output format, never a project format.** Composite
   at `floor_px × S`; store nothing at 80 × 96.
2. **Downsample once, at the very end, with an explicit box filter.** Not
   per-layer, and never by handing 1920 × 1080 straight to an 80 × 96 canvas —
   at 24:1 Chromium's filter is not an area filter, which is the `neighbor`
   problem relived in the browser.
3. **Store transforms normalised 0–1, display them in floor pixels.** The
   mockups' "values in floor pixels" is a display choice. A stored pixel value
   corrupts every cue on a geometry change; a normalised one makes re-fit a
   re-render.

**One pass owns every geometry feature.** Rotation, mirror, master brightness
and the downsample are the same loop — read the work canvas, write the wire
framebuffer, parameterised by `(rotation, mirrorX, mirrorY, S, master)`.

```
layers ──▶ work canvas ──▶ THE ONE PASS ──────▶ wire framebuffer
video·gen   640 × 768      rotate · mirror      80 × 96 RGB
            S = 8          master · ÷8 box      23,040 B payload
                                                (23,290 on the wire,
                                                 headers included)
                                                     │ IPC → stdin
                                                     ▼
sender.run() ◀── build_frame() ◀── latest-frame slot
own 30 Hz clock  verified·untouched  reader thread
      │
      ▼  UDP 255.255.255.255:60001 · 50 pkts/frame
   CTRL 1 (4p) · CTRL 2 (4p) · CTRL 3 (2p)
```

Python owning the clock is the README's double-buffering requirement for free: a
renderer hitch re-sends the previous frame instead of producing a gap, and the
wire keeps its measured ±0.4 ms pacing whatever Chromium is doing.

**The render loop writes exactly one frame per animation frame, on every path,
and composition is not allowed to throw.** Learned the expensive way in PR 2:
`getImageData` raised `SecurityError` on a tainted work canvas, and because the
throw happened *in the middle* of the loop body, everything downstream of it was
skipped — the `writeFrame` that feeds the floor, the preview paint, and the
periodic `setStats`/`setSnapshot` that are the only things telling React the
engine moved. The engine was correct the whole time. The floor went black, the
cue stack froze mid-change, and nothing reported an error, because the one place
an error could have been recorded was downstream of the throw. It threw sixty
times a second for as long as the app ran.

So `player/compose.ts` owns the one step that touches a decoder, a canvas and
cross-origin media, and it has a contract: **it returns bytes that are always
safe to send, and it never throws.** A failure returns black and marks the
source failed, which routes into `PlayerEngine`'s single failure channel — the
operator gets the cue's name in a banner, the engine reaps the source, and black
on the floor becomes a decision instead of an accident. The lesson is not "add a
try/catch"; it is that a show surface needs a structural guarantee rather than
one that holds as long as nothing in the middle misbehaves.

**S is a setting — 4 / 8 / 16, default 8** — beside a live render-ms readout,
settled at the shop against real clips. The 16× sweet spot was measured through
`make_clip.py --scaler area`, judged partly on file size and generation time,
neither of which exists in the app. The principle transfers; the number does
not. Cost scales as S²: at S = 8 the job rig's work canvas is 640 × 768 and the
downsample is ~492k reads/frame, comfortable in plain JS; at S = 16 it is ~2M
and wants a WebGL pass.

Generators inherit this free — `tools/dancefloor-loops.html`'s per-pixel kernel
is already written against normalised `(bx, by)` and a `phase01`, so it renders
at whatever the work canvas is. (`renderFrame` itself is not pure — it reads
module-level globals and writes a canvas — but the kernel inside it is the
load-bearing part, and that ports unchanged.)

## Rotation is not orientation

`mapper/orientation.py` is **cabling compensation**, applied at the wire-mapping
stage. `CLAUDE.md` settles it as `identity`, permanently, and it stays settled.

Mapping's **Rotation** (0 / 90 / 180 / 270) is a **presentation transform**, so an
operator can author a physically 80 × 96 portrait floor as a 96 × 80 landscape
canvas. It lives in the final composite pass. The mapper receives an 80 × 96
row-major RGB framebuffer at every rotation.

**Zero changes to `mapper/`.** Do not merge the two concepts.

Rotation lives on the **Mapping** surface, with the floor it presents. It is not
in mockup 1a — that is an addition to the mockup, made deliberately, because
leaving it in a PR named "generators" after Mapping moved out of that PR made no
sense. It costs nothing: `onePass` already takes `rotation` and the rotate ×4
gate already passes.

## The Mapping surface

**Mockup 1a is the target**, and 1a alone. 2a is the custom / L-shaped layout
variant and is shelved (below). The surface has four parts:

| Part | What it is |
|---|---|
| Wiring diagram | Controllers as boxes, their four physical jacks, and which tile columns each drives. Hovering a connector lights its two tile columns. Header reads `1 connector = 2 ports = 2 tile columns`. |
| Floor panel | Type / Width / Height, all **dropdowns, never free text** — `mapper stream --type` accepts exactly `6x6_4P`, `6x6_8P`, `8x8_4P`, `8x8_8P`, and a typo in a tile count is a floor that does not light. |
| Derived readout | Metres, feet-and-inches, tile count, pixels, controllers, packets and bytes per frame. **Every number derived, none entered.** A tile is 500 mm; imperial is computed from metric and is never the input. |
| Network + navigation | The NIC picker, and **Open Player** — the first navigation in the app. |

**The diagram's layout comes from the vendor, written down.** Ledset's mapper
window is the one part of that application worth keeping, and
`docs/MAPPING-DIAGRAM.md` specifies how it draws: the derivation chain from type
and tile counts to controller count and canvas size, the element sizes, and the
trick that makes a bundle of parallel wires readable — **each wire's drop height
and colour are indexed by its port number within the controller**, so four ports
travel at four heights and cross nothing. Unused ports are drawn and left
unwired, which is exactly what controller 3 looks like on this rig. That
document also records what we change (colours and sizes come from the design
system), what we add (mockup 1a's hover highlighting, which the vendor does not
have) and what we drop (the power-supply row, which 1a omits).

**Nothing here re-derives what `mapper` already knows.** `mapper plan --type T
--cols C --rows R` prints the controller, port, packet, `byte4`, length and
port-offset of every packet in a frame, plus the summary line the readout needs.
The diagram is a rendering of that table, and the gate below is that the two
agree. A TypeScript reimplementation of the topology would be a second
implementation of the thing under test — the same argument that makes the
gradient24 gate shell out to `mapper/patterns.py` rather than port it.

**The NIC picker needs no `mapper/` change.** `mapper stream --local-ip` already
binds to a specific interface, and `Sidecar` already forwards `--address` and
`--port`. `CLAUDE.md` records the sender NIC as `10.200.50.78/8`; the picker
enumerates and chooses, it does not invent a mechanism.

### Geometry becomes a runtime variable

This is the load-bearing half of the PR and the part that is not visible in a
mockup.

- `show.floor` is the single source of truth. `App.tsx` and `main.ts` stop
  naming `SHOP_RIG`.
- Changing it **restarts the sidecar**: `stop()` writes black, ends stdin and
  resolves on `exit`, then a new `Sidecar` spawns with the new `--cols`/`--rows`.
  The window between them is a window in which the floor receives nothing, and
  `CLAUDE.md` says controller 1, in Master/IR mode, reverts to vendor content
  about five seconds after packets stop (in slave mode it holds its last frame
  like 2 and 3 instead). A restart that takes 200 ms is fine; one that hangs on a
  Python process that will not exit is a floor showing someone else's content
  mid-show. **That is why the wire gate below exists.**
- The work canvas, the wire buffer, the preview buffer and `blackFrame` are all
  sized from the floor and are all reallocated with it.
- Re-fit costs nothing *in this PR* and will cost something in PR 5. A cue is
  still a media file and a duration, drawn cover-fit, so a geometry change is a
  re-render. Once PR 4 gives cues normalised layer transforms, mockup 1e's
  re-fit sheet becomes real work. Do not build it here.

### Gates, all off-hardware

1. **The diagram agrees with `mapper plan`.** For a set of geometries including
   10 × 5, 10 × 12, an `_8P` type and an odd column count, shell out, parse the
   table, and assert the surface's controller/port/tile-column assignment and
   its derived readout match it field for field.

   Extended 2026-08-13 to grade the *jack* layer that sits on top of it. `mapper
   plan` emits no connector column, so the two-ports-per-jack constant is
   hardware-cited (`docs/PROTOCOL.md:75-79`, gate 4; the cable trace at
   `docs/RUNSHEET-10x5-4P.md:1546-1560`) rather than mapper-derived — but
   everything downstream of it is graded against mapper: one cable per used
   jack, `ceil(ports-in-use / 2)` per controller; every tile column fed exactly
   once, with paired columns adjacent; four jacks drawn per controller with
   every socket inside the box; and no two cables on one controller sharing a
   colour or a drop height. The odd-column rig exists so the trailing
   single-port jack is executed rather than reasoned about.
2. **A geometry change is visible on the wire, with no gap in the content.**
   Extend `test/e2e/wire.mjs`: set 10 × 12 in the running UI and watch packets
   per frame go **20 → 50** and bytes per frame **9,700 → 23,290**. No *content*
   gap across the restart — controllers never see garbage or stale non-black
   content, which `Sidecar.stop()`'s black-before-goodbye write is what
   provides. The **transport** gap is real and budgeted rather than denied: a
   geometry change replaces the `mapper stream` process, and the old one has to
   stop being the sender before the new one starts or two senders interleave
   frames onto one floor. So the gate is that the silence stays under a small
   bound — `wire.mjs` uses 2 s — which is well short of the ~5 s at which
   controller 1, in Master/IR mode, reverts to the vendor's own content (in
   slave mode it holds its last frame instead, same as 2 and 3).

   *Reworded in PR 3, 2026-08-13.* The original said "no gap in the packet
   stream", which read literally is unachievable without either live
   reconfiguration inside `mapper/` — far outside this plan's "one new
   subcommand, nothing existing edited" — or two concurrent senders, which this
   document's own integration seam calls out as the failure mode to avoid. The
   wording is amended here rather than quietly reinterpreted in the test, so the
   doc and the gate say the same thing.
3. **The job-rig digest becomes reachable.** `gate.digest.test.ts` already
   grades both rigs. The new assertion is that the app, driven to 10 × 12
   through the UI, produces the framebuffer that digest grades.

   *Scope note, PR 3, 2026-08-13.* PR 3 meets the half it can: the Mapping
   surface's selection path is driven to 10 × 12 and asserted to produce the
   `FloorGeometry` `gate.digest.test.ts` already hashes to `12df0afc…`, and the
   wire is asserted to carry real composed content at 50 packets / 23,290 bytes
   per frame at that geometry. **The byte-exact half is owed to PR 5** — the
   digest grades `gradient24`, and until the app has a generator its only
   sources are decoded video, which is not byte-exact by construction. Recorded
   on PR 5's row below rather than marked met here.

### Cut from 1a, deliberately

- **`Calibrate…` does not ship, in any state.** Colour calibration was built,
  merged and reverted in full on 2026-08-11; `CLAUDE.md` records that a button
  in a mockup is not permission to reopen it.
- **`Open…` / `Save As…` ship visible and disabled**, captioned with the PR they
  arrive in, exactly as PR 2 handled Speed and Direction. Project files and
  crash recovery are PR 5 and pulling them forward doubles this PR. The cost is
  named rather than hidden: **the floor is described once per launch.**
- **Custom / L-shaped layouts** stay shelved — mockup 2a, and see below.

## The integration seam

One new subcommand, `mapper stream`. Nothing existing is edited. `run()` already
takes a `Callable[[int], bytes | bytearray]`, and `pack_send_buffer` expects a
row-major RGB framebuffer of `pixel_count × 3` bytes — exactly what the final
pass produces.

A reader thread fills a latest-frame slot from stdin; `sender.run()` sends from
it on its own metronome. A stalled writer re-sends, never gaps.

### Gates, all off-hardware

- `gradient24` through the app's compositor via `putImageData`, shop geometry,
  rotation 0, no mirror, master 100%, and **S = 1** — a test-only value that
  bypasses supersampling so the digest is comparable byte for byte →
  `10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057`
  — the same digest that grades the `play`/`send` cutover.
- rotate 90° four times → identity.
- mirror on either axis twice → identity.
- The same, at the job geometry —
  `12df0afcfb2c05be3b967822ae965dc251578b27f4813d372447c3d09d59352d`, derived
  2026-08-11 from
  `python -m mapper send --type 8x8_4P --cols 10 --rows 12 --pattern gradient24 --dry-run`.
  Re-derive rather than trusting this line if `mapper/` ever changes.

Three things follow from wanting those gates to grade anything, settled at PR 1.

**The pass is a pure function over typed arrays, not a method on a canvas.**

```ts
onePass(src: Uint8ClampedArray, srcW, srcH, opts): Uint8Array   // pixel_count * 3
opts = { rotation: 0|90|180|270, mirrorX, mirrorY, S, master }
```

`S = 1` then needs no test-only backdoor — it is an argument, and the settings UI
simply offers 4 / 8 / 16 (PR 4 owns it, alongside the render-ms readout). The gate runs under a plain unit-test runner with no
canvas, no `putImageData` and no headless-Electron harness, which is what makes
it cheap enough to run on every change rather than once at review. The app feeds
it `ctx.getImageData(...).data`; nothing else about the pipeline changes.

**The RGBA→RGB repack lives inside that loop.** Reading the work canvas gives
RGBA; the wire wants RGB. Anywhere else it becomes a second full traversal of
the framebuffer and "the one pass" stops being one. Alpha is dropped, not
composited — the work canvas is cleared to opaque black each frame, so alpha is
255 by construction and a layer that lowers it is compositing against black,
which is what the floor physically does.

**The gate's input framebuffer comes from Python.** `gradient24` is defined once,
in `mapper/patterns.py`, and a JavaScript reimplementation of it would be a
second implementation of the thing under test — reliably self-consistent,
occasionally wrong together. The test shells out to generate the framebuffer and
pipes its own output into `mapper stream --dry-run`. No `mapper/` change is
needed for either half.

**And the gate is mutation-checked, because identity is a pass that should do
nothing.** At `S = 1`, rotation 0, no mirror, master 100 %, a correct `onePass`
is a no-op, so the digest matching proves very little on its own — a pass that
ignored `rotation` entirely would still pass it. The rotate ×4 and mirror ×2
gates cover the transform algebra; a rotated input, and a master of 99 %, must
each *fail* the digest; and a hand-computed 2 × 2 block grades the box filter,
which `S = 1` never exercises.

### Two harnesses, and no third

Settled 2026-08-12, after PR 2 shipped 1,400 lines of UI with four tests on it.

- **`vitest`, for pure logic.** No DOM. `onePass`, `geometry`, the player
  engine, the show-file parser, the cue helpers, `Sidecar` over a fake process.
  Cheap enough to run on every change, which is the only reason it grades
  anything.
- **`test/e2e/wire.mjs`, for the UI.** It launches the built app, drives the real
  surface over the DevTools protocol, and reads UDP off the socket. It is not a
  `vitest` test and must not become one: it costs Electron, Python and ffmpeg,
  and a unit-test runner that sometimes needs those is one people stop trusting.

**No jsdom, no testing-library.** The question is not which is more usual but
which would have caught PR 2's three real defects, and the answer is measured
rather than assumed: the blank production page (a `file://` base-path fault) —
jsdom, no; `VideoSource.ready` never flipping (no decoder in jsdom) — no; the
wrong cue armed by `addMedia` — possibly. `wire.mjs` caught all three, because
all three lived in the seam between Chromium, Electron and a real socket, which
is exactly the seam a DOM emulator replaces with a stub. A third harness that
grades none of the failures this project actually produces is a cost with no
gate attached to it.

The consequence is that **UI work is graded by extending `wire.mjs`**, and that
extending it is part of the scope of any PR that adds a surface.

Two things learned while using it, both worth not relearning.

**A fix can disarm the regression test for the bug it fixed.** The taint defect
first showed up as an uncaught `SecurityError`, so the gate grew a "the page
raised no uncaught exceptions" check. Fixing the render loop then made
composition swallow that exception by design — correct behaviour, and it made
the new check pass under a deliberately reintroduced taint. What actually grades
the taint is a check that reads the **error banner**, because that is the
operator-visible consequence and it survives the loop learning to cope. Only
mutation-checking found this: the check was green against the mutant.

**Assert on the wire, then confirm in the DOM with a bounded poll — never a bare
read.** The React view is republished on the render loop's ≥250 ms sampling
tick, while a packet check exits the instant the first matching packet lands. A
single unretried `is-live` read against that is a race that fails about one run
in two, and it is the gate flaking rather than the app. Every DOM assertion in
`wire.mjs` polls.

## The log, and the three failures that had no channel

Added 2026-09-03, before the first floor session on the integrated app. The last
job ran on the older `main` build because this one had playback problems that
were never diagnosed — and the reason they were never diagnosed is that the app
had no way to report a failure to anyone who was not watching the screen in the
second it happened. Every channel ended in a React banner: overwritten by the
next event, erased by a restart, invisible afterwards.

**Where it is.** `~/Library/Logs/DDF Sender/ddf.log` when packaged,
`~/Library/Logs/Electron/ddf.log` in development — macOS derives the folder from
the app name, not from `--user-data-dir`, which is why the wire gate's log lands
in the development one. One rotation at launch to `ddf.prev.log`, by run and not
by size: after something goes wrong at a venue the operator restarts, and the
file anyone wants is the one from the launch before. **Reveal log** on the
Mapping surface opens it in Finder.

**What it is for.** Three failures previously had no channel at all, and the
third is the one that matches what went wrong at the job:

| Failure | Now reported by |
|---|---|
| Main-process uncaught throw | `reportFatal`, `main.ts` |
| Renderer throw before React, or during render | preload `error`/`unhandledrejection`, and `ErrorBoundary` |
| Renderer stops producing frames | `frameWatch.ts`, from the main process |

A React tree that unmounts takes the render loop's `cancelAnimationFrame` with
it, `writeFrame` is never called again, and `Sidecar` holds the last frame on
the wire for ever. The status pill reads `sending` and is *correct* — the Python
child is healthy and the wire carries a valid non-black frame — so nothing in
the app disagrees with anything else while the floor is frozen. Only the main
process can notice, because a renderer that broken cannot report on itself.

**The heartbeat is the positive control.** One line a minute carrying status,
NIC, geometry and the frame count. Without it, "the log contains no errors" and
"the app died twenty minutes ago" are byte-identical evidence, and `CLAUDE.md`'s
rule that silence must be distinguishable from success would be broken by the
instrument rather than by the thing it measures. **A gap in the timestamps is a
finding.**

**Two cry-wolf guards, both mutation-checked** (`frameWatch.test.ts`): the
watchdog is armed only after the window has loaded and had five seconds to draw,
and it clears only the banner it raised itself — the same rule, and the same
reason, as `nicWatch.ts`. `wire.mjs` grades the pair against a real run: check
106 fails if the watchdog says anything during a healthy show.

**One slot per source, not one slot** (`banners.ts`). Found by review before this
merged. Five sources publish errors — a main-process throw, a log file that could
not be opened, the sidecar, the NIC poll, the frame watchdog — and each of them
remembered the message it had published so that it would clear only its own. That
guard is sound against another source *clearing* the banner and useless against
another source *writing* it, which cost two diagnostics outright:

- The launch warning "no log file this session" was wiped by the first routine
  sidecar recovery, which publishes null. The one notice that the session had no
  evidence chain, gone in seconds, with nowhere to write it down.
- Overwrite the watchdog's banner with a sidecar death and its own memory still
  holds the old string, so its edge comparison keeps matching and it never speaks
  again. The frozen-floor channel goes out of service silently, for the rest of
  the run.

Each source now writes its own slot and nothing else can reach it, so the
per-watcher ownership guards are structurally true rather than separately
enforced. `composeBanner` shows the most *actionable* live message and counts the
rest (`(+2 more)`); the log carries every one of them in full, with its source.

Ordering by actionability rather than severity is the second thing review caught,
and it is the same defect wearing the fix's clothes. `log` and `fatal` are the
only slots nothing ever clears — a log directory does not become writable
mid-show, and a main process that threw stays thrown. Ranked above the transient
faults, either one parks a permanent, unactionable sentence on the banner and
demotes every dark floor, unplugged cable and frozen renderer after it to a
number. So they rank last; and `(+N more)`, which is a pointer at the log, is
only used while there is a log to point at — when the `log` slot is live the
banner carries the other messages in full, because at that moment it is the only
surviving record of the session.

Whether the log works is checked on every watchdog tick, not once at launch.
`writeError` latches on the first failed write and is never cleared, including by
later writes that succeed — a disk that fills and is freed leaves a hole, and a
hole is invisible from the records that did get written. Checked only at startup,
a log that dies at 21:40 reads exactly like one that is fine, and `(+2 more)`
goes on pointing at a file that stopped recording hours earlier.

**What is deliberately not logged.** Not frames — `ddf:frame` runs 30-60 times a
second and does nothing but bump two counters. Not every status publish —
`Sidecar` republishes `restarting`/`sending` on every spawn, so a crash loop
would bury its own cause; transitions only. Not renderer console output beyond
errors.

**One trap.** `mapper stream`'s stdout is captured, and it only works because
`sidecar.ts` sets `PYTHONUNBUFFERED=1`. Python block-buffers stdout into a pipe
and `cmd_stream`'s opening prints carry no `flush=True`, so the first version of
this captured nothing while looking exactly like it worked — the sender's own
statement of the address and NIC it bound to sat in the child's buffer for the
life of the process. Fixed on the app side because nothing in `mapper/` may
change to accommodate the app.

## Build order

One PR per gate. Branch from `main` each time, after the previous merges.

| PR | Branch | Scope | Gate |
|---|---|---|---|
| B | `mapper-stream` | `mapper stream`, `--emit-digest`, its test | stream digest == `send --dry-run` digest |
| 1 | `app-shell` | Electron + Vite + React, sidecar supervision, **the one pass complete**, a minimal render host | gradient24 digest · rotate ×4 · mirror ×2 |
| 2 | `app-player` | Play surface: cue stack, GO, transport, Live/Preview, BLACKOUT, Master. **A cue is a media file and a duration** | black frames on the wire for BLACKOUT, cue gaps and idle · gapless cue change · the socket never closes · a cue that cannot play says so and does not stall the loop · only opened files are served |
| 3 | `app-mapping` | **Mapping surface** (mockup 1a): floor Type / Width / Height, the wiring diagram, the derived readout, the NIC picker, Rotation, Mapping ↔ Play navigation. **Geometry becomes a runtime variable end to end** | the diagram agrees with `mapper plan` · a geometry change is visible on the wire as 20 → 50 packets/frame, with no content gap across the restart and the transport gap bounded well under controller 1's ~5 s revert |
| 4 | `app-compositor` | layer stack, normalised transforms, **colour adjustment (§4)**, timeline with start/end trim, per-cue speed and Loop N/∞ (§2), **a global fade time and per-cue override**, S setting | 4-layer cue identical preview vs wire at S = 4/8/16 |
| 5 | `app-generators` | generators (§6), **text generator (§5)**, auto-fit, cue rotate/mirror, **project files + crash recovery** | 10 × 5 show re-fits to 10 × 12 · kill the app mid-edit and lose nothing · **owed from PR 3:** gradient24 from an in-app generator, driven to 10 × 12 through the UI, hashes to `12df0afc…` |
| 6 | `app-hardening` | packaging, codesign, notarize, failure drills | every drill survived |

The floor session produces no PR. It produces a runsheet section, as §11 did.

**PR 2 was split out of PR 1 on 2026-08-11.** The two forms of this plan had
already drifted on the point: this table said "Player window" and nothing more,
while `app-plan.html`'s DAY 1 spelled out "cue stack, GO, transport,
Live/Preview, BLACKOUT, MASTER. A cue is a media file and a duration" — a whole
surface, invisible in the canonical copy. Splitting it also fixes a dependency
inversion the old order carried: the compositor PR built a four-layer stack
before anything in the app could run a show at all. A cue is single-source in
PR 2 and gains layers in PR 4, so each PR runs.

**PR 3 was added on 2026-08-12, and it restores something this plan lost.** The
Mapping surface is mockup 1a and was always meant to come before the Play
surface — you describe the floor you have, then you run a show on it. It went
missing between the mockups and this file's build order, where PR 1 read "a
minimal render host" and Setup was a phrase inside the generators PR. The
consequence shipped: at the end of PR 2 the floor geometry is three hardcoded
literals (`App.tsx`'s `FLOOR`, `main.ts`'s `Sidecar` construction, and a
hand-typed `10 × 5 · 80 × 40` in the title bar), so **the app cannot be pointed
at the job rig at all** — and the job rig is the whole reason it exists.

It goes before the compositor for the same reason PR 2 went before it: a
four-layer stack built against a compile-time constant floor is rewritten the
day the floor becomes a variable. It is also smaller than it sounds, because
three of its four dependencies already exist — `floorGeometry(type, cols, rows)`
is general, `Sidecar` already takes `type`/`cols`/`rows` as options and already
passes `--local-ip` through to `mapper stream`, and `gate.digest.test.ts`
already grades the one pass at **both** rigs, including
`12df0afcfb2c05be3b967822ae965dc251578b27f4813d372447c3d09d59352d`. That digest
is written, passing, and currently unreachable from the running app.

**Name it Mapping, not Setup.** The mockups say Mapping and so does the
operator; this plan said Setup. Two names for one surface is how the two forms
of this plan drifted about the Player. Settled 2026-08-12.

**PR 2's gate is deliberately not a digest against `mapper play`.** Chromium's
H.264 decoder and ffmpeg's do not agree byte for byte — chroma upsampling and
IDCT rounding differ — so a pixel digest across the two fails for a *correct*
implementation, and the repair someone reaches for is to change the pass until
it agrees. That is a self-consistent-but-wrong result, pre-written — the
mechanism and its ten instances are in `docs/POSTMORTEMS.md`.
What is exact is the black-frame invariant: an all-zero framebuffer has one
correct wire digest, and `CLAUDE.md` makes sending it a safety property rather
than a nicety, because a floor that stops receiving does not go dark.

**The app lives in `app/` in this repo.** The digest gate couples it to
`mapper/`, and a split repo means version skew between the app and the engine it
drives, discovered at a wedding.

Two rules keep the renderer replaceable, and cost nothing today:

- the show file is plain JSON — no DOM types, no Electron types, no absolute
  paths into Electron internals;
- the renderer→sidecar frame protocol is a documented byte contract.

## Requirements notes

- **Colour adjustment (§4) is `ctx.filter`, and nearly free.** Hue, saturation,
  contrast and brightness are one CSS filter string on the layer's draw; opacity
  is `globalAlpha`; tint is one composite pass. All per layer, in PR 4. Scale and
  rotation are the Xform panel, stored normalised like every other transform.
- **Text is a scrolling marquee, not a static title.** At 80 px wide the floor
  fits about ten 8-px glyphs. Requirements §5's four scroll directions are the
  feature, not a garnish.
- **Crash recovery is a reliability pillar** (§9), not autosave. Debounced write
  to a `.recovery` sidecar on every mutation; a sidecar newer than the show file
  offers a restore on launch. Plus Save / Save As / Duplicate / Open / Rename.
- **Blackout sends black frames; it never stops sending.** In Master/IR mode,
  controller 1 reverts to local content ~5 s after packets stop while 2 and 3
  hold their last frame; in slave mode controller 1 holds its last frame too.
  The socket opens with the show file and never closes.
- **Brightness and Master are compositor-side.** `PROTOCOL.md` Q6 is closed:
  nothing in the vendor stack exposes colour or brightness over Ethernet for
  this controller.
- **Fades are PR 4, and were in no PR at all until 2026-08-13.** The mockups
  show a global fade time with a per-cue Global/Custom override, and this plan
  never mentioned the word — so PR 2's inspector shipped a disabled Fade control
  captioned with a PR number that was a guess. They belong here because a fade
  is a cross-cue composite: two sources drawn into one buffer with a weight that
  moves over time, which is the layer stack's machinery and nothing the engine's
  single live slot can express. Until then, cue changes are hard cuts —
  gaplessly, which `engine.test.ts` grades.
- **Media is loaded over `ddf-media://`, never over `file://`.** A `<video>`
  whose `src` is a `file://` URL loads from a page served over `file://` and is
  blocked from a page served over `http://`, and the app is served both ways —
  `loadFile` when packaged, the Vite dev server when not. PR 2 shipped the
  `file://` form, so **video worked in the packaged app and failed in `npm run
  dev`**, which is the same defect as PR 1's asset base path with the sign
  flipped: one environment broken, the other covered, and a gate that only ever
  ran the covered one. The custom scheme removes the dependency on how the page
  was served. Three things about it are settled and were each measured on
  Electron 43 on 2026-08-12, not reasoned:
  - **`corsEnabled: true` in `registerSchemesAsPrivileged` is load-bearing, and
    the `Access-Control-Allow-Origin` header alone does nothing.** The scheme is
    cross-origin to the page under either way of serving it, so without a
    CORS-mode fetch the decoded video **taints the work canvas** and
    `getImageData` throws `SecurityError` on every frame from the moment the
    first cue goes live. Both halves are needed together: `corsEnabled` on the
    scheme and `video.crossOrigin = 'anonymous'` set *before* `src`. With the
    flag off, `crossOrigin` makes the element fail outright rather than taint.
  - **The handler serves only files the operator opened.** Registering a scheme
    hands the renderer a function it can call with a path of its choosing, and
    the renderer is the untrusted side of `contextIsolation` by design.
    `main.ts` keeps the paths the picker returned and 403s everything else, so
    the operator's choice in a native dialog *is* the authorisation.
  - **It does not serve range requests.** `net.fetch` over a `file://` URL
    answers `Range: bytes=0-` with a plain `200` and the whole file. Seeking
    works because Chromium buffers what it is given — fine for clips, and not
    fine for a long file, since the whole thing sits in memory and the player
    can hold three decoders at once. **See the normalisation bullet below: that
    is where this gets settled, not here.**
- **Import normalises, it does not downscale.** Transcode at *source*
  resolution — the Xform panel and the supersampled work canvas both need real
  pixels. **The source folders are not one codec.** Every file re-probed with
  `ffprobe` 2026-09-03:

  | folder | codec | frame rates |
  |---|---|---|
  | `Test Clips/` (6) | H.264 yuv420p | 24, 25, 29.97, 30, 60 |
  | `Test Clips 2/` (18) | H.264 yuv420p | 24, 29.97, 30, 50, 60 |
  | `Test Clips 3/` (12) | **HEVC** Main, 768×640, yuv420p, `hvc1`, level 90 (93 on the two 60 fps clips) | 25, 29.97, 30, 60 |

  This bullet previously read "every clip in `test-patterns/Test Clips*` probes
  as H.264 yuv420p, 25/30/50 fps", and the glob covered folders it had never
  been checked against. Two things were wrong, not one: `Test Clips 3/` is
  HEVC throughout, and no folder has the rate profile that was claimed — 50 fps
  appears only in `Test Clips 2/`, while 24 and 29.97 appear widely and were
  missing from the list entirely.

  The codec is not a detail here. HEVC is exactly where Chromium has no software
  decoder to fall back to, and the twelve HEVC clips are the ones that raise
  `PIPELINE_ERROR_DECODE` — so any normalisation plan that assumed a uniform
  H.264 input was reasoning about media this repo does not have. (These folders
  and the `ddf-loop-res-test` probe set the supersampling finding came from are
  gitignored source media — the finding is reproducible from
  `tools/dancefloor-loops.html`, not from this repo's tree. `Test Clips*/converted/`
  holds rawvideo AVIs and is output, not source.)

  **Normalisation is also the answer to `ddf-media://` not serving ranges**, and
  the two should be decided together. Range requests are a workaround for *an
  unknown file, possibly enormous, that must be streamed in pieces*. Import
  replaces the unknown: the app makes the file, so it knows its size before it
  is ever played, chooses a keyframe-dense encoding with the `moov` atom at the
  front, and is free to cap or split a long source. Once every file in a show is
  one we produced at a resolution relevant to an 80 × 96 floor, streaming
  fragments of it stops mattering. **If a legitimately long normalised file
  turns out to be needed anyway, implement ranges in the handler** — read the
  `Range` header, stream with an `fs` read stream, answer `206` with
  `Content-Range`, roughly 25 lines — rather than reaching for it first.

## Shelved

Named so they do not creep back in.

- **Custom / L-shaped layouts.** `frame.py` derives `tile_col = x // tile_px`
  then `divmod(tile_col, ports_per_controller)` — a strict rectangle, every port
  payload the same length. The vendor's own mapper XML carries a type index,
  two tile-count indices and a redundant pixel Width/Height — rectangle-only, so
  Ledset cannot describe an L-shaped floor either. No reference implementation,
  no capture that constrains it. Struck through in Requirements §1 independently.
- **Reverse and Bounce playback.** Requirements §2 and the Play mockup both
  carry it, but Chromium refuses a negative `playbackRate`, and a frame cache is
  ~1.7 GB for a 30 s clip at work resolution. The cheap path when it returns is
  an ffmpeg `-vf reverse` pass at import, so direction is a different file
  rather than a different decoder; WebCodecs is the upgrade beyond that. Ships
  forward-only, Direction control visible and disabled.
- **Masking.** Requirements §3 lists shape and layer masks; nothing in the
  mockups designs a control. A decision, not an oversight.
- **Effects processing (§7) — the FX tab ships present and empty.** §7 asks for
  per-source and per-layer effects over a parameter set
  (speed/intensity/colour/scale/rotation/direction/opacity) plus an architecture
  that accepts more later. The Edit inspector's FX tab is in the mockups, so it
  ships as a tab; **what is behind it is deferred**, because PR 5 already carries
  text, generators, auto-fit and crash recovery, and an effects system on
  top of that is not credible in the time. The colour half of §7's parameter set
  lands anyway as §4 above; the compositing half — per-layer post effects — is
  the deferred part. Promote it into PR 4 if the schedule turns out to have room;
  left deferred at the PR 1 review on 2026-08-11, to be decided when PR 4's real
  scope is known. Note that the deferral was originally a session's call and not
  the operator's — it is a scheduling judgement, not a scope decision they made.
- **Sound-reactive.** Space held in the Play page's cue panel per §12.
- **Syphon / NDI.** Deferred, not blocked — 2–4 days as a helper, whenever
  wanted.
- **Remote control** (§11) and **mapping export** (§10). Marked post-MVP in the
  requirements themselves.
- **Colour calibration.** Scrapped, not shelved — see `CLAUDE.md`. A `Calibrate…`
  button in a mockup is not permission to reopen it.
- **WebGL generators.** Conditional on S = 16 winning at the shop.

## When this becomes wrong

- **A booked event needs a non-rectangular floor.** Custom layouts stop being
  shelvable, and the first work is a hardware session probing whether a
  controller renders a short port payload — not app code.
- **S = 16 wins and JS cannot hold 30 fps.** The final pass moves to a WebGL
  shader. The pass is designed so the swap touches one file, but it is a day
  that is not in the plan.
- **The 10 × 12 rig does not cable like the shop rig.** Nothing here predicts
  controller order. The white frame and per-column walk are not optional.
- **Frame pacing matters more than measured.** The 7.8 %-of-a-frame worst case
  at 60 fps is documented and unexplained. Harmless at 30.
- **The app must run unattended for hours.** Nothing here is soak-tested. PR 6's
  drills are the minimum, not proof.

## Sources

| | |
|---|---|
| `docs/REQUIREMENTS-v1.pdf` | Feature scope, with the operator's inline annotations. Wins over the mockups. |
| `design/mockups.html` | The three MVP surfaces, rendered. Loads `support.js` and `design-system/` from this repo; only the Lucide icon CDN is remote, so offline the layout is right and the glyphs are missing. |
| `design/design-system/` | Tokens, the design-system spec, and 20 components as readable `React.createElement` source. |
| `tools/dancefloor-loops.html` | The generator the app's eleven patterns port. |
| `docs/RUNSHEET-10x5-4P.md` §11 | Frame rate, scaler, fit — and the `--scaler area` finding this plan generalises. |
