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

| File | Packets | Frames | Source pattern |
|---|---|---|---|
| `01-black.pcapng` | 737 | 45 | `01-black.avi` |
| `02-white.pcapng` | 737 | 45 | `02-white.avi` |
| `03-red.pcapng` | 705 | 43 | `03-red.avi` |
| `06-halves.pcapng` | 737 | 45 | `06-halves.avi` |
| `07-tilewalk.pcapng` | 3809 | 237 | `07-tilewalk.avi`, full 24 s |
| `20-ours-white.pcapng` | 800 | 49 | `Send-FloorTest.ps1 -Pattern white` |

Plus `configure-ini-dump.txt` and `mapper-xml-dump.txt`. Zero packets dropped on
every capture.

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
defect.** In `02-white.pcapng`, frames 36 and 37 (t = 4.037 s, 4.143 s) are
fully black on all 8 ports — exactly 6.0 s after playback began, i.e. the end of
the 60-frame AVI. Ledset sends two all-black frames while the clip restarts.

This is the floor-goes-black-between-loops behaviour that is one of the main
reasons for replacing this software, and the capture pins it down: it is emitted
by the **sender**, not a controller or panel artifact, and it costs about two
frames (~210 ms) every loop. Nothing in the protocol requires it.

> **Requirement for the replacement sender: loops must be gapless.** Never emit
> a blank frame at a clip boundary. Our sender already does not do this.

**2. Ledset does not double-buffer; it emits torn frames.** Same class of
problem, same fix. Frame 3
(t = 0.437 s) is partially white — 16 black triples at the head of port 0's
payload, 15 on port 1, 8 on ports 2–7, white thereafter. That is a spatial
boundary mid-buffer, not a fade, and it is not at a loop boundary. The send
thread reads the capture buffer while the decoder is still writing it. Since
`SendData` has no locking, this is a genuine race in the vendor software.

Net effect: of 45 frames, Ledset sent 42 clean, 2 blank, 1 torn. Our sender sent
49 of 49 identical.

**3. Real-world frame rate is ~9.35 fps, not 10.** Measured interval between
frame starts is ~107 ms, against the `Thread.Sleep(100)` in `ScreenSend.Handler`.
The extra ~7 ms is capture-and-map time, since the sleep is not compensated.
`DECOMP_FINDINGS.md` says "roughly 10 fps", which is accurate — recording the
measured figure for reference. Our sender, which paces properly, achieved a
clean 10.0 fps (50 frames in 5.000 s).

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

## Q4 — within-tile scan order ✅ **CLOSED — identity confirmed**

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

## Colour order on hardware ✅

`-Pattern red` rendered red on the LEDs, matching the BGR wire finding from the
capture side. No `-ColorOrder RGB` correction needed anywhere in the pipeline.

## What remains

Nothing blocking. `07-tilewalk.pcapng` pairs with `tilewalk_timing.md` (2 s black
lead-in, then 11 tile positions at 2 s each) if a full 40-tile map is ever wanted,
but the four corner observations above already determine the transform completely.
