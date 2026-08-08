# TP-878 Floor Controller Wire Protocol

Working specification for the LED dance floor controller's proprietary Ethernet
protocol, as used by the vendor's `Ledset` / `Player.exe` Windows software.

**Status legend**

- ✅ **CONFIRMED** — directly observed in a live packet capture, or read from a
  vendor file/binary.
- 🟡 **LIKELY** — strongly supported by evidence, not yet directly proven.
- ❓ **OPEN** — unknown; blocking or semi-blocking.
- ❌ **REFUTED** — previously believed, now disproven.

> **2026-08-05: the protocol was read directly out of the vendor's code.**
> `screenSend.dll` compiled to MSIL and decompiled in full. Everything in §3 and
> §4 now comes from the vendor's own transmit path rather than from inference.
> Details and evidence: **`docs/DECOMP_FINDINGS.md`**.
>
> Claims marked ✅ below are code-derived unless noted. Code tells us what the
> vendor *sends*; it cannot tell us how the floor is physically cabled. See §4.4.

---

## 1. Hardware context

| Property | Value | Status |
|---|---|---|
| Product | TOP Dance TP-878 / TP-M878 pixel dance floor | ✅ |
| OEM software lineage | Kingstar LED (`kingstar-led.com`), controllers KS1000/KS2000/KS3000/KS5000 | ✅ |
| Controller firmware string | `Led Ctrl 3.3` | ✅ |
| Tile | 500 × 500 mm, 8 × 8 = 64 RGB pixels (SMD5050) | ✅ |
| Tile driver board | `DJ-XSP-5V`, SIGNAL+/SIGNAL− differential pair (RS-485 family) | ✅ |
| Controller I/O | Ethernet, 8-ch signal output header, DMX XLR (3-pin), SD slot, IR receiver, Wi-Fi antenna | ✅ |
| Controller physical connectors | **4** | ✅ |
| Logical channels ("ports") per controller | **8** (each connector drives 2 chains) | ✅ |
| Controller work modes | IR (master) / Slave / Sound / DMX / Auto | ✅ |
| Device type profile | `Floor Mir64` | ✅ |
| Multi-controller | `Device Order` 01/02/03…, first = Master, rest = Slave | ✅ |

### Current rig — 10 × 5, `8x8_4P`, three controllers

Re-patched by the user on 2026-08-07. **This replaces the 8 × 5 rig below; that
layout no longer exists.**

- 10 tiles × 5 tiles = **50 tiles**, 5.0 m × 2.5 m. ✅
- Logical resolution **80 × 40 = 3200 pixels**. ✅
- Ledset floor type **`8x8_4P`** (`TypeIndex 2`) — 8 × 8 px tiles, **4 ports**. ✅
- **Three controllers**, Device Order set on each, daisy-chained via the
  controllers' Ethernet `OUTPUT` → `INPUT`. ✅
- The last controller is **partial**: `10 % 4 = 2`, so it drives ports 0–1 only.

Derived, per §3.2:

| | |
|---|---|
| `PORT_COUNT_A_CONTROLLER` | 4 |
| `controllerCount` | `ceil(10/4)` = **3** |
| `lastControlPortCount` | `10 % 4` = **2** |
| tile columns per controller | ctrl 0 → 0–3, ctrl 1 → 4–7, ctrl 2 → 8–9 |
| `portDataSize` | 192 × 5 = 960 |
| packets per port | 2 (512 B then 458 B) |
| packets per frame | (4 + 4 + 2) × 2 = **20** |
| byte 1 values | `0x00`, `0x01`, `0x02` |
| EOF flags per frame | **3** — ctrl0/port3, ctrl1/port3, ctrl2/port1 |
| bytes per frame | 9,700 |

Multiple controllers *and* a partial last controller in one layout. **Neither
has ever been exercised on hardware.** This is the acceptance geometry.

> ⚠️ **Broadcast propagation through the daisy chain is unproven.** The protocol
> is pure broadcast with no addressing beyond byte 1 — every controller must
> receive every packet and keep only its own. If `OUTPUT` → `INPUT` does not
> forward broadcast, controllers 2 and 3 never see a frame. A mis-set Device
> Order has a similar signature: duplicated content rather than an error. Verify
> this first at the floor, before concluding anything about the mapping.

### The 2026-08-06 capture rig — historical

Everything marked ✅ from live capture in this document was observed on **this**
rig, which has since been dismantled. Kept because `captures/` is still the
oracle for the 8-port path.

- 8 tiles × 5 tiles = **40 tiles**. ✅
- Logical resolution **64 × 40 = 2560 pixels**. ✅
- **1 controller, all 4 connectors active**, each running **2 chains of 5
  panels** → 8 chains × 5 tiles. ✅
- A second controller was attached by Ethernet with **no panels connected**. ✅
- Ledset floor type **`8x8_8P`** (`TypeIndex 3`) ✅ — 8 × 8 px tiles, 8 ports.

### Port terminology — settled ✅

| Term | Count | Meaning |
|---|---|---|
| Physical connector | **4** | Sockets on the controller's back panel |
| Logical channel / "port" | **8** | Independent daisy chains; 2 per connector |

The `_8P` floor-type suffix is the **port count**, and the code confirms it:
`PORT_COUNT_A_CONTROLLER` is set to 8 for the `*_8` floor types and 4 for the
`*_4` types. It is a per-floor-type variable, **not a constant** — any sender
must treat it as configuration.

**One port carries one tile column of the logical framebuffer** — `floorsOfRow`
tiles, so 5 tiles of an 8 × 8 type = 320 px = **960 bytes**. ✅

> ⚠️ "Column" here means a column of the **logical** tile grid that Ledset
> renders. Whether that runs vertically or horizontally *on the physical floor*
> is a cabling question — see §4.4.

### Legal envelope

Any `(floor type, tile columns, tile rows)` the mapper UI accepts. Read from
`FloorTypeSet` and confirmed by sweeping the UI:

| Floor type | `TypeIndex` | Tile px | Ports/controller | Max tile columns | Max tile rows |
|---|---|---|---|---|---|
| `6x6_4P` | 0 | 6 × 6 | 4 | 32 | 25 |
| `6x6_8P` | 1 | 6 × 6 | 8 | 32 | 17 |
| `8x8_4P` | 2 | 8 × 8 | 4 | 32 | 22 |
| `8x8_8P` | 3 | 8 × 8 | 8 | 32 | 11 |

2,400 combinations in total. **Only the two 8 × 8 types are in scope** — the
6 × 6 scan table is carried as data so it can drop in later, but there is no
6 × 6 hardware and no claim is made about it.

**Controller count is derived, never chosen:**
`controllerCount = ceil(tileColumns / portsPerController)`. Independent
controller assignment is out of scope; the vendor offers no such control, so
there would be no oracle for it.

### Target rig

- Up to **14 × 10 tiles = 140 tiles** (112 × 80 = 8960 px).
- Arbitrary smaller layouts must also work.

> Note the ceiling: floor type `8x8_8P` permits at most **11 tile rows**. A
> 14 × 10 layout fits; 14 × 12 would not. `8x8_4P` permits 22 rows.

### Units

**Tiles are the unit.** A tile is **500 mm** (19.685 in). Ledset's "feet"
dropdowns treat a tile as 2 ft, which drifts ~2.4% per tile — they are used
only as dropdown *indices*, never as a length. Feet and inches are derived
display values, if wanted at all.

---

## 2. Transport

| Property | Value | Status |
|---|---|---|
| Protocol | UDP | ✅ |
| Destination | `255.255.255.255` (limited broadcast), hard-coded literal | ✅ |
| Destination port | `60001` | ✅ |
| Source | sender's own IP, ephemeral port (observed `10.200.50.78:58835`) | ✅ |
| Controller IP (reported by Ledset UI) | `10.200.50.1`, device name `MIR64` | ✅ |
| Sender subnet | `10.200.50.78 / 8` (255.0.0.0) | ✅ |
| Handshake / discovery | **none** — fire-and-forget broadcast | ✅ |
| ARP / ping response from controller | **none, ever** | ✅ |

The controller never answers ARP or ICMP. It passively listens for broadcast
frames. This is why network scans never find it, and is **not** a fault.

### Socket setup, as the vendor does it ✅

- `SO_BROADCAST` enabled — but **only** when the destination string is literally
  `255.255.255.255`.
- Socket set **non-blocking** (`FIONBIO`).
- `SO_SNDBUF` raised to **1,228,800 bytes**.
- Plain `sendto` per packet. No raw sockets.

### Implications for the sender

- Must set `SO_BROADCAST`.
- Must bind to the correct physical interface — a Mac with both Wi-Fi and
  Ethernet may route broadcast out the wrong one.
- Wi-Fi is not viable: APs commonly drop/ratelimit broadcast traffic.

---

## 3. Packet format

There is **one** packet type. ✅

### 3.1 Frame packet

```
offset  size     field
------  ----     -----------------------------------------------
0       1        0xFF            magic
1       1        controllerIndex 0-based
2       1        0x01            constant
3       1        portIndex       0-based, 0..PORT_COUNT-1
4       1        packetIndex     within this port; bit 7 set on
                                 the last packet of the last port
5       bodyLen  body            BGR pixel bytes
```

- **Datagram length is `bodyLen + 5`.** `bodyLen` is **507** except on the last
  packet of each port, which carries `portDataSize - 507 × packetIndex`. ✅
- **Packets are therefore NOT all 512 bytes.** On the reference rig a frame is
  8 × 512 interleaved with 8 × 458. ✅
- **No padding.** The short final packet is simply short. ✅
- Bit 7 of byte 4 (`0x80`) is set once per controller per frame — an
  **end-of-frame marker**. ✅
- The body is **BGR** ✅ — pixels come from a `BI_RGB` Windows DIB (B,G,R in
  memory) and are copied to the wire with no swap anywhere in the pipeline.
  There is no colour-order setting in this software generation.

### 3.2 One frame, at any geometry ✅

For `C` tile columns × `R` tile rows on a floor type with `P` ports per
controller and `T × T` pixel tiles:

```
bytesPerTile    = T * T * 3
portDataSize    = bytesPerTile * R
packetsPerPort  = ceil(portDataSize / 507)
controllerCount = ceil(C / P)
lastControlPortCount = C % P, or P when that is 0
packetsPerFrame = C * packetsPerPort
bytesPerFrame   = packetsPerFrame * 5 + C * portDataSize
```

Controller `c` drives tile columns `P*c .. P*c+P-1`, except the last, which
drives `lastControlPortCount` of them. **One end-of-frame flag per controller**,
on the last packet of its last active port.

Two worked examples:

| | 8 × 5 `8x8_8P` (capture rig) | 10 × 5 `8x8_4P` (current rig) |
|---|---|---|
| `portDataSize` | 192 × 5 = 960 | 192 × 5 = 960 |
| packets per port | `ceil(960/507)` = 2 | 2 |
| `controllerCount` | `ceil(8/8)` = 1 | `ceil(10/4)` = **3** |
| `lastControlPortCount` | 8 | **2** |
| packets per frame | 8 × 2 = **16** | 10 × 2 = **20** |
| packet 0 of each port | 512 bytes, `byte4 = 0x00` | same |
| packet 1 of each port | 458 bytes, `byte4 = 0x01` | same |
| byte 1 values | `0x00` | `0x00`, `0x01`, `0x02` |
| EOF packets | 1, `byte4 = 0x81` | **3**, each `byte4 = 0x81` |
| bytes per frame | **7,760** | **9,700** |

`mapper/` computes all of this, and its invariant suite checks it across every
one of the 2,400 legal configurations.

### 3.3 There is no beacon ✅

`screenSend.dll` is the **only** networking code in the entire install —
`LedSet.exe`, `Player.exe`, `VideoGrabber.dll`, `EffectThumbnail.dll` and
`IniFileLib.dll` contain no reference to `ws2_32`, `socket`, `sendto` or
`WSAStartup`. The send thread does exactly one thing: capture, map, blast one
frame, sleep 100 ms. There is no keepalive, no timer, no second packet format.

### 3.4 The 966-byte packet — ❓ still unexplained, but not ours

Previously believed a beacon, then suspected to be a full channel payload.
**Both readings are now excluded for this software generation:** the vendor's
send call passes `bodyLen + 5` where `bodyLen ≤ 507`, so **no datagram it emits
can exceed 512 bytes.**

Its 960-byte payload does match `portDataSize` exactly — but that 960 is always
split across two packets and never sent whole. The coincidence is real and
misleading.

Remaining possibilities: the 2013-era `LPlayer` generation; a controller
emitting rather than receiving; or unrelated traffic. **Next step:** identify its
source MAC in a capture. If it is not required, ignoring it costs nothing.

### 3.5 Pacing ✅

- **No inter-packet delay.** All packets of a frame go out back-to-back.
- **~10 fps** — a bare `Thread.Sleep(100)` between frames, with no configuration
  path. 🟡 Likely a software choice rather than a hardware limit.

---

## 4. Mapping — ✅ **RESOLVED**

Logical pixel `(x, y)`, top-left origin, on a floor of `C` tile columns × `R`
tile rows, with `T × T` pixel tiles.

```
tileCol = x / T      xIn = x % T
tileRow = y / T      yIn = y % T

slot         = slotOfSource[yIn * T + xIn]   # identity for 8x8; see §4.2
offsetInPort = tileRow * (T*T*3) + slot * 3

controller  = tileCol / PORT_COUNT
port        = tileCol % PORT_COUNT
packetIndex = offsetInPort / 507
bodyOffset  = offsetInPort % 507
```

For the 8 × 8 types `T = 8`, `slotOfSource` is the identity and
`offsetInPort = tileRow * 192 + (yIn * 8 + xIn) * 3`.

The three bytes at `bodyOffset` are **B, G, R**.

### 4.1 Buffer layout ✅

Tiles are **column-major**: tile `(col, row)` sits at
`(R * col + row) * bytesPerTile`, which is also
`col * portDataSize + row * bytesPerTile`. Consequently one port's payload is
one contiguous tile column, and controller `c` owns tile columns
`Pc .. Pc+P-1`.

### 4.2 Within a tile ✅ (8×8; 6×6 remains decompilation-only)

A `T*T`-entry lookup table maps output slot → source pixel. For **8×8** floor
types it is the **identity** — plain row-major, left-to-right, top-to-bottom,
**no serpentine**. For 6×6 types it is a transpose, `table[k + 6j] = 6k + j`,
which happens to be its own inverse. This proves the table is a real scan remap
and that other floor types differ.

**Closed for the 8×8 types on 2026-08-08** by
`captures/oracle/acceptance-gradient24-identity.pcapng` — a per-pixel-unique
`gradient24` played through Ledset at `8x8_4P` 10×5 and captured, of which 68 of
72 complete frames matched `mapper/floors.py::_identity_scan` byte for byte, the
other 4 being the vendor's own documented loop-boundary blanks and one torn
frame. Per-pixel-unique content is what makes this evidence: it is the property
the two-lit-pixel and fully-lit-square observations lacked. See §8 Q4 and
`PRE-PROBE.md`'s gate-2 Result.

Its earlier support — `InitFloor` in the decompiled source, plus a two-lit-pixel
floor observation (`CAPTURE_RESULTS.md` Q4) pinning 2 of the 64 entries — is now
corroboration rather than the load-bearing argument.

**The 6×6 transpose is still decompilation-only** and no capture constrains it.
There is no 6×6 hardware, so it is unownable — see §7.

An earlier version of this section also cited `captures/07-tilewalk.pcapng` —
"every frame decodes to exactly one fully lit, tile-aligned square". **That is
not evidence for this table and the claim has been withdrawn.** A fully lit
square is uniform, so any permutation *within* the tile decodes to the same
square. Confirmed by mutation on 2026-08-07: row-reverse, column-reverse and
serpentine each leave every capture-derived assertion bit-identical to the
control. The tilewalk capture constrains which *tile* lights, which is §4.1, not
which pixel within it.

The capture named above is exactly the test that paragraph asked for, and the
table survived it. Kept here because the withdrawal is the more useful half of
the record: the failure mode it warns about — a scrambled tile rather than an
obviously dead floor — is why solid colours were never going to close this.

### 4.3 Packet boundaries straddle tiles ⚠️

507 = 3 × 169, so pixels are never split across packets. But on the 8 × 8 types
507 is **not** a multiple of 192, so **tile boundaries are**: 507 bytes = 2 tiles
+ 123 bytes, and a port's second packet begins 41 pixels into its third tile. A
packet body is not a standalone 169-pixel run — it is only meaningful with its
port and packet index.

This gets worse, not better, at larger geometries: a tall floor has more packets
per port, each landing at a different phase within a tile. `packetsPerPort`
reaches 5 at the `8x8_8P` maximum and 9 at the `8x8_4P` maximum.

### 4.4 Physical orientation — a **parameter**, observed once

The above is the **logical** mapping — pixel to wire, exactly as the vendor
sends it. It does not by itself say which physical tile is logical `(0,0)`. That
depends on how the chains are cabled.

On the **2026-08-06 rig**, logical `(0,0)` was the bottom-right tile at the
cable end: +X right-to-left, +Y bottom-to-top, a pure 180° rotation with no
mirror and no transpose (`CAPTURE_RESULTS.md`, Part B / Q1).

> ⚠️ **That rig no longer exists**, and the tool that observed it —
> `tools/Send-FloorTest.ps1` — implements no orientation transform at all. So
> 180° is a *historical observation about one cabling*, not a default. It has
> never been exercised as a code path.

The full parameter, implemented in `mapper/orientation.py`:

| Flag | Meaning |
|---|---|
| `rotate180` | `x → W-1-x`, `y → H-1-y`. The floor is entered from the opposite corner. |
| `mirrorX` | `x → W-1-x`. The grid is handed the other way. |
| `reverseColumnsPerController` | One controller's ports are cabled from its far end, so its tile columns run backwards. Permutes whole tile columns **within one controller's group**; never across a boundary, and never inside a tile. |

**90° and 270° are rejected as physically impossible.** `port = tileCol %
PORT_COUNT` binds tile columns to the port axis, so a quarter turn would require
one port to carry part of every column. `tileCol` was never free — only the
origin corner and handedness were.

Apply the transform at the **framebuffer read step, before packing**. Never
reorder packets to achieve it: `packetIndex` and `bodyOffset` are defined in
port-payload space and must stay untouched.

### 4.5 Hypotheses, closed

| # | Hypothesis | Status |
|---|---|---|
| H1 | `channelIndex` = tile column | ✅ **Correct, for the wrong reason.** Byte 3 is a port index, and a port *is* a tile column of the logical grid. That it also equalled the column count on an 8-wide floor was coincidence. |
| H2 | 4 ports × 2 sub-frames each | ❌ Dead. No sub-frames; 8 real ports. |
| H3 | rolling cell counter | ❌ Dead. |
| H4 | 8 logical channels, one per chain | ✅ **Confirmed**, with 2 packets per channel. |

---

## 5. Vendor software architecture (reference, not to imitate)

| File | Nature | Role |
|---|---|---|
| `LedSet.exe` | .NET 4.0, WPF | Mapper UI + send thread. Namespace `LedSet.Mapper`. |
| `Player.exe` | native | Playback window `LedSet-PlayDlg`. No network code. |
| `screenSend.dll` | **mixed-mode C++/CLI**, 32-bit, compiled to MSIL | **The entire transmit path.** |
| `VideoGrabber.dll` / `EffectThumbnail.dll` / `IniFileLib.dll` | — | Capture, thumbnails, config. No network code. |

### Exports ✅

All `cdecl`, as declared by `LedSet.exe`'s P/Invokes:

```
bool CaptureInit(string winTitle)                       // "LedSet-PlayDlg"
void GetBitmap(byte[] bmpBytes, int width, int height)
bool ScreenSendInit(int floorType, int floorsOfColumn, int floorOfRow)
void SendScreen()
void SreenSendRelease()                                 // vendor's typo
```

`floorType` is the `FloorType` enum: `Pixel6x6_4=0, Pixel6x6_8=1, Pixel8x8_4=2,
Pixel8x8_8=3, Inductive=4, Mirror=5`. The mapper's `TypeIndex` indexes the same
order, so `TypeIndex 3` → `floorType 3`.

**Architectural note:** the `CaptureInit`/`GetBitmap`/`SendScreen` triple shows
the vendor pipeline **screen-captures a desktop region** — specifically a
`mapWidth × mapHeight` area from the bottom-left of the `LedSet-PlayDlg` window,
bailing out entirely if that window is too small. This is the mechanism behind
`ScaleFactorX=0.6` and the class of occlusion/DPI failures. A sender that
generates pixels directly avoids all of it.

### Mapper file format ✅

`Test 3.xml`, referenced by `Release/Configure.ini` → `MapperPath=`:

```xml
<Mapper Width="64" Height="40">
  <TypeIndex>3</TypeIndex>
  <FeetOfWidthIndex>7</FeetOfWidthIndex>
  <FeetOfHeightIndex>4</FeetOfHeightIndex>
</Mapper>
```

- `Width`/`Height` = logical pixels, and are redundant — derivable from the rest.
- `FeetOf*Index` are dropdown indices: `feet = (index + 1) × 2`, then
  `tiles = feet / 2`, so **`index = tiles - 1`**. 7 → 8 tiles; 4 → 5 tiles.
  Ledset's feet are wrong (a tile is 500 mm, not 2 ft); only the index matters.
- Contains **no per-pixel wiring table** — physical wiring order is configured in
  the controller itself.

**Writing this file is a control path, not just a read.** Setting it and
restarting Ledset makes `ReadParam` / `OpenFile` load the geometry with no UI
automation at all — more reliable than driving the mapper page's ComboBoxes.
`mapper/mapper_xml.py` does both directions, byte-identical to the vendor's own
output; `python -m mapper xml --type 8x8_4P --cols 10 --rows 5` emits one.

---

## 6. Refuted / corrected claims ❌

| Claim | Correction |
|---|---|
| Hardware is Linsn or Xixun/Sysolution | ❌ **Kingstar LED** OEM. Search Kingstar KS-series. |
| Frame header is 6 bytes | ❌ **5 bytes.** |
| Body uses RLE / delta compression | ❌ Uncompressed. |
| **"Frame packets are exactly 512 bytes"** | ❌ **Half of every frame is 458 bytes** on this rig. A length-512 filter sees half the frame — this caused two earlier wrong conclusions. |
| **"Byte 4 is always `0x00`"** | ❌ It is the **packet index**, plus a `0x80` end-of-frame flag. It read `0x00` only because analysis kept just the 512-byte packets. |
| **"Byte 1 is a constant `0x00`"** | ❌ It is the **controller index**. It reads 0 because there is one controller. This — not byte 4 — is the device ID. |
| "A full frame is ~16 packets" | ✅ **Confirmed: 16.** But as 8 ports × 2 packets, not 4 ports × 4. |
| "Each port drives 640 px / 2 rows" | ❌ Each port drives **one tile column = 320 px = 960 bytes**. |
| The 966-byte packet is a beacon | ❓ Unexplained, but **provably not from this software** — it cannot emit >512 bytes. |
| The 966-byte packet is a channel payload | ❌ Excluded. `portDataSize` is 960, but always split across 2 packets. |
| Colour order unknown / assumed RGB | ✅ **BGR.** |
| `channelIndex` = tile column (H1) | ✅ Correct after all — byte 3 is a port index, and a port is a tile column. |
| Controller is unreachable / cabling faulty | ❌ Silence is by design. |

---

## 7. Non-goals for v1

- SD-card program format (`.lp`, `CFG_BIN/*.bin`, firmware `.hex`).
- DMX/Art-Net output — retained as an independent show-night fallback.
- `MultiController2` tooling — a factory board-flashing utility, unrelated.

---

## 8. Question log — resolved 2026-08-06 at the floor

All blocking questions are closed. Evidence: `docs/CAPTURE_RESULTS.md`.

| # | Question | Answer |
|---|---|---|
| Q1 | Which physical tile is logical `(0,0)`? Rotation / mirroring? | ✅ Bottom-right at the cable end. **180° rotation**, no mirror, no transpose — see §4.4. Rig-specific; keep it a parameter. |
| Q2 | Is the end-of-frame flag required to latch a frame? | ✅ **Required.** Without it the floor never latches; it shows only sporadic partial flickers with byte-level tearing. Set `0x80` once per controller per frame. |
| Q3 | What emits the 966-byte packet? | ✅ **Nothing in this system.** Absent across 7,725 captured packets covering all five patterns; only 512 and 458 appeared. Ignore it. |
| Q4 | Is the per-tile scan really non-serpentine on real LEDs? | ✅ **Closed 2026-08-08.** The old ⚠️ stood because every capture was tile-uniform and could not corroborate the table. `captures/oracle/acceptance-gradient24-identity.pcapng` is per-pixel-unique and matched `_identity_scan` on 68 of 72 frames byte for byte — a serpentine, or any other permutation of the 64 entries, mismatches inside every tile of every frame. The wire now pins the whole table, not 2 of 64. |
| Q5 | Does the controller accept faster than 10 fps? | ✅ **Closed — not pursued.** 10 fps is settled as the operating rate. Ledset measures ~9.2 fps actual (mean 108.7–109.3 ms between frame starts); ours averages 10.24 fps but with more jitter. See `CAPTURE_RESULTS.md`. Do not spend floor time on it. |
| Q6 | Brightness / gamma — is there any control? | ✅ **Closed 2026-08-08 for the playback path.** Every earlier capture was saturated-only (black/white/red/halves), and `0x00`/`0xFF` are fixed points of any brightness scale or gamma LUT, so nothing before this constrained intermediate values *at all*. `acceptance-gradient24-identity` is almost entirely intermediate values and matched byte for byte: **Ledset applies no transform on the video→wire path.** Whether the controller applies one downstream is unobservable from the wire and would show as a floor-brightness question, not a protocol one. |

Colour order was additionally confirmed on real LEDs — `-Pattern red` renders
red, matching the BGR wire finding. No `-ColorOrder RGB` correction is needed.

### Vendor playback defects — requirements for the replacement

Not protocol facts, but observed on the wire and visible on the floor. Both are
bugs in Ledset's *player*, and the replacement must not reproduce them:

- **Blank frames at every loop boundary.** Ledset emits two all-black frames
  (~210 ms) while a clip restarts. This is the floor-goes-black-between-loops
  defect, and it is sender-side — nothing in the protocol requires it.
  **Loops must be gapless.**
- **Torn frames.** `SendData` has no locking, so the send thread reads the
  capture buffer while the decoder is still writing it. 1 of 45 observed frames
  was torn. **The sender must double-buffer.**

---

## 9. Sources

- **`docs/DECOMP_FINDINGS.md`** — full decompilation of `screenSend.dll` and
  `LedSet.exe` (ILSpy). Primary source for §3, §4, §5.
- **`mapper/`** — the geometry-independent implementation of this spec, in
  Python. Invariants green across all 2,400 legal configurations; byte-identical
  to Ledset's captured frames. Emits the conformance fixtures in `fixtures/`
  that the Swift engine will be graded against.
- `tools/Send-FloorTest.ps1` — independent implementation, used to verify the
  spec against hardware at 8 × 5 `8x8_8P`. Kept deliberately dumb — raw
  protocol, no orientation transform — as the control for isolating whether a
  fault at the floor is in the mapping or in the orientation layer.
- Live Wireshark/`pktmon` captures, prior session.
- `LPlayer-sub-window-rev1436/ReleaseNote.txt` (Kingstar attribution).
- `TOP DANCE PIXEL LED DANCE FLOOR MANUAL-878.pdf` (via prior session).
