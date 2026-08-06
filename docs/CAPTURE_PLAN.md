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

### Bring with you

- The `test-patterns/` folder (PNGs + MP4s + `tilewalk_timing.md`) on the USB stick.
- Something to note the playback start time on.

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

## 1a. Which machine captures?

**Capture on the Windows machine.** Ledset runs there, and the traffic we need
is Ledset's own output.

The Mac cannot capture it by simply joining the network. Broadcast traffic does
reach every host on the segment, so in principle a Mac on the same switch would
see it — but that requires a switch (not a direct cable), adds a second variable
to every failed capture, and gains nothing, since the Windows box already has
Wireshark installed from the prior session.

Capture where the sender is. Analyse anywhere.

> The Mac's static IP (`10.200.50.78 / 255.0.0.0`) is for **phase 2**, when the
> Mac becomes the sender. It plays no part in the capture session. Note that
> `10.200.50.78` is the address the Windows box uses — do not have both machines
> on that address simultaneously.

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
| 1 | `01-black.pcapng` | `01-black.png`, hold 3 s | ⭐ **Settles the beacon question.** If 966-byte packets stay all-`0xFF` on a black floor they are beacons; if they go all-`0x00` they are port payloads, and the real packet size is 960 not 507. Also gives the clean packet-count-per-frame baseline. |
| 2 | `02-white.pcapng` | `02-white.png`, hold 3 s | All-max body. Diff against black isolates exactly which bytes are pixel data. |
| 3 | `03-red.pcapng` | `03-red.png`, hold 3 s | Colour order (RGB/GRB/BGR). |
| 4 | `04-green.pcapng` | `04-green.png`, hold 3 s | ″ |
| 5 | `05-blue.pcapng` | `05-blue.png`, hold 3 s | ″ |
| 6 | `06-halves.pcapng` | `06-halves.png`, hold 3 s | Coarse spatial split — first real mapping signal. |
| 7 | `07-tilewalk.pcapng` | `07-tilewalk.mp4`, full 24 s — see §5 | ⭐ **The decisive test.** |
| 8 | `08-sweep.pcapng` | `08-sweep.mp4`, full 10 s | Confirms mapping under motion + reveals frame rate. |

### Tests 1 and 7 are the ones that matter

If time is short, do **1** and **7**. Test 1 settles whether the 966-byte packet
is a beacon or a port payload — which decides the fundamental packet size, and
therefore the whole sender design. Test 7 settles the pixel mapping. Everything
else corroborates.

### Also: count the ports 👀

**Before or after the captures, physically look at the controller.** How many
output connectors does it have, and how many tile chains are plugged in?

This settles a live contradiction: the floor type is named `8x8_8P` (suggesting
**8 ports**) while a prior session read **4** off a Ledset wiring diagram. The
manual's "8-channel signal output interface" suggests 4 connectors carrying 8
channels — but that is inference. Ten seconds with your eyes beats all of it.

Write down both numbers.

---

## 5. How to run the tile-walk (test 7)

**The media is already made.** Copy the whole `test-patterns/` folder to the
Windows machine and load these in Ledset — no authoring needed.

| File | Test |
|---|---|
| `01-black.png` … `06-halves.png` | Tests 1–6, all 64 × 40 px |
| `07-tilewalk.avi` | Test 7 — 24 s, 10 fps |
| `07-tilewalk.gif` | Same, fallback if the AVI is rejected |
| `08-sweep.avi` | Test 8 — 10 s |
| `tilewalk_timing.md` | Which tile is lit at which second |

All rendered at the floor's exact logical resolution (64 × 40) so nothing gets
scaled, as **uncompressed RGB in an AVI container**. Uncompressed matters: the
tile-walk depends on exactly one 8×8 tile being lit with hard edges, and any
lossy compression or chroma subsampling bleeds light into neighbouring tiles.
AVI because the vendor's own content library is almost entirely `.avi`, so it
is what Ledset's bundled K-Lite codec pack is most certain to handle.

> Earlier lossless-H.264 versions of these files were **rejected by QuickTime**
> (they land in `High 4:4:4 Predictive` profile, which most consumer decoders
> refuse). Ledset would likely have refused them too. If you have an old
> `.mp4` copy of these patterns, discard it.

`07-tilewalk.avi` lights **exactly one tile at a time**, holding each for 2 s,
starting with a 2 s black lead-in:

```
black → (0,0) (1,0) (2,0) (3,0)   top row, left to right
      → (0,1) (0,2) (0,3) (0,4)   left column, downward
      → (7,0) (7,4) (0,4)         corners
      → (4,2)                     centre
```

**The only thing to record:** the wall-clock time playback *starts*. Everything
else comes from `tilewalk_timing.md`, whose offsets are relative to the video's
own start. A phone note saying "started 14:32:07" is enough.

> If Ledset loops the video, that is fine — better, even. A second pass
> confirms the mapping repeats identically rather than drifting.

**If Ledset refuses the AVI:** try `07-tilewalk.gif` (palette-based, so still
lossless for these two-colour frames, and playable almost anywhere). Failing
that, the test degrades gracefully to manual operation — load `01-black.png`,
then a series of single-tile stills, noting the order. Slower but equally valid.

**What this yields:** for each tile position, exactly which packet
(`channelIndex`) and which byte offset within its 507-byte body changed. That is
the mapping table, read directly off the wire — no inference.

### Regenerating for a different floor layout

```bash
python3 tools/make_test_patterns.py --cols 14 --rows 10 --out test-patterns-14x10
```

The tool derives everything from tile count; `--hold` and `--fps` are adjustable.

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
