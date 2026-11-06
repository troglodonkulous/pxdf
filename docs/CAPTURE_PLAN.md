# Capture & Verification Session Plan

Everything to do at the Windows machine + floor, in one trip. Read this through
once before starting.

> **This plan changed substantially on 2026-08-05.** The wire protocol has been
> read directly out of the vendor's code (`docs/DECOMP_FINDINGS.md`). The session
> is no longer about *discovering* the mapping — that is settled. It is about
> **verifying it against real hardware** and answering the three things code
> cannot tell us.

**Estimated time:** 60–90 minutes.

---

## What we now know, and what we don't

Settled from code, no longer worth testing:

- 16 packets per frame on this rig — 8 ports × 2 packets, **512 and 458 bytes**.
- Header: `FF | controller | 01 | port | packetIndex(|0x80 on last)`.
- Body is **BGR**. Tiles are column-major; within a tile, plain row-major.
- ~10 fps, no inter-packet delay, no beacon.

The three open questions this session must answer:

| # | Question | How |
|---|---|---|
| **Q1** | **Physical orientation.** Which physical tile is logical `(0,0)`? Is the floor rotated or mirrored relative to what Ledset renders? Code cannot know — it depends on cabling. | Part B, tile walk |
| **Q2** | **Is the end-of-frame flag required?** Does the controller latch on `0x80`, or update continuously? | Part B, §7 |
| **Q3** | **What emits the 966-byte packet?** Provably not this software. | Part A, passive observation |

---

## 0. Before you start

### Safety

> ⚠️ **Power down both controllers before moving any data cable between ports.**
> These outputs are RS-485-style differential drivers. Hot-swapping data lines
> can damage the driver ICs on both the controller and the tile boards.

**No re-cabling is needed for this plan.** Leave the rig exactly as it is.

### Prerequisites

Wireshark from the prior session (v4.6.7 + Npcap 1.88):

```powershell
Test-Path "C:\Program Files\Wireshark\dumpcap.exe"
```

If `False`, install Wireshark (bundles Npcap; Npcap's installer needs
interactive click-through — no silent flag on the free version).

The test sender is at `pxdf\tools\Send-FloorTest.ps1`. Confirm it runs:

```powershell
cd $HOME\OneDrive\Documents\pxdf
.\tools\Send-FloorTest.ps1 -Pattern white -DryRun
```

Expect 16 packets, alternating 512 / 458, last one `byte4 = 0x81`. If PowerShell
refuses to run the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Send-FloorTest.ps1 -Pattern white -DryRun
```

### Working folder

Lives inside the repo at `captures/` (tracked so both machines share the files):

```powershell
cd $HOME\OneDrive\Documents\pxdf
mkdir captures -ErrorAction SilentlyContinue; cd captures
```

---

## 1. Grab vendor config files (2 minutes, do this first)

```powershell
Get-ChildItem -Path C:\Users -Recurse -Filter "Configure.ini" -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.DirectoryName "LedSet.exe") } |
  ForEach-Object { "=== $($_.FullName) ==="; Get-Content $_.FullName } |
  Tee-Object -FilePath .\configure-ini-dump.txt

Get-ChildItem -Path C:\Users -Recurse -Include *.xml -ErrorAction SilentlyContinue |
  Where-Object { Select-String -Path $_.FullName -Pattern "<Mapper" -Quiet -ErrorAction SilentlyContinue } |
  ForEach-Object { "=== $($_.FullName) ==="; Get-Content $_.FullName } |
  Tee-Object -FilePath .\mapper-xml-dump.txt
```

We already have `Test 3.xml` (64×40, `TypeIndex 3` = `8x8_8P`). Grab any others
regardless — a different `TypeIndex` would change the port count.

---

## 2. Capture interface

```powershell
& "C:\Program Files\Wireshark\dumpcap.exe" -D
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength
```

Find the **wired Ethernet** adapter on `10.200.50.78 / 255.0.0.0`. Note its
number; everything below uses `-i N`.

---

## 3. Capture command

```powershell
& "C:\Program Files\Wireshark\dumpcap.exe" -i N -f "udp port 60001" -w .\NAME.pcapng
```

**Procedure — learned the hard way:** start `dumpcap` → *then* do the floor
action → let it run ~3 s → *then* Ctrl+C. Never use a timer and hope the action
lands in the window.

### ⚠️ The analysis mistake that must not be repeated

**Do not group, filter, or summarise packets by length.** Doing exactly that is
what produced two wrong conclusions in earlier sessions:

- it hid the 458-byte packets, making a 16-packet frame look like 8;
- it made header byte 4 look like a constant `0x00`, when it is the packet index;
- it made the 966-byte packet look byte-identical every time.

A frame is **512, 458, 512, 458, …** — mixed sizes by design. Analyse by
`(byte1, byte3, byte4)`, never by length.

---

## Part A — Capture Ledset (25 min)

Verifies our reading of the vendor's output. Leave the rig and the second
controller exactly as they are.

For each: start capture → display the pattern → hold ~3 s → Ctrl+C.

> **Ledset only lists video files.** Its media scanner accepts exactly
> `.MP4 .AVI .FLV .MOV .WMV .MPG` and has no image code path at all, so `.png`,
> `.bmp` and `.gif` never appear in the list however you point it. Every pattern
> below is therefore an **uncompressed 24-bit AVI**. See
> `test-patterns/README.md` for the full reasoning and how to regenerate them.

| # | File | Display in Ledset | Verifies |
|---|---|---|---|
| 1 | `01-black.pcapng` | `01-black.avi` (6 s) | Baseline. Body should be all-`0x00`. **Also: does any 966-byte packet appear, and from which source MAC?** (Q3) |
| 2 | `02-white.pcapng` | `02-white.avi` (6 s) | All-`0xFF` body. Diff vs black isolates pixel bytes. |
| 3 | `03-red.pcapng` | `03-red.avi` (6 s) | ⭐ **Colour order.** Prediction: the *third* byte of each triple is `0xFF` (BGR). If it is the first, the finding is wrong. |
| 4 | `06-halves.pcapng` | `06-halves.avi` (6 s) | Coarse spatial check. Left half white, right half black. |
| 5 | `07-tilewalk.pcapng` | `07-tilewalk.avi`, full 24 s | ⭐ Ground truth for Q1 — see §5. |

Tests 3 and 5 are the ones that matter. If time is short, do those.

> ⚠️ **Test 5 was truncated on 2026-08-06 and the shortfall is still open.** The
> committed `07-tilewalk.pcapng` stops at video t ≈ 16.7 s, having captured only
> rows 1–8 of `test-patterns/tilewalk_timing.md`. Rows 9–11 — `(7,0)`, `(7,4)`,
> `(4,2)` — never reached the wire, so **no capture resolves tile columns 4–7
> individually**. Let the clip run past 24 s and confirm 11 distinct positions
> decode before stopping the capture. See `CAPTURE_RESULTS.md` § "What remains".
>
> ⚠️ **`08-sweep.avi` is worth more than it looks.** Every capture we hold is
> tile-*uniform*, which leaves the intra-tile scan table unconstrained by all of
> them (PROTOCOL.md §4.2). A per-pixel-unique source — `08-sweep.avi`, or better
> the mapper's `gradient24` — is the only thing that would close it. Promote it
> from "useful extra" if there is any time at all.

`04-green.avi`, `05-blue.avi` and `08-sweep.avi` are also in the folder. They are
not required for Part A; `08-sweep.avi` (a one-pixel white column stepping
`x = 0..63`, then a one-pixel white row stepping `y = 0..39`, one frame each at
10 fps) is a useful extra if you want Ledset's own view of scan order to compare
against §9.

### If a pattern does not appear in Ledset's list

Check it without launching Ledset — this runs the same two gates Ledset applies
(extension filter, then a real `VideoGrabber.dll` decode):

```powershell
cd $HOME\OneDrive\Documents\pxdf
.\tools\Test-LedsetCanLoad.ps1
```

Every `.avi` should report `WorksInLedset = True`. If a file is listed in Ledset
but shows "Thumbnail Lost" or plays nothing, it is a codec problem, not a
mapping problem — press **Refresh** in Ledset first (that deletes and rebuilds
the `thn` thumbnail cache; Ledset only builds thumbnails when `thn` is absent).

### Predicted frame shape — check this first

Open `01-black.pcapng` and confirm, for one frame:

```
16 packets. byte0 always 0xFF. byte1 always 0x00 (one controller).
byte2 always 0x01. byte3 cycles 0..7, two packets each.
byte4 alternates 0x00 (len 512) / 0x01 (len 458).
The very last packet of the frame has byte4 = 0x81.
```

**If that matches, the specification is confirmed on the wire** and Part B can
proceed with confidence. If it does not, stop and record exactly how it differs —
that is the most important result of the session.

### The 966-byte packet (Q3)

If it appears, note its **source MAC and IP**. `screenSend.dll` cannot emit a
datagram over 512 bytes, and it is the only networking code in the install — so
if this packet is present, something other than Ledset is producing it. Source
MAC identifies whether it is the PC, a controller, or a third device.

If it never appears, that is equally informative: record its absence.

---

## Part B — Send our own frames (30 min) ⭐

**This is the highest-value part of the session.** It tests the actual
deliverable, not the vendor's software.

> **Stop Ledset playback first.** Two senders broadcasting at once will produce
> nonsense on the floor. Ledset must be closed or stopped, not merely minimised.

Bind explicitly to the wired NIC — the box may have more than one:

```powershell
cd $HOME\OneDrive\Documents\pxdf
.\tools\Send-FloorTest.ps1 -ListInterfaces
```

Then add `-LocalIP 10.200.50.78` to every command below.

### 6. Does our sender work at all?

```powershell
.\tools\Send-FloorTest.ps1 -Pattern white -Duration 5 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern black -Duration 5 -LocalIP 10.200.50.78
```

**If the floor goes white then black, the entire decompiled specification is
confirmed end-to-end** — mapping, header, framing, colour, pacing. That single
result is the goal of the whole project.

If nothing lights: check `-LocalIP`, confirm Ledset is really stopped, and
capture our own output (§3) to compare byte-for-byte against `02-white.pcapng`.

### 7. ⭐ Q2 — Is the end-of-frame flag required?

Run these **in order, without power-cycling between them**:

```powershell
# a. baseline: with the flag, should alternate white/black every 2 s
.\tools\Send-FloorTest.ps1 -Pattern blink -Duration 10 -Hold 2 -LocalIP 10.200.50.78

# b. put the floor in a known black state, flag present
.\tools\Send-FloorTest.ps1 -Pattern black -Duration 3 -LocalIP 10.200.50.78

# c. THE TEST: solid white, flag suppressed
.\tools\Send-FloorTest.ps1 -Pattern white -NoEof -Duration 10 -LocalIP 10.200.50.78
```

| Observation at step c | Conclusion |
|---|---|
| Floor turns **white** | Flag is **not** required — controller updates continuously. Sender may omit it. |
| Floor **stays black** | Flag **is** required — it latches the frame. Sender must set it, exactly once per controller per frame. |
| Floor flickers or partially lights | Something subtler; record precisely what, and capture it. |

Step b matters: without it, a floor "staying white" at step c could just be the
last latched frame from step a. Starting from black makes the result unambiguous.

Then confirm the reverse:

```powershell
.\tools\Send-FloorTest.ps1 -Pattern blink -NoEof -Duration 10 -Hold 2 -LocalIP 10.200.50.78
```

Blinking without the flag would be conclusive proof it is optional.

### 8. ⭐ Q1 — Physical orientation

The mapping from logical pixel to wire is settled. What is **not** settled is
where logical `(0,0)` physically sits, and whether the floor is rotated or
mirrored. Only the floor can say.

```powershell
# light exactly one tile — logical top-left
.\tools\Send-FloorTest.ps1 -Pattern tile -TileCol 0 -TileRow 0 -Duration 8 -LocalIP 10.200.50.78
```

**Note which physical tile lights.** Then:

```powershell
.\tools\Send-FloorTest.ps1 -Pattern tile -TileCol 1 -TileRow 0 -Duration 8 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern tile -TileCol 0 -TileRow 1 -Duration 8 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern tile -TileCol 7 -TileRow 4 -Duration 8 -LocalIP 10.200.50.78
```

Four observations fully determine the transform: origin corner, whether
`TileCol` runs along the floor's long or short axis, and handedness. Sketch the
floor and mark which physical tile lit for each — a phone photo per step is
ideal.

Then the automated walk, to confirm all 40 and catch any per-chain oddity:

```powershell
.\tools\Send-FloorTest.ps1 -Pattern tilewalk -Hold 2 -LocalIP 10.200.50.78
```

It prints `tile (col=N, row=M)` as it goes. **Film the floor** — the video plus
the console log gives the complete tile map in one pass.

### 9. Within-tile pixel order

```powershell
.\tools\Send-FloorTest.ps1 -Pattern pixel -PixelX 0 -PixelY 0 -Duration 8 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern pixel -PixelX 7 -PixelY 0 -Duration 8 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern pixel -PixelX 0 -PixelY 7 -Duration 8 -LocalIP 10.200.50.78
```

Code says the within-tile scan table is the identity for 8×8 floors — no
serpentine. These three confirm it on real LEDs. If pixel `(7,0)` lights at the
wrong end of a row, the tile wiring is serpentine in hardware and the sender
needs a per-tile correction the vendor software does not apply.

### 10. Colour order on real LEDs

```powershell
.\tools\Send-FloorTest.ps1 -Pattern red   -Duration 4 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern green -Duration 4 -LocalIP 10.200.50.78
.\tools\Send-FloorTest.ps1 -Pattern blue  -Duration 4 -LocalIP 10.200.50.78
```

Each should show its named colour. If red and blue are swapped, the controller
is configured for RGB rather than BGR — re-run with `-ColorOrder RGB` and record
which is correct. (The 2013 release notes mention a controller-side colour-order
setting, so either is possible.)

### 11. Frame rate headroom (optional, 2 min)

```powershell
.\tools\Send-FloorTest.ps1 -Pattern blink -Fps 30 -Hold 0.1 -Duration 10 -LocalIP 10.200.50.78
```

The vendor's 10 fps is a bare `Sleep(100)` with no configuration path — likely a
software choice, not a hardware limit. If 30 fps is smooth, the show has far more
headroom than the vendor tool suggests. Worth knowing; not blocking.

---

## 12. Capture our own sender (5 min, do this regardless)

```powershell
# terminal 1
& "C:\Program Files\Wireshark\dumpcap.exe" -i N -f "udp port 60001" -w $HOME\OneDrive\Documents\pxdf\captures\20-ours-white.pcapng
# terminal 2
.\tools\Send-FloorTest.ps1 -Pattern white -Duration 5 -LocalIP 10.200.50.78
```

Diffing `20-ours-white.pcapng` against `02-white.pcapng` byte-for-byte is the
cleanest possible proof of equivalence, and it is worth having even if the floor
behaved perfectly — it will be the reference when the macOS sender is written.

---

## 13. Wrap-up checklist

Already in the shared `pxdf` folder if you followed §0 (no USB stick or copy step
needed) — just confirm everything below is present:

- [ ] `configure-ini-dump.txt`, `mapper-xml-dump.txt`
- [ ] All `*.pcapng`
- [ ] **Orientation notes / photos from §8** — the single most valuable artifact
- [ ] Answers to Q1, Q2, Q3 written down, even if partial
- [ ] Note of anything that contradicted `DECOMP_FINDINGS.md`

```powershell
Get-ChildItem $HOME\OneDrive\Documents\pxdf\captures\*.pcapng | Select-Object Name, Length
```

0-byte or 24-byte files mean nothing was captured — wrong interface number.

---

## 14. If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `.pcapng` is 0/24 bytes | Wrong interface number | Re-run §2 |
| `dumpcap` won't start | Npcap missing / no admin | Run PowerShell as Administrator |
| Script won't run | Execution policy | `powershell -ExecutionPolicy Bypass -File ...` |
| Our sender lights nothing | Wrong NIC | Set `-LocalIP`; verify with §12 that packets are on the wire |
| Our sender lights nothing, packets confirmed on wire | Ledset still sending, or controller in wrong work mode | Close Ledset fully; check controller menu |
| Floor lights but garbled | Orientation or colour order | That is §8 / §10 — record it, it is data not failure |
| Traffic from two sources | Ledset still running | Close it; captures can only be told apart by packet shape |

---

## Deferred: two-controller test

Not needed this session. The second controller has no panels, so it cannot show
anything visually. Multi-controller addressing is already known from code —
controller index is header **byte 1**, and controller `c` owns tile columns
`8c..8c+7`. When spare tiles are available, `-Cols 12` (forcing a second
controller) plus a tile walk across the boundary would confirm it. Low priority:
the target rig's 14 columns will exercise it naturally.
