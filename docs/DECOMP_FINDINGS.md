# Decompilation Findings

Source: `Dance Floor/Release/` (current software generation).
Method: `screenSend.dll` and `LedSet.exe` were compiled to MSIL and decompiled
in full with ILSpy (`ilspycmd` 9.1.0). **No Ghidra was required** — the entire
transmit path is managed code, including the mapping loop. Nothing was patched,
modified, or executed; all vendor binaries are untouched.

Everything below marked ✅ is read directly from the vendor's own code. It
describes what the vendor's *sender* does. It is not hardware verification —
where the controller's tolerance matters (e.g. whether it needs the end-of-frame
flag), that is called out.

---

## Headline

**The `channelIndex` question is resolved, and the packet header is bigger than
the spec thought.**

- A frame is **16 packets** for the reference floor — but **not 16 × 512 bytes**.
  It is 8 ports × 2 packets, where the second packet of every port is **458
  bytes, not 512**.
- Header byte 3 is a **port index**, 0..7, and a port is **one tile column**.
- Header byte 1 is the **controller index**, not a constant.
- Header byte 4 is the **packet index within the port**, with **bit 7 set on the
  final packet of the frame** as an end-of-frame marker.
- The wire body is **BGR**, not RGB.

The prior session's "half the floor lit" is now fully explained, and the
explanation is not the one in the brief — see *Corrections* below.

---

## Confirmed

### Transmit loop and packet layout

- ✅ A frame is emitted by a triple-nested loop: **for each controller → for each
  port → for each packet within that port**. — `SendData` (`screenSend.dll`)
- ✅ Packets per port = `ceil(portDataSize / 507)`. The 507 is a **hard-coded
  literal** in the loop, not derived from 512 at runtime. — `SendData`
- ✅ **Header is 5 bytes**, confirming the spec's correction. The body begins at
  offset 5. — `SendData`
- ✅ Header layout, byte by byte — `SendData`:

  | offset | meaning |
  |---|---|
  | 0 | `0xFF` constant |
  | 1 | **controller index** (0-based) |
  | 2 | `0x01` constant |
  | 3 | **port index within that controller** (0-based) |
  | 4 | **packet index within that port**, `\| 0x80` on the last packet of the last port of the controller |

- ✅ **Packets are not all 512 bytes.** Body length is 507 except on the last
  packet of each port, which carries `portDataSize - 507 * packetIndex` bytes.
  The datagram length sent is `bodyLength + 5`. — `SendData`
- ✅ **There is no padding.** The short final packet is simply short. No zero
  fill, no repeated last pixel. — `SendData`
- ✅ Bit 7 of byte 4 is set only when the packet is both the last packet of a
  port and that port is the last port on that controller — i.e. it is an
  **end-of-frame flag**, one per controller per frame. — `SendData`

### Geometry and buffer layout

- ✅ `ScreenSendInit(int floorType, int floorsOfColumn, int floorOfRow)`, cdecl,
  returns bool. `floorsOfColumn` = tile columns, `floorOfRow` = tile rows.
  — P/Invoke declaration in `LedSet.exe`, class `ScreenSend`
- ✅ Derived at init — `ScreenSendInit`:
  - `portDataSize = bytesPerTile * floorsOfRow`
  - `controllerDataSize = portDataSize * PORT_COUNT_A_CONTROLLER`
  - `controllerCount = ceil(floorsOfColumn / PORT_COUNT_A_CONTROLLER)`
  - `lastControlPortCount = floorsOfColumn % PORT_COUNT_A_CONTROLLER`, or the
    full port count when that remainder is 0
- ✅ **One port drives exactly one tile column.** The send buffer is ordered
  column-major: tile `(col, row)` lands at `(floorsOfRow * col + row) *
  bytesPerTile`. — `PixelFloor::FillSendBuf`
- ✅ **Controller `c` owns tile columns `8c .. 8c+7`.** `SendData` reads the port
  payload at `controllerDataSize * c + portDataSize * port`, and since
  `controllerDataSize == portDataSize * PORT_COUNT_A_CONTROLLER`, that is exactly
  `portDataSize * (PORT_COUNT_A_CONTROLLER * c + port)`. So global tile column =
  `PORT_COUNT_A_CONTROLLER * c + port`. — `SendData`, `ScreenSendInit`
- ✅ `PORT_COUNT_A_CONTROLLER` is **not a fixed constant** — it is set from the
  floor type at init: **8** for `Pixel6x6_8` and `Pixel8x8_8`, **4** for
  `Pixel6x6_4` and `Pixel8x8_4`. — `InitFloor`
- ✅ The `_4` / `_8` suffix in the floor-type name **is** the port count. This
  confirms the `_8P` reading. — `InitFloor` cross-referenced with
  `FloorTypeSet` (`LedSet.exe`)

### Per-tile pixel order

- ✅ A tile is gathered from the source bitmap row-major, then written out
  through a **64-entry lookup table** that remaps output slot → source pixel
  within the tile. — `PixelFloor::FillSendBuf`
- ✅ **For 8×8 floor types that table is the identity** — it is filled with
  `table[n] = n` for n = 0..63. So there is **no serpentine and no per-tile
  reordering** on this rig; within a tile it is plain row-major, left-to-right,
  top-to-bottom. — `InitFloor`
- ✅ For 6×6 floor types the table is **not** identity — it is a transpose
  (output slot `k + 6j` reads source pixel `6k + j`). Irrelevant to this rig, but
  it proves the table is a genuine scan remap and that other floor types differ.
  — `InitFloor`

### Colour order

- ✅ **The body is BGR, not RGB.** Pixels originate from `GetDIBits` on a
  screen-compatible bitmap with `biCompression = BI_RGB`, whose in-memory byte
  order is B, G, R (, A). `Get_Screen` copies the first 3 bytes of each pixel
  verbatim, and `FillSendBuf` copies those 3 bytes verbatim again. No swap
  occurs anywhere between capture and `sendto`.
  — `GDICapture::Create`, `GDICapture::Get_Screen`, `PixelFloor::FillSendBuf`
- ✅ There is **no colour-order configuration** anywhere in this software
  generation. The 2013 release notes' "RGB colour order" setting is a
  *controller-side* option and has no counterpart here.

### Socket and pacing

- ✅ `UDP`, `sendto` to `255.255.255.255:60001`. The address is a hard-coded
  string literal. — `ScreenSendInit`, `UdpSocket::init_socket_client`
- ✅ `SO_BROADCAST` is set **only** when the destination string is literally
  `255.255.255.255`. — `UdpSocket::init_socket_client`
- ✅ Socket is put in **non-blocking** mode (`FIONBIO`), and `SO_SNDBUF` is
  raised to **1,228,800 bytes**. — `UdpSocket::init_socket_client`
- ✅ **No inter-packet delay.** All packets of a frame are pushed back-to-back
  in a tight loop. — `SendData`
- ✅ **Frame pacing is `Thread.Sleep(100)` between frames — roughly 10 fps**,
  on a dedicated send thread. — `ScreenSend.Handler` (`LedSet.exe`)
- ✅ Exports, for cross-check — P/Invoke declarations in `LedSet.exe`:
  - `bool CaptureInit(string winTitle)` — called with `"LedSet-PlayDlg"`
  - `void GetBitmap(byte[] bmpBytes, int width, int height)`
  - `bool ScreenSendInit(int floorType, int floorsOfColumn, int floorOfRow)`
  - `void SendScreen()`
  - `void SreenSendRelease()` *(vendor's typo)*
  - all `CallingConvention.Cdecl`

### Floor types

- ✅ `enum FloorType { Pixel6x6_4=0, Pixel6x6_8=1, Pixel8x8_4=2, Pixel8x8_8=3,
  Inductive=4, Mirror=5 }`. The mapper's `TypeIndex` indexes a 4-element array in
  the same order, so **`TypeIndex 3` = `Pixel8x8_8` = the value passed as
  `floorType`.** — `FloorType`, `typeSetArr` (`LedSet.exe`)
- ✅ Limits for `8x8_8P`: max 32 tile columns, **max 11 tile rows**.
  For `8x8_4P`: max 32 columns, max 22 rows. — `FloorTypeSet` (`LedSet.exe`)
- ✅ Tiles are 2 ft: `floorsOfColumn = feetOfWidth / 2`. Combined with the
  dropdown mapping `feet = (index+1) * 2`, `Test 3.xml`'s indices 7 and 4 give
  8 columns × 5 rows. — `CalcFloorsOfColumn` / `CalcFloorsOfRow` (`LedSet.exe`)

### The 966-byte packet

- ✅ **`screenSend.dll` cannot emit it.** Its only send call passes
  `bodyLength + 5` where `bodyLength ≤ 507`, so **no datagram from this software
  can exceed 512 bytes.** — `SendData`, `UdpSocket::send`
- ✅ **`screenSend.dll` is the only networking code in the entire install.**
  `LedSet.exe`, `Player.exe`, `VideoGrabber.dll`, `EffectThumbnail.dll` and
  `IniFileLib.dll` contain no reference to `ws2_32`, `socket`, `sendto` or
  `WSAStartup`. `LedSet.exe` reaches the network exclusively through the five
  P/Invokes above. — import/string scan of all six binaries
- ✅ There is **no beacon emitter, no keepalive timer, and no second packet
  format** anywhere in this generation. The send thread does exactly one thing:
  capture, map, blast one frame, sleep 100 ms.

---

## Reference rig — concrete numbers

8 tile columns × 5 tile rows, `floorType = 3` (`Pixel8x8_8`), 64 × 40 px.

| quantity | value |
|---|---|
| `PORT_COUNT_A_CONTROLLER` | 8 |
| `controllerCount` | `ceil(8/8)` = **1** |
| `lastControlPortCount` | 8 % 8 = 0 → **8** |
| bytes per tile | 8 × 8 × 3 = **192** |
| `portDataSize` | 192 × 5 = **960** |
| `controllerDataSize` | 960 × 8 = **7680** (= 2560 px × 3 ✅) |
| packets per port | `ceil(960/507)` = **2** |
| **packets per frame** | 8 × 2 = **16** |
| packet 0 of each port | 507 body + 5 = **512 bytes**, byte4 = `0x00` |
| packet 1 of each port | 453 body + 5 = **458 bytes**, byte4 = `0x01` |
| final packet of frame | port 7, packet 1 → byte4 = **`0x81`** |
| bytes per frame | 8 × (512 + 458) = **7760** |

**Target rig**, 14 × 10 tiles, same floor type:
`controllerCount = 2`, `lastControlPortCount = 6`, `portDataSize = 1920`,
4 packets per port (512, 512, 512, **404**), **56 packets per frame**, 27,160
bytes per frame. Controller 0 takes tile columns 0–7, controller 1 takes columns
8–13. Note 10 tile rows is within the `8x8_8P` limit of 11 — but **14 × 12 would
not be**.

### Self-check

The mapping below was implemented independently and run over six geometries
(8×5, 14×10, 8×5 as `_4P`, 1×1, 3×7, 17×3-across-3-controllers). In every case:
every logical pixel maps to a **unique** `(controller, port, packet, offset)`
tuple; the total number of pixel slots across all emitted packets **exactly
equals** the pixel count — confirming there is no padding and no wasted space;
and there is **exactly one end-of-frame flag per controller** per frame.

---

## Mapping pseudocode

Logical pixel `(x, y)`, origin top-left, on a floor of `C` tile columns and
`R` tile rows using an 8×8 floor type.

```
PORTS_PER_CONTROLLER = 8          # 4 for the _4P floor types
BYTES_PER_TILE       = 192        # 8*8*3
PORT_DATA_SIZE       = BYTES_PER_TILE * R
BODY_MAX             = 507

# --- which tile, and where inside it ---
tileCol = x / 8            # integer division
tileRow = y / 8
xIn     = x % 8
yIn     = y % 8

slot    = yIn * 8 + xIn    # identity scan table for 8x8 types

# --- offset within this port's payload ---
offsetInPort = tileRow * BYTES_PER_TILE + slot * 3

# --- addressing ---
controller  = tileCol / PORTS_PER_CONTROLLER
port        = tileCol % PORTS_PER_CONTROLLER
packetIndex = offsetInPort / BODY_MAX
bodyOffset  = offsetInPort % BODY_MAX

# --- the three bytes at bodyOffset are B, G, R (in that order) ---
```

Emitting a frame:

```
packetsPerPort = ceil(PORT_DATA_SIZE / BODY_MAX)
controllerCount = ceil(C / PORTS_PER_CONTROLLER)

for c in 0 .. controllerCount-1:
    portsHere = PORTS_PER_CONTROLLER
    if c == controllerCount-1 and C % PORTS_PER_CONTROLLER != 0:
        portsHere = C % PORTS_PER_CONTROLLER

    for p in 0 .. portsHere-1:
        for k in 0 .. packetsPerPort-1:
            bodyLen = BODY_MAX
            b4      = k
            if k == packetsPerPort-1:
                bodyLen = PORT_DATA_SIZE - k * BODY_MAX
                if p == portsHere-1:
                    b4 = k | 0x80          # end of frame for this controller

            header = [0xFF, c, 0x01, p, b4]
            body   = portPayload(c, p)[k*BODY_MAX : k*BODY_MAX + bodyLen]
            sendto(255.255.255.255:60001, header + body)   # no delay

sleep(100 ms)
```

---

## Corrections to the working spec

Per the standing instruction — the code disagrees with the docs in several
places. Listed worst-first.

1. ❌ **"Frame packet, 512 bytes" is wrong as a general statement.** Half the
   packets in every frame are short. On the reference rig the frame is 8 × 512
   plus 8 × 458. A receiver or capture filter keyed on length 512 sees exactly
   **half** the frame.

2. ❌ **"Byte 4 always `0x00`" is a capture artifact.** Byte 4 is the packet
   index within the port. It reads `0x00` only on the 512-byte packets — which
   are precisely the ones a length-512 filter keeps. This is the **same sampling
   bias** the reply doc already identified for the 966-byte packet, and it is why
   the prior capture saw 8 packets rather than 16.

3. ❌ **"Byte 1 = `0x00` constant"** — it is the controller index. It reads 0
   because the reference rig has one controller. On the 2-controller target rig
   it will be 0 and 1. Byte 1, not byte 4, is the device ID the brief was
   hunting for.

4. ❌ **The brief's explanation of the half-lit floor was wrong, even though its
   conclusion ("~16 packets, not 8") was right.** The brief reasoned 4 ports ×
   4 packets. Reality is **8 ports × 2 packets**. The prior implementation sent
   one packet per port instead of two, so each of the 8 tile columns lit its
   first 169 of 320 pixels — 53%. The dark region would have been a band across
   the floor, not a contiguous half.

5. ⚠️ **"507 bytes = 169 pixels" is arithmetically right but misleading.** The
   split is by **byte** offset within the port payload. 507 = 3 × 169, so pixels
   are never split across a packet boundary — but 507 is **not** a multiple of
   192, so **tile boundaries are**: 507 bytes = 2 tiles + 123 bytes, and the
   second packet of a port begins 41 pixels into tile 2. A packet body is
   therefore *not* a standalone 169-pixel run; it is only meaningful together
   with its port index and packet index. The prior implementation's treatment of
   each packet as an independent block of pixels is the second reason its output
   would not have lined up even with 16 packets.

6. ❌ **Colour order is BGR.** The spec listed this as open with RGB assumed.

7. ❓ **The 966-byte "beacon" did not come from this software.** No binary in
   `Release/` can produce it. It is therefore either (a) from the 2013 LPlayer
   generation, (b) emitted by a controller rather than the PC, or (c) unrelated
   traffic. The scheduled all-black capture is still worth doing, but its
   question has changed: not "beacon or payload" — this generation sends neither
   — but **"what device is emitting it."**
   Note the reply doc's framing that "a frame is 8 packets of 960 bytes if it is
   a channel payload" is now excluded: `portDataSize` is indeed exactly 960 for
   this rig, but that 960 is **always split into 2 packets** and never sent
   whole.

8. ⚠️ **`PORT_COUNT_A_CONTROLLER` is derived, not constant** — the spec should
   not hard-code 8. A `_4P` floor type gives 4, which changes controller
   assignment, `controllerDataSize`, and the end-of-frame flag placement.

---

## Likely

- 🟡 **The end-of-frame flag (bit 7 of byte 4) is what latches the frame.** It is
  the only frame-level signal in the protocol, and it arrives once per controller
  per frame. Reasoning: there is no other delimiter, no sequence number, and no
  timing marker anywhere in the sender. **What would confirm it:** send a frame
  with the flag never set and see whether the floor updates.
- 🟡 **The controller tolerates packet reordering within a frame**, since each
  packet is fully self-addressing (controller, port, offset-via-index). Nothing
  in the sender guarantees ordering beyond loop order. Not worth relying on.
- 🟡 **10 fps is a software choice, not a hardware limit.** `Thread.Sleep(100)`
  is a bare constant with no configuration path. Higher rates are plausible but
  unproven; the 1.2 MB send buffer suggests headroom was expected.

---

## Unresolved

- ❓ **What emits the 966-byte packet.** Ruled out for this generation; not
  investigated in the 2013 `LPlayer` binaries. `LPlayer.pdb` (8.8 MB of full
  symbols) is available if this becomes important. It probably is not — if the
  packet is not required, ignoring it costs nothing.
- ❓ **Whether the controller requires the end-of-frame flag**, or updates
  continuously as data arrives. Code cannot answer this; only the hardware can.
- ❓ **Whether the controller validates byte 2 (`0x01`)**, or ignores it. It is
  written unconditionally and never read back.
- ✅ **Brightness, gamma and colour correction are absent from the send path, and
  from every vendor tool that addresses this controller.** Bytes go from
  `GetDIBits` to the wire untransformed. Extended 2026-08-10 by a string sweep
  (ASCII + UTF-16, with offsets) over everything the manufacturer shipped:
  `LedSet.exe`, `screenSend.dll` and `Player.exe` carry **zero** brightness /
  gamma / gain / colour-correction strings.
  ❓ **One thing this does not close.** `MultifunctionController.exe`, in the
  `IPADE安装` install kit, *does* carry `RDM_SCREENBRIGHTNESS`,
  `RDM_MAXBRIGHTNESS`, `RDM_DIMMERCURVE` and `ColCorrect` — but it drives RDM
  over DMX/ArtNet through an FTDI serial adapter, and **whether a TP-878
  controller answers RDM on its DMX XLR port at all is untested**. It is
  unpursued, not ruled out. Even if it answers, every parameter it exposes is
  per-device global, so it could not address one tile. Evidence table in
  `docs/CALIBRATION.md` §3.
- ❓ **What the second controller does with no panels attached.** Out of scope
  for the sender, but it may appear in captures.

---

## Constants

| name | value | source |
|---|---|---|
| destination | `255.255.255.255:60001` | `ScreenSendInit` (literal) |
| `BODY_MAX` | `507` | `SendData` (literal) |
| header length | `5` | `SendData` |
| magic (byte 0) | `0xFF` | `SendData` |
| byte 2 | `0x01` | `SendData` |
| end-of-frame flag | `0x80` on byte 4 | `SendData` |
| `PORT_COUNT_A_CONTROLLER` | `8` for `*_8` types, `4` for `*_4` types | `InitFloor` |
| tile size (8×8 types) | `8 × 8` px, `192` bytes | `InitFloor` → `Floor` ctor |
| tile size (6×6 types) | `6 × 6` px, `108` bytes | `InitFloor` → `Floor` ctor |
| per-tile scan table (8×8) | identity, `table[n] = n`, n = 0..63 | `InitFloor` |
| per-tile scan table (6×6) | transpose, `table[k + 6j] = 6k + j` | `InitFloor` |
| `portDataSize` | `bytesPerTile × floorsOfRow` | `ScreenSendInit` |
| `controllerDataSize` | `portDataSize × PORT_COUNT_A_CONTROLLER` | `ScreenSendInit` |
| `SO_SNDBUF` | `1228800` | `UdpSocket::init_socket_client` |
| socket mode | non-blocking (`FIONBIO`) | `UdpSocket::init_socket_client` |
| frame interval | `100 ms` (~10 fps) | `ScreenSend.Handler` (`LedSet.exe`) |
| inter-packet delay | none | `SendData` |
| colour order | `B, G, R` | `GDICapture` → `FillSendBuf` |
| max tile rows, `8x8_8P` | `11` | `FloorTypeSet` (`LedSet.exe`) |
| max tile columns | `32` | `FloorTypeSet` (`LedSet.exe`) |
| feet → tiles | `tiles = feet / 2` | `CalcFloorsOfColumn` (`LedSet.exe`) |

---

## Aside: why the vendor pipeline has `ScaleFactor`

`Get_Screen` captures a `mapWidth × mapHeight` region from the **bottom-left** of
the window titled `LedSet-PlayDlg`, using the window's full width as the source
stride, and bails out entirely if the window is smaller than the map. This is the
mechanism behind `Configure.ini`'s `ScaleFactorX/Y=0.6` and the class of
occlusion and DPI failures noted in the spec. A sender that generates pixels
directly avoids all of it — the architectural note in the spec is correct.
