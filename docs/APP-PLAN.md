# The app plan

**Canonical.** This supersedes `README.md`'s old plan steps 4–6 (a Swift package
graded against `fixtures/`, then a SwiftUI GUI), decided 2026-08-11.

Same content, three forms — if they disagree, **this file wins**:

| Form | Where | For |
|---|---|---|
| This file | `docs/APP-PLAN.md` | the record, and what an agent reads |
| Rendered | `docs/app-plan.html` | reading and sharing; snapshot of 2026-08-11 |
| Live | https://claude.ai/code/artifact/fea97194-eb00-4547-9611-bca522935813 | same page, may drift ahead of the snapshot |

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

Setup's **Rotation** (0 / 90 / 180 / 270) is a **presentation transform**, so an
operator can author a physically 80 × 96 portrait floor as a 96 × 80 landscape
canvas. It lives in the final composite pass. The mapper receives an 80 × 96
row-major RGB framebuffer at every rotation.

**Zero changes to `mapper/`.** Do not merge the two concepts.

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

`S = 1` then needs no test-only backdoor — it is an argument, and the Setup UI
simply offers 4 / 8 / 16. The gate runs under a plain unit-test runner with no
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

## Build order

One PR per gate. Branch from `main` each time, after the previous merges.

| PR | Branch | Scope | Gate |
|---|---|---|---|
| B | `mapper-stream` | `mapper stream`, `--emit-digest`, its test | stream digest == `send --dry-run` digest |
| 1 | `app-shell` | Electron + Vite + React, sidecar supervision, **the one pass complete**, a minimal render host | gradient24 digest · rotate ×4 · mirror ×2 |
| 2 | `app-player` | Play surface: cue stack, GO, transport, Live/Preview, BLACKOUT, Master. **A cue is a media file and a duration** | black frames on the wire for BLACKOUT, cue gaps and idle · gapless cue change · the socket never closes |
| 3 | `app-compositor` | layer stack, normalised transforms, **colour adjustment (§4)**, timeline with start/end trim, per-cue speed and Loop N/∞ (§2), S setting | 4-layer cue identical preview vs wire at S = 4/8/16 |
| 4 | `app-generators-setup` | generators (§6), **text generator (§5)**, Setup + Rotation, auto-fit, cue rotate/mirror, **project files + crash recovery** | 10 × 5 show re-fits to 10 × 12 · kill the app mid-edit and lose nothing |
| 5 | `app-hardening` | packaging, codesign, notarize, failure drills | every drill survived |

The floor session produces no PR. It produces a runsheet section, as §11 did.

**PR 2 was split out of PR 1 on 2026-08-11.** The two forms of this plan had
already drifted on the point: this table said "Player window" and nothing more,
while `app-plan.html`'s DAY 1 spelled out "cue stack, GO, transport,
Live/Preview, BLACKOUT, MASTER. A cue is a media file and a duration" — a whole
surface, invisible in the canonical copy. Splitting it also fixes a dependency
inversion the old order carried: the compositor PR built a four-layer stack
before anything in the app could run a show at all. A cue is single-source in
PR 2 and gains layers in PR 3, so each PR runs.

**PR 2's gate is deliberately not a digest against `mapper play`.** Chromium's
H.264 decoder and ffmpeg's do not agree byte for byte — chroma upsampling and
IDCT rounding differ — so a pixel digest across the two fails for a *correct*
implementation, and the repair someone reaches for is to change the pass until
it agrees. That is the seventh self-consistent-but-wrong result, pre-written.
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
  is `globalAlpha`; tint is one composite pass. All per layer, in PR 3. Scale and
  rotation are the Xform panel, stored normalised like every other transform.
- **Text is a scrolling marquee, not a static title.** At 80 px wide the floor
  fits about ten 8-px glyphs. Requirements §5's four scroll directions are the
  feature, not a garnish.
- **Crash recovery is a reliability pillar** (§9), not autosave. Debounced write
  to a `.recovery` sidecar on every mutation; a sidecar newer than the show file
  offers a restore on launch. Plus Save / Save As / Duplicate / Open / Rename.
- **Blackout sends black frames; it never stops sending.** Controller 1 reverts
  to local content ~5 s after packets stop while 2 and 3 hold their last frame.
  The socket opens with the show file and never closes.
- **Brightness and Master are compositor-side.** `PROTOCOL.md` Q6 is closed:
  nothing in the vendor stack exposes colour or brightness over Ethernet for
  this controller.
- **Import normalises, it does not downscale.** Transcode at *source*
  resolution — the Xform panel and the supersampled work canvas both need real
  pixels. Every clip in `test-patterns/Test Clips*` probes as H.264 yuv420p,
  25/30/50 fps. (Both that folder and the `ddf-loop-res-test` probe set the
  supersampling finding came from are gitignored source media — the finding is
  reproducible from `tools/dancefloor-loops.html`, not from this repo's tree.)

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
  ships as a tab; **what is behind it is deferred**, because PR 4 already carries
  text, generators, Setup, auto-fit and crash recovery, and an effects system on
  top of that is not credible in the time. The colour half of §7's parameter set
  lands anyway as §4 above; the compositing half — per-layer post effects — is
  the deferred part. Promote it into PR 3 if the schedule turns out to have room;
  left deferred at the PR 1 review on 2026-08-11, to be decided when PR 3's real
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
- **The app must run unattended for hours.** Nothing here is soak-tested. PR 5's
  drills are the minimum, not proof.

## Sources

| | |
|---|---|
| `docs/REQUIREMENTS-v1.pdf` | Feature scope, with the operator's inline annotations. Wins over the mockups. |
| `design/mockups.html` | The three MVP surfaces, rendered. Loads `support.js` and `design-system/` from this repo; only the Lucide icon CDN is remote, so offline the layout is right and the glyphs are missing. |
| `design/design-system/` | Tokens, the design-system spec, and 20 components as readable `React.createElement` source. |
| `tools/dancefloor-loops.html` | The generator the app's eleven patterns port. |
| `docs/RUNSHEET-10x5-4P.md` §11 | Frame rate, scaler, fit — and the `--scaler area` finding this plan generalises. |
