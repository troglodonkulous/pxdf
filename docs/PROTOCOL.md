# TP-878 Floor Controller Wire Protocol

Working specification for the LED dance floor controller's proprietary Ethernet
protocol, as used by the vendor's `Ledset` / `Player.exe` Windows software.

**Status legend**

- ✅ **CONFIRMED** — directly observed in a live packet capture, or read from a
  vendor file/binary.
- 🟡 **LIKELY** — strongly supported by evidence, not yet directly proven.
- ❓ **OPEN** — unknown; blocking or semi-blocking.
- ❌ **REFUTED** — previously believed, now disproven.

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
| Logical channels per controller | **8** (each connector drives 2 chains) | ✅ |
| Controller signal header | 8-channel | ✅ |
| Controller work modes | IR (master) / Slave / Sound / DMX / Auto | ✅ |
| Device type profile | `Floor Mir64` | ✅ |
| Multi-controller | `Device Order` 01/02/03…, first = Master, rest = Slave | ✅ |

### Reference rig (used for all captures to date)

Physically verified by the user, 2026-08-05:

- 8 tiles wide × 5 tiles tall = **40 tiles**, 16 ft × 10 ft. ✅
- Logical resolution **64 × 40 = 2560 pixels**. ✅
- **1 controller, all 4 connectors active.** Each connector runs to **2 rows of
  5 panels**. ✅
- A second controller is attached by Ethernet with **no panels connected**. ✅
- Ledset floor type **`8x8_8P`** ✅ — 8 × 8 px tiles, **8 channels**.

### Port terminology — settled ✅

The "4 vs 8 ports" contradiction is resolved: **both were right about different
things.**

| Term | Count | Meaning |
|---|---|---|
| Physical connector | **4** | Sockets on the controller's back panel |
| Logical channel | **8** | Independent daisy chains; 2 per connector |

The `_8P` floor-type suffix counts **logical channels**. The manual's
"8-channel signal output interface" says the same. A prior session's "4 ports,
each feeding a 2-column section" was the same fact seen on a differently-oriented
floor — 2 chains per connector either way.

**Consequence:** one channel = **1 row of 5 tiles** = 320 px = **960 bytes**.
That is exactly the 966-byte packet's payload size — see §3.2.

### Target rig

- Up to **14 × 10 tiles = 140 tiles** (112 × 80 = 8960 px).
- **2 controllers × 4 ports**, master + slave. Sometimes only 1 controller.
- Arbitrary smaller layouts must also work.

---

## 2. Transport

| Property | Value | Status |
|---|---|---|
| Protocol | UDP | ✅ |
| Destination | `255.255.255.255` (limited broadcast) | ✅ |
| Destination port | `60001` | ✅ |
| Source | sender's own IP, ephemeral port (observed `10.200.50.78:58835`) | ✅ |
| Controller IP (reported by Ledset UI) | `10.200.50.1`, device name `MIR64` | ✅ |
| Sender subnet | `10.200.50.78 / 8` (255.0.0.0) | ✅ |
| Handshake / discovery | **none** — fire-and-forget broadcast | ✅ |
| ARP / ping response from controller | **none, ever** | ✅ |

The controller never answers ARP or ICMP. It passively listens for broadcast
frames. This is why network scans never find it, and is **not** a fault.

> Port `60001` also appears (as a typo, `PORT=600001`) in the 2013-era
> `LPlayer-sub-window-rev1436/Configure.ini`, alongside `IP=10.0.0.5`. The
> transport has been stable across two software generations.

### Implications for the sender

- Must set `SO_BROADCAST` on the socket.
- Must be bound to the correct physical interface — a Mac with both Wi-Fi and
  Ethernet may route broadcast out the wrong one.
- Wi-Fi is not viable: APs commonly drop/ratelimit broadcast traffic.

---

## 3. Packet formats

Two distinct packet types share the wire.

### 3.1 Frame packet (pixel data) — 512 bytes ✅

```
offset  size  field
------  ----  -----------------------------------------------
0       1     0xFF          magic / start
1       1     0x00          constant
2       1     0x01          constant  (protocol or opcode?)
3       1     channelIndex  observed cycling 0..7
4       1     0x00          constant  ❓ (candidate: controller/device ID)
5       507   body          raw RGB, 169 pixels × 3 bytes
```

- Total **exactly 512 bytes**, invariant across all content. ✅
- Body length **exactly 507 bytes** regardless of content — rules out RLE,
  delta, or any variable-length compression. ✅
- `507 / 3 = 169` pixels per packet, decoded as flat RGB triplets. Verified by
  decoding many frames and observing spatially coherent, smoothly varying
  brightness, including a visible scene-change event matching a playlist
  advance. ✅

❓ **Channel order within the body** (RGB vs GRB vs BGR) is not yet confirmed.
The 2013 release notes mention a per-controller "RGB colour order" setting,
so this is likely configurable in hardware and must be verified empirically.

### 3.2 The 966-byte packet — ❓ **contested: beacon, or a full port payload?**

```
offset  size  field
------  ----  -----------------------------------------------
0       6     FF 00 01 00 00 4B    header (as observed)
6       960   0xFF repeated        payload
```

- Observed byte-for-byte identical every time, **including across scene
  changes**. ✅
- Emitted in very rapid bursts (~100 µs spacing observed). ✅

**Interpretation A — keepalive beacon** (prior session's conclusion). Constant
content across scene changes implies it carries no pixel data.

**Interpretation B — one channel's complete payload, all white** 🟡 *(now
favoured)*. Each logical channel drives **1 row of 5 tiles** = 320 px, and
`320 × 3 = 960 bytes` — **exactly** the payload size, now confirmed against the
physical rig (§1). Under this reading the packet is not a beacon at all; it is
an ordinary per-channel frame that happened to be all-white.

Why B is credible despite A's evidence: packets were grouped **by size** during
analysis, so a single all-white port's packet would appear "identical every
time" while other 966-byte packets carrying real content varied. That is
sampling bias, not proof of constancy.

⚠️ **Consequence if B holds:** implementing a beacon emitter is wasted work, and
worse, the real per-port packet size may be **960 bytes, not 507**. The 512-byte
packets would then be a *different* mode or geometry, not the primary path.

**How to settle it:** in a capture of `01-black.png` (all-black floor), a beacon
would still be all-`0xFF`; a port payload would be all-`0x00`. **One test, one
answer.** This is now a primary goal of capture test 1.

> ⚠️ Note the ambiguity: the beacon's 6-byte header ends in `0x4B`, whereas the
> frame packet's header is 5 bytes and byte 5 is `0x00`. A prior session
> initially mis-read the frame header as 6 bytes by analogy with the beacon,
> consuming the first data byte. The 5-byte frame header is the corrected,
> capture-verified value.

---

## 4. The open question: channel → physical mapping ❓

**This is the sole blocker.** Everything else is understood well enough to build.

### What is known

- `channelIndex` (byte 3) was observed taking values **0 through 7** on a
  1-controller, 4-port, 8×5 rig.
- That rig's Ledset mapper showed **4 physical output ports**, each feeding a
  2-column-wide (equivalently, on the target rig, 2-row-tall) section.
- 8 observed indices over 4 physical ports = **2 indices per port**.

### Competing hypotheses

| # | Hypothesis | Status |
|---|---|---|
| H1 | `channelIndex` = tile column | ❌ **Dead.** The rig has 8 physical chains; that they numbered 8 like the columns was coincidence. |
| H2 | 4 ports × 2 sub-frames each | ❌ **Dead.** There are no sub-frames — the 8 "channels" are 8 real, physically distinct daisy chains. |
| H3 | rolling cell counter, not a port ID | 🟡 Still possible but unlikely, given 8 chains exist and indices run 0–7. |
| **H4** | **`channelIndex` = logical channel 0–7, one per 5-tile chain** | 🟡 **Strongly favoured.** |

**H4 in detail.** Each of the 8 logical channels drives one row of 5 tiles =
320 px = 960 bytes. Two sub-cases remain, distinguished only by §3.2:

- **If the 966-byte packet is a payload (Interpretation B):** one packet per
  channel, 960-byte payload, **8 packets/frame**. The 512-byte packets are a
  different mode or geometry.
- **If it is a beacon (Interpretation A):** `⌈960 / 507⌉ = 2` packets per
  channel, **16 packets/frame**. The prior attempt sent one → 169 of 320 px =
  **53%** of the floor, matching its half-dark symptom exactly.

> ⚠️ Note these predict **different packet counts** (8 vs 16). The "~16 packets"
> conclusion recorded earlier is therefore *conditional*, not settled. Test 1
> (all-black capture) decides which, and it must be run before any sender is
> written.

### Arithmetic that discriminates

- Floor = 2560 px. At 169 px/packet → **15.15 packets minimum** for a full frame.
- Prior implementation sent **8** packets/frame → at most 1352 px ≈ **53%** of
  the floor.
- Observed symptom: **roughly half the floor lit, the rest completely dark**
  (not garbled). ✅

🟡 **Leading conclusion:** a full frame requires **~16 packets, not 8**. Per port:
640 px ÷ 169 = 3.79 → **4 packets per port**; 4 ports × 4 = **16 packets/frame**.
The prior session sent exactly half that, and lit exactly half the floor.

This is consistent with H2 (two *pairs* of sub-frames per port) or H3, and
inconsistent with H1.

### How to settle it

1. **Capture an all-black floor.** If the 966-byte packet is still all-`0xFF`,
   it is a beacon (Interpretation A). If it becomes all-`0x00`, it is a port
   payload (Interpretation B), and the real per-port packet is 960 bytes rather
   than 507. *(one test, decisive, and it reshapes everything downstream)*
2. **Count packets between frame boundaries.** If ~16 (not 8), H1 is dead.
   *(cheap)*
3. **Walk a single lit tile across the floor**, capturing at each position, and
   note which packet index + body offset changes. This yields the mapping
   directly, tile by tile. *(definitive — separates H2 from H4)*
4. **Read `PixelFloor::FillSendBuf`** in `screenSend.dll` — the mapping loop is
   in there as code.
5. ~~Count the physical output connectors.~~ ✅ **Done** — 4 connectors, 8
   chains. See §1.

---

## 5. Vendor software architecture (for reference, not to imitate)

Install at `Dance Floor/Release/`:

| File | Nature | Role |
|---|---|---|
| `LedSet.exe` | .NET 4.0, WPF | Mapper UI. Namespace `LedSet.Mapper`, `MapperFile`/`PortCount`/`FloorCountPerPort`, XML-serialised. |
| `Player.exe` | native (PDB path `D:\P20119\LedSet\LedSet\bin\Release\Player.pdb`) | Playback window `LedSet-PlayDlg`. |
| `screenSend.dll` | **mixed-mode C++/CLI**, 32-bit | **The transmit path.** See symbol table below. |
| `VideoGrabber.dll` | native | Screen/video capture. |
| `EffectThumbnail.dll` | native | Thumbnails. |
| `IniFileLib.dll` | .NET | Config I/O. |

**Architectural note:** the `CaptureInit` / `GetBitmap` / `SendScreen` export
triple shows the vendor pipeline **screen-captures a desktop region** and streams
those pixels. It has no content pipeline of its own. A bespoke sender that
generates pixels directly avoids an entire class of failure (window occlusion,
DPI scaling, `ScaleFactorX=0.6`, codec dependencies such as the bundled K-Lite
pack) rather than having to fix them.

### `screenSend.dll` symbols ✅

Recovered by string/metadata analysis (not yet decompiled).

```
Exports:  ScreenSendInit  CaptureInit  GetBitmap  SendScreen  SreenSendRelease (sic)

PixelFloor::FillSendBuf      ⭐ the pixel → packet mapping function
InitFloor, SendData          anonymous-namespace statics
floorsOfColumn, floorsOfRow  likely ScreenSendInit parameters (tile grid dims)
portDataSize                 bytes per port      ⭐
controllerDataSize           bytes per controller
controllerCount              multi-controller support
PORT_COUNT_A_CONTROLLER      ports per controller ⭐
lastControlPortCount         partial last controller?
pSendPack, pSendDat, sendDatBuf, pFloor    send buffers
UdpSocket::init_socket_client / ::send / m_Port
"255.255.255.255"            broadcast address, hardcoded literal ✅
sendto, inet_addr, ioctlsocket, closesocket
```

`PixelFloor::FillSendBuf` is the single most valuable target in the project — it
is the mapping, as code.

### `LedSet.exe` floor-type enum ✅

```
FloorTypeSet:  Pixel6x6_4   Pixel8x8_4   Pixel6x6_8   Pixel8x8_8
UI labels:     "6x6_8P"     "8x8_4P"     "8x8_8P"
Also:          PortCount  FloorCountPerPort  CalcFloorsOfColumn  CalcFloorsOfRow
```

Naming decodes as `<tile pixel dims>_<port count>P`. So `8x8_8P` (our
`TypeIndex 3`) = 8 × 8 px tiles, **8 ports** — the basis for hypothesis H4.
The existence of both `_4` and `_8` variants means **port count is a genuine
per-floor-type variable**, not a fixed constant. Any sender must treat it as
configuration.

### Mapper file format ✅

`Test 3.xml`, referenced by `Release/Configure.ini` → `MapperPath=`:

```xml
<Mapper Width="64" Height="40">
  <TypeIndex>3</TypeIndex>
  <FeetOfWidthIndex>7</FeetOfWidthIndex>
  <FeetOfHeightIndex>4</FeetOfHeightIndex>
</Mapper>
```

- `Width`/`Height` = logical pixels (8 px per tile × tile count).
- `TypeIndex` 3 ↔ floor type `8x8_8P`.
- `FeetOf*Index` are **dropdown indices, not feet**: `feet = (index + 1) × 2`.
  So 7 → 16 ft (8 tiles), 4 → 10 ft (5 tiles).
- Contains **no per-pixel wiring table** — physical wiring order is configured
  in the controller itself, not here.

---

## 6. Refuted / corrected claims ❌

| Claim | Correction |
|---|---|
| Hardware is Linsn or Xixun/Sysolution | ❌ It is **Kingstar LED** OEM (`kingstar-led.com`), per `ReleaseNote.txt`. Search Kingstar KS-series, not Linsn. |
| Frame header is 6 bytes | ❌ **5 bytes.** The 6th byte is the first data byte. (6 bytes is the *beacon* header.) |
| Body uses RLE / delta compression | ❌ Fixed 507-byte body proves uncompressed raw RGB. |
| `channelIndex` = tile column (H1) | ❌ Dead — the 8 indices are 8 physical chains, not columns. |
| 4 ports × 2 sub-frames (H2) | ❌ Dead — no sub-frames exist; there are 8 real chains. |
| "The controller has 4 ports" / "…has 8 ports" | Both partly right: **4 physical connectors, 8 logical channels** (2 chains per connector). ✅ Verified physically. |
| "A full frame is ~16 packets" | ⚠️ **Conditional, not settled.** 16 only if the 966-byte packet is a beacon; **8** if it is a channel payload. See §3.2 and §4. |
| The 966-byte packet is a keepalive beacon | ❓ Contested. Its 960-byte payload is exactly one 5-tile chain — it may be an ordinary channel payload that happened to be all-white. See §3.2. |
| Controller is unreachable / cabling faulty | ❌ Silence is by design; the protocol is broadcast and the controller never replies. |
| 965-byte single-packet-per-frame framing | ❌ Real framing is many fixed 512-byte packets. |

---

## 7. Non-goals for v1

- SD-card program format (`.lp`, `CFG_BIN/*.bin`, firmware `.hex`) — the live
  streaming path makes this unnecessary.
- DMX/Art-Net output — retained as an independent **show-night fallback** via
  the controller's XLR input, not as the primary path.
- `MultiController2` tooling — a factory board-flashing utility (BOM/SMT/RDM),
  unrelated to show control.

---

## 8. Sources

- Live Wireshark/`pktmon` captures, prior session (`DistinctiveDanceFloor/SESSION_TRANSCRIPT.md`).
- Vendor binaries and config files under `Dance Floor/` (string/PE analysis).
- `LPlayer-sub-window-rev1436/ReleaseNote.txt` (Kingstar attribution, KS controller families, UDP + DMX clock references).
- `TOP DANCE PIXEL LED DANCE FLOOR MANUAL-878.pdf` (via prior session).
