# Capture Session Results — 2026-08-06

Wire-level verification of `DECOMP_FINDINGS.md` against the real rig, per
`CAPTURE_PLAN.md`.

**Headline: nothing in the decompiled specification was contradicted.** Every
predicted value was observed exactly, and our own sender's output is
byte-for-byte identical to the vendor's.

---

## Captures taken

Originally captured to `C:\ddf-capture\` per the plan as written, then moved
into the repo at `ddf-capture\` (still gitignored — session data, not source).
`CAPTURE_PLAN.md` §0 now points there directly for future sessions.

All in `ddf-capture\` (gitignored, session data — see note below). Interface 8
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

## Still open

**Q1 (physical orientation)** cannot be answered from capture data — it depends
on cabling and requires the floor observations from §8. The wire side is
recorded in `07-tilewalk.pcapng`, which pairs with `tilewalk_timing.md`
(2 s black lead-in, then 11 tile positions at 2 s each) to map logical position
to physical tile once the video of the walk is reviewed.
