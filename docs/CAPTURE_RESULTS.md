# Capture Session Results — 2026-08-06

Wire-level verification of `DECOMP_FINDINGS.md` against the real rig, per
`CAPTURE_PLAN.md`.

**Headline: nothing in the decompiled specification was contradicted.** Every
predicted value was observed exactly, and our own sender's output is
byte-for-byte identical to the vendor's.

---

## Captures taken

Originally captured to `C:\ddf-capture\` per the plan as written, then moved
into the repo at `captures/` (tracked — shared across development machines).
`CAPTURE_PLAN.md` §0 now points there directly for future sessions.

All in `captures/`. Interface 8
(`Ethernet`, `10.200.50.78`), filter `udp port 60001`.

| File | Packets | Complete frames | Trailing orphan | Source pattern |
|---|---|---|---|---|
| `01-black.pcapng` | 737 | 46 | 1 | `01-black.avi` |
| `02-white.pcapng` | 737 | 46 | 1 | `02-white.avi` |
| `03-red.pcapng` | 705 | 44 | 1 | `03-red.avi` |
| `06-halves.pcapng` | 737 | 46 | 1 | `06-halves.avi` |
| `07-tilewalk.pcapng` | 3809 | 238 | 1 | `07-tilewalk.avi`, **truncated at ~16.7 s of 24 s** |
| `20-ours-white.pcapng` | 800 | 50 | 0 | `Send-FloorTest.ps1 -Pattern white` |

Plus `configure-ini-dump.txt` and `mapper-xml-dump.txt`. Zero packets dropped on
every capture.

> **Corrected 2026-08-07 — the frame counts above were previously low by exactly
> one on all six captures** (45/45/43/45/237/49). That was not a capture-edge
> artifact: the day's counting method counted frame *transitions*, of which
> there are n − 1. The tell is `20-ours-white`, which has no trailing orphan
> packet at all and was still reported one short. The counts above are
> `mapper/pcapng.py::split_frames`, and the arithmetic closes:
> 46 × 16 + 1 = 737, 44 × 16 + 1 = 705, 238 × 16 + 1 = 3809, 50 × 16 = 800.
> If you re-derive the old numbers, you have reintroduced the off-by-one — the
> code has not regressed.
>
> The trailing orphan is a single seventeenth packet at the tail of each Ledset
> capture, where recording stopped mid-frame. Our own sender stopped cleanly on
> a frame boundary, hence the 0.

Vendor config confirms the assumed geometry: one distinct mapper, `Test 3.xml`,
`Width=64 Height=40`, `TypeIndex 3` (`Pixel8x8_8`), feet indices 7 and 4 →
8 tile columns × 5 tile rows.

---

## Frame shape — the gate in `CAPTURE_PLAN.md` §Part A

Checked against `01-black.pcapng`, and identical in all five Ledset captures:

| Predicted | Observed |
|---|---|
| 16 packets per frame | ✅ every frame, all captures |
| `byte0` always `0xFF` | ✅ |
| `byte1` always `0x00` (one controller) | ✅ |
| `byte2` always `0x01` | ✅ |
| `byte3` cycles `0..7`, two packets each | ✅ |
| `byte4` alternates `0x00` (512 B) / `0x01` (458 B) | ✅ |
| Final packet of frame `byte4 = 0x81` | ✅ packet 15 of every frame |
| Packet sizes 512 / 458 | ✅ exactly, 1:1 ratio |

Payload arithmetic closes: 169 + 151 = 320 triples per port × 8 ports = 2560 px
= 64 × 40. Matches the `Reference rig` table in `DECOMP_FINDINGS.md` line for
line.

Transport: single source `80:69:1a:a3:01:49` / `10.200.50.78` → broadcast
`255.255.255.255:60001`, as `ScreenSendInit` hard-codes.

## Colour order — confirmed BGR

`03-red.avi` is `#FF0000`. Every body triple on the wire reads **`0000FF`** —
`0xFF` in the *third* byte. This is the prediction in `DECOMP_FINDINGS.md`
§Colour order, confirmed. No `-ColorOrder RGB` correction is needed for the
vendor's own path.

`06-halves.avi` (left white / right black) put ports 0–3 fully white and ports
4–7 fully black, consistent with column-major port ordering.

## Q3 — the 966-byte packet

**It never appeared.** Across 7725 captured packets covering all five patterns,
the only payload sizes present were 512 and 458. This is consistent with
`DECOMP_FINDINGS.md`: `SendData` cannot emit a datagram over 512 bytes, and
`screenSend.dll` is the only networking code in the install. Whatever produced
the 966-byte packet in earlier sessions, it was not this software and it was not
transmitting during this session.

---

## §12 — our sender vs the vendor, byte for byte

Comparing one full aligned frame of `20-ours-white.pcapng` against
`02-white.pcapng`:

```
16/16 packets byte-for-byte identical, 0 differing
```

Headers, framing, packet sizes, and all 7680 body bytes match. The only
difference anywhere in the two captures is the ephemeral UDP **source port**
(50532 vs 63835), which is assigned by the OS and carries no protocol meaning.

**The decompiled specification is confirmed end-to-end.** This is the reference
for the macOS sender.

---

## New observations — vendor playback behaviour, not protocol

Neither contradicts the spec; both are artifacts of Ledset's *player*, and both
are worth knowing because they are visible on the floor.

**1. Ledset emits blank frames at video loop boundaries — root cause of a known
defect.** In `02-white.pcapng`, frames 37 and 38 (t = 4.037 s, 4.143 s) are
fully black on all 8 ports — exactly 6.0 s after playback began, i.e. the end of
the 60-frame AVI. Ledset sends two all-black frames while the clip restarts.

*(Frame numbers here and below are zero-based indices among the complete
16-packet frames. They were also corrected on 2026-08-07, by the same n − 1 as
the counts above; the timestamps were right all along.)*

This is the floor-goes-black-between-loops behaviour that is one of the main
reasons for replacing this software, and the capture pins it down: it is emitted
by the **sender**, not a controller or panel artifact, and it costs about two
frames (~210 ms) every loop. Nothing in the protocol requires it.

> **Requirement for the replacement sender: loops must be gapless.** Never emit
> a blank frame at a clip boundary. Our sender already does not do this.

**2. Ledset does not double-buffer; it emits torn frames.** Same class of
problem, same fix. Frame 4
(t = 0.437 s) is partially white — 16 black triples at the head of port 0's
payload, 15 on port 1, 8 on ports 2–7, white thereafter. That is a spatial
boundary mid-buffer, not a fade, and it is not at a loop boundary. The send
thread reads the capture buffer while the decoder is still writing it. Since
`SendData` has no locking, this is a genuine race in the vendor software.

Net effect: of 46 frames, Ledset sent **43 clean, 2 blank, 1 torn**. Our sender
sent 50 of 50 identical.

**3. Real-world frame rate is ~9.2 fps, not 10.** Re-measured 2026-08-07 over
all five Ledset captures: the mean interval between frame starts is
**108.7–109.3 ms** (median 108.8–109.4 ms; the whole distribution sits between
101 and 116 ms), against the `Thread.Sleep(100)` in `ScreenSend.Handler`. The
extra ~9 ms is capture-and-map time, since the sleep is not compensated.
`DECOMP_FINDINGS.md` says "roughly 10 fps", which is accurate.

Our own sender averaged **97.6 ms (10.24 fps)** over `20-ours-white` — the right
rate on average, but jittery: intervals ranged 34–126 ms, with a cluster around
91–97 ms and a tail past 110 ms. Ledset is the *steadier* of the two even though
it is slower. Not a protocol issue and not blocking, but if pacing ever matters,
measure before claiming.

*(This paragraph previously read "~9.35 fps / ~107 ms" for Ledset and "a clean
10.0 fps" for ours. No capture has a mean interval as low as 107 ms; those
figures came from the same day's tooling as the n − 1 frame counts above.)*

---

## Pattern format

The original `.png` patterns could not be used: `MediaListProcessor.CheckIfVideoFile`
accepts only `.MP4/.AVI/.FLV/.MOV/.WMV/.MPG`, and LedSet.exe contains no
image-loading code at all — a PNG in the media folder is skipped silently, with
nothing in the UI to say why. The patterns were regenerated as uncompressed
24-bit BI_RGB AVI ahead of this session; `CAPTURE_PLAN.md` and
`test-patterns/README.md` both document the constraint. All captures above used
the `.avi` files.

---

# Part B — floor observations

Run from the Mac side of the session, watching the physical floor rather than
the wire. These close the questions capture data cannot reach.

## Q1 — physical orientation ✅ **CLOSED**

Four single-tile observations per `CAPTURE_PLAN.md` §8, recorded against a
hand sketch of the floor:

| Sent | Physical tile that lit |
|---|---|
| `-TileCol 0 -TileRow 0` | bottom-right corner, at the cable end |
| `-TileCol 1 -TileRow 0` | one tile **left** of `(0,0)`, along the long axis |
| `-TileCol 0 -TileRow 1` | one tile **up** from `(0,0)`, along the short axis |
| `-TileCol 7 -TileRow 4` | top-left corner — diagonally opposite, as predicted |

**Result: logical `(0,0)` is the bottom-right tile. Logical +X runs
right-to-left; logical +Y runs bottom-to-top.** Both axes are inverted and
neither is transposed, so the transform is a **pure 180° rotation** — no mirror,
no swap of axes.

For the sender:

```
x_wire = (tileCols * 8 - 1) - x_logical
y_wire = (tileRows * 8 - 1) - y_logical
```

Apply at the framebuffer read step, **before** packing. Do not reorder packets to
achieve it — `packetIndex` and `bodyOffset` are defined in port-payload space and
must stay untouched.

`TileCol` running along the long axis is forced by the protocol, not discovered:
`port = tileCol % PORT_COUNT`, and this rig is 8 chains of 5 tiles, so the 8 port
columns can only lie along the 8-tile axis. The genuinely open part was the
origin corner and handedness, which the corner check settles. Physical connectors
1–4 also run right-to-left across the floor.

> On the 14 × 10 target rig this becomes two controllers: columns 0–7 on
> controller 0, columns 8–13 on controller 1. Which physical end is column 0 is a
> **cabling decision at load-in**, so the 180° result here is specific to this
> rig's cabling, not a property of the hardware. Keep it a parameter.

## Q2 — is the end-of-frame flag required? ✅ **CLOSED — it is required**

`CAPTURE_PLAN.md` §7 run in order: blink baseline (worked), black to establish a
known state (worked), then `-Pattern white -NoEof`.

**The floor did not turn white.** It stayed dark except for 3–5 sporadic partial
flickers per 10 s run, each under a second, at irregular intervals. Every flicker
showed the same three features:

1. Illumination began at the **far end of each chain** — the end opposite the
   controller cabling, i.e. the tail of each port's payload.
2. **Dead, unlit pixels** appeared in the white region near its boundary with the
   unlit region.
3. **5–10 pixels at that boundary showed colour** — in a frame whose every source
   pixel is `FFFFFF`.

Point 3 is the diagnostic. Coloured pixels cannot arise from an all-white source
unless a **BGR triple was split mid-write** — one or two of its three bytes
updated to `0xFF`, the third still `0x00`. That is tearing at *byte* granularity,
not packet granularity (which would leave a 169-pixel gap) and not pixel
granularity (which would leave one dark LED).

**Interpretation:** with no `0x80` the controller never latches, so it never
displays a completed frame. The flickers are its self-refresh firing sporadically
and blitting whatever is currently in its receive buffer — a partially filled
one — straight to the LEDs. The fraction of the floor lit at each flicker was
different every time and varied across the whole range, consistent with an
asynchronous refresh cursor with no lock against the incoming writes.

The confirming run, `-Pattern blink -NoEof`, behaved identically — no clean
alternation, same sporadic partial flickers. **Conclusive: bit 7 of byte 4 is the
frame latch.** The sender must set it exactly once per controller per frame.

> Corollary for the macOS sender: because the controller double-buffers on the
> latch, no pacing tricks or inter-packet delays are needed to avoid tearing.
> Set the flag and the controller handles it.

## Q4 — within-tile scan order ⚠️ **two of 64 slots confirmed, table assumed**

`-Pattern pixel -PixelX 0 -PixelY 0` lit the corner tile's bottom-**right**
pixel; `-PixelX 7 -PixelY 0` lit its bottom-**left**. Full tile width apart, same
row, opposite ends — exactly what the identity scan table predicts once the 180°
rotation from Q1 is applied. **No serpentine, no per-tile correction needed.**
Both landed on the bottom row, which is also what the rotation predicts for
logical `y = 0`.

`-PixelX 0 -PixelY 7` was not run. Predicted result: **top-right pixel** of the
same tile. Worth one command at the next floor session to close the second axis,
but the tile-level corner check already rules out a panel mounted rotated in its
frame.

> **Do not read this as the scan table being verified.** Two lit pixels
> constrain 2 of the table's 64 entries, both on row 0. Everything else in the
> table is `InitFloor` in the decompiled source and nothing more — and, per
> "What remains" above, no capture in the repo can corroborate it, because they
> are all tile-uniform. The mutation test is the evidence: permuting the table
> changes no captured byte. Treat the 8 × 8 identity scan as a
> **decompilation-only assumption** until a `gradient24` playback capture
> exists. Flagged in `mapper/floors.py::_identity_scan`.

## Colour order on hardware ✅

`-Pattern red` rendered red on the LEDs, matching the BGR wire finding from the
capture side. No `-ColorOrder RGB` correction needed anywhere in the pipeline.

## What remains

Nothing blocking for the transform: the four corner observations above determine
it completely. Two gaps in *capture* coverage are recorded below, because the
next thing to fail on hardware will look exactly like one of them.

### `07-tilewalk.pcapng` is truncated — tile columns 4–7 are unresolved

`07-tilewalk.avi` is a 24 s video: 2 s black, then 11 tile positions at 2 s each
(`test-patterns/tilewalk_timing.md`). **The capture stops less than halfway
through the walk.** Measured 2026-08-07:

| | |
|---|---|
| complete frames | 238, over a 25.879 s capture span |
| black lead-in | 102 frames (11.0 s) — capture was started well before playback |
| walk positions captured | **8 of 11**, rows 1–8: `(0,0) (1,0) (2,0) (3,0) (0,1) (0,2) (0,3) (0,4)` |
| frames per position | 18 or 19 (2.0 s at the measured ~9.2 fps) |
| last position | `(0,4)`, cut off after 7 frames — capture ends ~0.65 s in, at video t ≈ 16.7 s of 24 s |

Rows **9, 10 and 11 — `(7,0)`, `(7,4)` and `(4,2)` — are absent**, and those are
precisely the positions that would resolve tile columns 7 and 4 on their own.

Consequence, and it is the one to remember: **no capture resolves tile columns
4–7 individually.** `06-halves` constrains them only as a *set* — it puts ports
0–3 white and ports 4–7 black, which any permutation within each half also
satisfies. A mapping error confined to columns 4–7 would pass every test in the
repo. `mapper/tests/test_oracle_capture.py` asserts rows 1–8 exactly and is the
only thing that resolves columns 0–3 at all; see `EXPECTED_WALK` there.

To close it, recapture `07-tilewalk.avi` to completion — the video already
contains the missing positions, so this costs one clean capture run and no new
assets. Extend `EXPECTED_WALK` to all 11 rows when it exists.

### The intra-tile scan table is unconstrained by any capture

Q4 below is a *floor* observation, not a capture result, and it pins 2 of the 64
slots. No capture can do better with the material we hold: `06-halves` splits on
a tile boundary and `07-tilewalk` lights whole tiles, so every capture is
tile-uniform and the scan table is invisible to all of them. Verified by
mutation on 2026-08-07 — permuting the 8 × 8 table (row-reverse, column-reverse,
serpentine) leaves **every** capture-derived metric bit-identical to the control.

Closing it needs a per-pixel-unique `gradient24` playback capture through Ledset.
