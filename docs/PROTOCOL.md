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
| Controller physical output ports | **4** (each feeding a multi-tile daisy chain) | ✅ |
| Controller work modes | IR (master) / Slave / Sound / DMX / Auto | ✅ |
| Device type profile | `Floor Mir64` | ✅ |
| Multi-controller | `Device Order` 01/02/03…, first = Master, rest = Slave | ✅ |

### Reference rig (used for all captures to date)

- 8 tiles wide × 5 tiles tall = **40 tiles**, 16 ft × 10 ft.
- Logical resolution **64 × 40 = 2560 pixels**.
- 1 controller, 4 ports. **Each port drives 2 adjacent 5-tile rows** (10 tiles,
  640 px per port).
- Ledset floor type: `8x8_8P`.

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

### 3.2 Beacon / keepalive packet — 966 bytes ✅

```
offset  size  field
------  ----  -----------------------------------------------
0       6     FF 00 01 00 00 4B    fixed header
6       960   0xFF repeated        constant payload
```

- Byte-for-byte identical every time, **including across scene changes** —
  therefore carries no pixel content. ✅
- Emitted in very rapid bursts (~100 µs spacing observed). ✅
- ❓ Exact required rate unknown. A prior implementation guessed 10 ms and the
  floor did not obviously care.
- ❓ Whether it is required at all is unproven.

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

| # | Hypothesis | Fits 8 indices? | Notes |
|---|---|---|---|
| H1 | `channelIndex` = tile column (8 columns) | yes | What the prior implementation assumed. Coincidentally correct-looking on an 8-wide floor. |
| H2 | 4 ports × 2 sub-frames each | yes | Prior session's leading theory. |
| H3 | `channelIndex` is a rolling cell counter, not a port ID | yes | Would imply many more packets per frame than 8. |

The reference rig's geometry makes H1 and H2 **indistinguishable** — 4 ports × 2
= 8 = column count. This is why observation alone could not resolve it.

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

1. **Count packets between frame boundaries** in a capture of real Ledset
   output. If ~16 (not 8), H1 is dead. *(cheap, decisive)*
2. **Walk a single lit tile across the floor**, capturing at each position, and
   note which packet index + body offset changes. This yields the mapping
   directly, tile by tile. *(definitive)*
3. **Decompile `screenSend.dll`** — the mapping loop is in there as code.

---

## 5. Vendor software architecture (for reference, not to imitate)

Install at `Dance Floor/Release/`:

| File | Nature | Role |
|---|---|---|
| `LedSet.exe` | .NET 4.0, WPF | Mapper UI. Namespace `LedSet.Mapper`, `MapperFile`/`PortCount`/`FloorCountPerPort`, XML-serialised. |
| `Player.exe` | native (PDB path `D:\P20119\LedSet\LedSet\bin\Release\Player.pdb`) | Playback window `LedSet-PlayDlg`. |
| `screenSend.dll` | **mixed-mode C++/CLI** | **The transmit path.** Exports `ScreenSendInit`, `CaptureInit`, `GetBitmap`, `SendScreen`, `SreenSendRelease` *(sic)*. Internals include class `PixelFloor`, `sendto`, `inet_addr`, `pSocketDevice`, `portDataSize`, `PORT_COUNT_A_CONTROLLER`. 32-bit (`IMAGE_FILE_MACHINE_I386`). |
| `VideoGrabber.dll` | native | Screen/video capture. |
| `EffectThumbnail.dll` | native | Thumbnails. |
| `IniFileLib.dll` | .NET | Config I/O. |

**Architectural note:** the `CaptureInit` / `GetBitmap` / `SendScreen` export
triple shows the vendor pipeline **screen-captures a desktop region** and streams
those pixels. It has no content pipeline of its own. A bespoke sender that
generates pixels directly avoids an entire class of failure (window occlusion,
DPI scaling, `ScaleFactorX=0.6`, codec dependencies such as the bundled K-Lite
pack) rather than having to fix them.

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
| `channelIndex` = tile column (H1) | 🟡 Very likely wrong — see §4. |
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
