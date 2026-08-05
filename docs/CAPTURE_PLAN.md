# Capture Session Plan

Everything to do at the Windows machine + floor, in one trip. Read this through
once before starting.

**Goal:** produce packet captures that settle the channel→physical mapping
question (`docs/PROTOCOL.md` §4), plus grab the vendor's own config files.

**Estimated time:** 45–90 minutes.

---

## 0. Before you start

### Safety

> ⚠️ **Power down both controllers before moving any data cable between ports.**
> These outputs are RS-485-style differential drivers. Hot-swapping data lines
> can damage the driver ICs on both the controller and the tile boards.

### Prerequisites on the Windows machine

Wireshark should already be installed from the prior session (v4.6.7 + Npcap
1.88). Verify:

```powershell
Test-Path "C:\Program Files\Wireshark\dumpcap.exe"
```

If `False`, install Wireshark (which bundles Npcap; Npcap's installer requires
interactive click-through — there is no silent flag on the free version).

### Working folder

```powershell
mkdir C:\ddf-capture
cd C:\ddf-capture
```

---

## 1. Grab vendor config files (2 minutes, do this first)

```powershell
# The live Ledset config — tells us which mapper XML is actually in use
Get-ChildItem -Path C:\Users -Recurse -Filter "Configure.ini" -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.DirectoryName "LedSet.exe") } |
  ForEach-Object { "=== $($_.FullName) ==="; Get-Content $_.FullName } |
  Tee-Object -FilePath C:\ddf-capture\configure-ini-dump.txt

# Any mapper XML anywhere on the box
Get-ChildItem -Path C:\Users -Recurse -Include *.xml -ErrorAction SilentlyContinue |
  Where-Object { Select-String -Path $_.FullName -Pattern "<Mapper" -Quiet -ErrorAction SilentlyContinue } |
  ForEach-Object { "=== $($_.FullName) ==="; Get-Content $_.FullName } |
  Tee-Object -FilePath C:\ddf-capture\mapper-xml-dump.txt
```

Copy both `.txt` files to the USB stick.

> We already have one `Test 3.xml` (64×40, the 8×5 rig). If the Windows box has
> a different or newer one, that matters — grab it regardless.

---

## 2. Identify the capture interface

```powershell
& "C:\Program Files\Wireshark\dumpcap.exe" -D
```

Prints a numbered list. Find the **wired Ethernet** adapter — the one configured
`10.200.50.78 / 255.0.0.0`. Cross-check with:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength
```

Note the **number** from `-D`. Everything below uses `-i N`; substitute it.

---

## 3. Capture command

For every run below, the pattern is:

```powershell
& "C:\Program Files\Wireshark\dumpcap.exe" -i N -f "udp port 60001" -w C:\ddf-capture\NAME.pcapng
```

- `-f "udp port 60001"` is a **capture filter** — discards everything else at
  the kernel, so files stay small and contain only floor traffic.
- Press **Ctrl+C** to stop.
- If a run produces a 0-byte file, the interface number is wrong. Go back to §2.

**Critical procedure — learned the hard way in the prior session:**

1. Start `dumpcap`.
2. **Then** perform the floor action.
3. Let it run a few seconds.
4. **Then** Ctrl+C.

Do not use a timer and hope the action lands inside the window. The prior
session's first capture caught nothing for exactly this reason.

---

## 4. Test sequence — single controller

Keep the floor exactly as it is: **8 × 5 tiles, 1 controller, 4 ports, each port
driving 2 adjacent 5-tile rows.** Do not re-patch anything yet.

For each test: start capture → do the thing → wait ~3 s → Ctrl+C.

| # | File | What to display in Ledset | Why |
|---|---|---|---|
| 1 | `01-black.pcapng` | Solid **black**, hold 3 s | Baseline. Shows framing with all-zero body; reveals packet count per frame with no content noise. |
| 2 | `02-white.pcapng` | Solid **white**, hold 3 s | All-max body. Diff against black isolates exactly which bytes are pixel data. |
| 3 | `03-red.pcapng` | Solid **red**, hold 3 s | Colour order (RGB/GRB/BGR). |
| 4 | `04-green.pcapng` | Solid **green**, hold 3 s | ″ |
| 5 | `05-blue.pcapng` | Solid **blue**, hold 3 s | ″ |
| 6 | `06-halves.pcapng` | **Left half white, right half black**, hold 3 s | Coarse spatial split — first real mapping signal. |
| 7 | `07-tilewalk.pcapng` | **Single tile lit, walked across the floor** — see §5 | ⭐ **The decisive test.** |
| 8 | `08-sweep.pcapng` | Slow horizontal sweep, ~10 s | Confirms mapping under motion + reveals frame rate. |

### Test 7 is the one that matters

If you only have time for one test, do **7**. Everything else is
corroboration; this is proof.

---

## 5. How to run the tile-walk (test 7)

The floor is 64 × 40 logical pixels; one tile is 8 × 8 px.

**Preferred method** — make a short video or image sequence, 64 × 40 px, in which
a single 8×8 white square sits on a black background and jumps to a new tile
position every ~2 seconds. Play it in Ledset.

Suggested tile positions to visit, in this order (col, row), 0-indexed:

```
(0,0)  (1,0)  (2,0)  (3,0)   ← top row, left to right
(0,1)  (0,2)  (0,3)  (0,4)   ← left column, top to bottom
(7,0)  (7,4)                 ← far corners
(4,2)                        ← centre
```

**While it plays, write down** the wall-clock time (or capture-relative seconds)
at which each position appears. A phone note is fine. Without these timestamps
the capture is far harder to interpret.

**Fallback method** — if authoring a 64×40 video is awkward, any content works
as long as **only one tile is lit at a time and you record the order**. Even
manually placing a small white square in an image editor and re-loading it 10
times is fine, just slower.

**What this yields:** for each tile position, exactly which packet
(`channelIndex`) and which byte offset within its 507-byte body changed. That is
the mapping table, read directly off the wire — no inference.

---

## 6. Two-controller test (optional, only if you have spare tiles)

> ⚠️ Power down before re-cabling. See §0.

**Do not** simply move cables from controller 1's ports 3/4 to controller 2.
That changes controller count *and* floor partition simultaneously, and Ledset
would still be sending a one-controller pattern — the capture would be
uninterpretable.

**Instead**, keep the 8×5 floor intact on controller 1 and add controller 2
driving **extra** tiles (2–4 spare tiles on its port 1 is enough).

Setup:

1. Power everything down.
2. Cable the spare tiles to controller 2, port 1.
3. Power up. On **controller 1**: `Device Order` = `01`, `Work Mode` = `IR`/Master.
   On **controller 2**: `Device Order` = `02`, `Work Mode` = `Slave`.
4. In Ledset's Mapper, update the layout to include the extra tiles.

Then capture:

| # | File | Display | Why |
|---|---|---|---|
| 9 | `09-two-white.pcapng` | Solid white, 3 s | Diff vs `02-white` reveals what a second device adds. |
| 10 | `10-two-tilewalk.pcapng` | Light a tile on **controller 1**, then one on **controller 2** | Isolates the device-addressing field. |

**What we're looking for:** does `channelIndex` extend past 7 (8–15)? Or does
byte 4 — currently always `0x00`, purpose unknown — become `0x01` for the second
controller? Those are the two candidates.

If you don't have spare tiles: **skip this entirely.** Single-controller v1 is
genuinely useful, and improvising here risks a confusing capture.

---

## 7. Wrap-up checklist

Copy to the USB stick:

- [ ] `configure-ini-dump.txt`
- [ ] `mapper-xml-dump.txt`
- [ ] All `*.pcapng` files
- [ ] Your tile-walk timing notes (typed up or photographed)
- [ ] Anything from `docs/WINDOWS_BRIEF.md` (decompilation output)

**Sanity check before leaving:** confirm the `.pcapng` files are non-zero and
plausibly sized (a few hundred KB to a few MB each). A 0-byte or 24-byte file
means nothing was captured — likely the wrong interface number.

```powershell
Get-ChildItem C:\ddf-capture\*.pcapng | Select-Object Name, Length
```

---

## 8. If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `.pcapng` is 0/24 bytes | Wrong interface number | Re-run §2, use the wired adapter on `10.200.50.x` |
| `dumpcap` won't start | Npcap not installed or no admin | Run PowerShell as Administrator |
| Capture has traffic but no port 60001 | Ledset wasn't actually sending | Confirm Ledset is *playing*, not just open |
| Floor doesn't light at all | Controller in wrong work mode | Check controller menu; needs the mode Ledset drives |
| Traffic from two sources | Another app also broadcasting | Note it — captures can only be told apart by packet shape, not IP |
