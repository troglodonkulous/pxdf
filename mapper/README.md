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

# regenerate the conformance fixtures. Refuses to overwrite an existing set —
# add --force, and only for a reviewed contract change. See "Fixtures" below.
python -m mapper fixtures --out fixtures

# a Ledset mapper XML, for driving the oracle without UI automation
python -m mapper xml --type 8x8_4P --cols 10 --rows 5 --out "…/Test 3.xml"

# diff a capture against what we would have sent
python -m mapper verify captures/02-white.pcapng \
    --type 8x8_8P --cols 8 --rows 5 --pattern white

# send. --dry-run prints the plan and a sha256 of frame 0, and touches nothing.
python -m mapper send --type 8x8_4P --cols 10 --rows 5 \
    --pattern gradient24 --duration 5 --dry-run

# play a video. The clip must already be an uncompressed 24-bit AVI at the
# floor's exact resolution — `python -m tools.make_clip` converts anything else.
# With no time flag this plays the clip exactly once.
python -m mapper play tools/oracle/media/09-gradient24-8x8_4P-10x5.avi \
    --type 8x8_4P --cols 10 --rows 5

# how long to send: three mutually exclusive ways, and one full pass by default.
#   --loop N       exactly N passes, an exact frame count, no float rounding
#   --forever      until Ctrl-C, which prints a packet count, not a traceback
#   --duration S   seconds, as `send` does
python -m mapper play <clip> --type 8x8_4P --cols 10 --rows 5 --forever

# convert real media. Defaults are `--scaler area --fit cover --fps 30`, all
# three settled on the floor — see "Frame rate, scaler and fit" below.
python -m tools.make_clip "input.mp4" out.avi --type 8x8_4P --cols 10 --rows 5
```

`play` and `send` are the same send path with a different frame source, so on a
clip that holds `gradient24` the two print the same frame-0 digest. That is the
acceptance bar for the cutover off Ledset, and it is checkable from disk with no
hardware.

### Frame rate, scaler and fit

All three were decided at the floor on 2026-08-08, attended, not by reasoning
here. The rate ceiling probe played a sweep at 10 / 15 / 24 / 30 / 60 fps and
**the floor dropped no frames at any of them** — 10 fps was never a ceiling,
only the vendor's habit. Real content is dramatically better above 10 and
essentially identical from 15 to 30; 60 renders every frame and still judders on
fast hard-edged motion, for no gain over 30.

- **`DEFAULT_FPS = 30`**, and `tools/make_clip.py` inherits it so the two cannot
  drift.
- **`play` sends at the clip's own authored rate by default**, read from the
  video stream's `strh`, capped at `MAX_ADOPTED_FPS = 30`. A clip sent at a rate
  it was not authored for plays at the wrong speed, and **no byte comparison in
  this project can see that** — every individual frame is correct and only the
  spacing between them is wrong. An explicit `--fps` wins and is never capped.
- **`--scaler area`** for real footage. A 1080p source is 24× the floor's width
  and 4K is 48×; `neighbor` at 48:1 keeps one pixel per 48×48 block and reads as
  crawling noise. Use `neighbor` only for a source already at floor resolution,
  such as `tools/oracle/make-gradient-avi.ps1` output.
- **`--fit cover`**. `letterbox` leaves exactly 9 of the floor's 80 columns
  permanently black (columns 0–3 and 75–79, measured); on a surface people stand
  on that reads as the floor being broken, while `cover`'s 5-row crop goes
  unnoticed. `letterbox` remains for full-bleed content whose edges carry meaning.

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
| `avi.py` | Dependency-free AVI reader, uncompressed 24-bit only. Exists so the oracle's tile-walk sequence is read from the video Ledset played rather than transcribed. |
| `video.py` | The seam `play` is built on: DIB scanlines → RGB framebuffers, decoded once up front so nothing sits on the send loop. |
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
  source video showed: `06-halves` is a clean vertical split, and `07-tilewalk`
  decodes to one fully lit, tile-aligned square per frame, visiting tiles in
  **exactly** the order the video lights them, for ~2 s each.

That last sequence is not typed into the test. `mapper/avi.py` reads
`test-patterns/07-tilewalk.avi` — the file Ledset actually played — reduces each
of its 240 frames to the one tile it lights, and collapses that to 11 runs of 20
frames; the capture's decoded run sequence is asserted to be a *prefix* of it.
The point is provenance: `tilewalk_timing.md` is **generated** from the same
`positions` list that renders the video, so asserting against the timing sheet
would have been circular in exactly the way that produced this project's five
self-consistent-but-wrong conclusions. It also means the recapture that closes
tile columns 4–7 needs no code edit — the prefix just gets longer.

That last check is the one that matters. A solid colour cannot detect a
permutation — every wrong mapping of a white frame is still a white frame. The
same sampling bias produced two earlier self-consistent-but-wrong conclusions
(the "512-byte packet" and "byte 4 always 0x00" findings). Fixtures therefore
use `gradient24`, which is unique per pixel.

### What `07-tilewalk` does and does not constrain

It is the only capture that resolves *individual* tiles, so the ordered-sequence
assertion above is the only thing in the suite that can kill a permutation of
the tile grid. Verified by mutation: swapping tile columns pairwise in
`frame.py::_port_offset` (0↔1, 2↔3, 4↔5, 6↔7 — every column on the wrong port),
or reversing tile rows within each port, now fails `test_oracle_capture`. Before
the ordering assertion existed, both mutations passed every capture-based test
and were caught only by `test_fixtures`.

It does **not** extend to controller placement, and must not be read as doing
so. The oracle rig is 8 tile columns at 8 ports per controller — *one*
controller — so every controller-level permutation is a literal no-op there.
Measured: `swap_ports_on_ctrl_ge1` (ports 0↔1 on every controller except 0)
leaves `send_buffer_sources` bit-identical at 8×5 `8x8_8P` and changes it at
10×5 `8x8_4P`. `tile_col -> (controller, port)` being one `divmod` makes it the
same *mechanism*, which is not the same *evidence*.

Three things it still does not reach, all measured, not assumed:

- **Tile columns 4–7 are pinned only as a set**, by `06-halves`.
  `07-tilewalk.pcapng` is truncated — 238 frames over 25.9 s, stopping ~0.65 s
  into position 8 — so rows 9–11 of the timing sheet (`(7,0)`, `(7,4)`,
  `(4,2)`), the ones that would resolve columns 7 and 4 individually, were never
  captured.
- **Controller ordering is unconstrained by anything pre-hardware**, see above.
- **The 8 × 8 intra-tile scan table is invisible to every capture we hold.**
  Each lit tile is uniformly white, so row-reverse, column-reverse and
  serpentine all decode identically; all three were mutated and left every
  capture-based assertion bit-identical to the control.

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
- **The intra-tile scan table is a decompilation-only assumption**, at every
  floor type. `InitFloor` in the vendor source says identity for 8 × 8. The
  floor observation in `CAPTURE_RESULTS.md` Q4 is weaker than it has been
  described as: **both its pixels are on tile row 0**, where serpentine and
  identity agree exactly (`scan_table[0] = 0`, `scan_table[7] = 7` under both).
  Q4 excludes row-reverse and column-reverse; it is zero evidence against
  serpentine, which is the most common real tile wiring and therefore the
  leading alternative. The discriminating observation is a pixel off row 0 —
  `-PixelX 0 -PixelY 7`, already written into `docs/CAPTURE_PLAN.md` §9, not yet
  run. No capture we hold constrains it and none can — see above.
  `test_derived.test_scan_tables`
  compares it against the constant the code was written to emit, so it detects
  drift and proves nothing. Closing it needs a per-pixel-unique `gradient24`
  Ledset playback capture, which needs hardware and an attended session.
- **Tile columns 4–7 have never been resolved individually by any capture**, and
  no multi-controller layout has been observed at all. The 10 × 5 `8x8_4P` run
  is the first test of either. **These two are not equally open.** Columns 4–7
  are a `divmod` with no mechanism by which they could be permuted while 0–3 are
  right — they are unproven but not suspect, and the truncated `07-tilewalk`
  recapture closes them. **Controller ordering is the one most likely to be
  wrong in reality**: it is decided by cabling at load-in, not by code, so
  nothing in this repo can predict it. Note that
  `test_derived.test_controller_owns_its_tile_columns` is false comfort — it
  asserts only the *sets* `{0:{0,1,2,3}, 1:{4,5,6,7}, 2:{8,9}}`, which both
  surviving controller-level mutations satisfy. Only hardware settles it.

## Fixtures

`fixtures/` is the contract any reimplementation of the mapping is graded
against. It was written when a Swift port was the plan; that plan is retired
(`docs/APP-PLAN.md`) and the fixtures outlived it, because outside the captured
geometry they are still the only thing that would notice a tile column landing
on the wrong port.

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

**Do not regenerate to make `test_fixtures` go green.** Outside the single
geometry the captures cover (8 × 5 `8x8_8P`), these committed bytes are the only
thing in the suite that would notice a tile column landing on the wrong port or
the wrong controller — the invariants only check that the mapping is a
bijection, which a permuted mapping still is. A red `test_fixtures` is that
alarm firing. `python -m mapper fixtures` therefore refuses to overwrite an
existing set; `--force` is for a contract change you have already reviewed, and
the fixture diff belongs in the same commit as the code that caused it.

Note the limit of the alarm: the fixtures were emitted by this same code, so it
detects *drift*, not a day-one error. A mapping bug present when they were first
generated would have been baked into the committed bytes with every test green.
Only the captures can catch that, and only where they have spatial resolution.

## Relationship to `tools/Send-FloorTest.ps1`

At the floor, **Python is primary and the PS1 is the fallback**. The PS1 stays
exactly as it is — no orientation transform, no generalisation beyond what it
already has. Its value is that it is dumb: raw protocol, known byte-identical to
Ledset at 8 × 5 `8x8_8P`. Two independent implementations of the orientation
transform is how you get a discrepancy you cannot diagnose at 1am.
