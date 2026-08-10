# Per-region colour calibration

**This masks a hardware defect. It does not repair one, and the numbers in a
calibration file are not a measurement of anything.** They are one operator's
eye, on one evening, at one brightness. Read the caveats in §5 before trusting a
saved file in a new context.

---

## 1. The symptom

Observed 2026-08-10 on the 10 × 5 `8x8_4P` rig. One or two tiles read slightly
orange at full white while the other ~48 read neutral. The affected area is
**part of a tile, not a whole tile**. On coloured content the mismatch is
invisible.

## 2. What it is — settled

**Tile hardware.** Established by the only test that distinguishes the
candidates: power down, physically swap the affected tile with a known-good one,
send white again. **The fault followed the tile.** It is therefore not rail
droop under full-white current, not a chain position effect, and not a power
connector at that position — all of which would have stayed where they were.

The "only at full white" behaviour is consistent with that: white is the only
content that drives all three channels to full scale simultaneously, so it is
the only content where a per-channel gain error in the tile has nowhere to hide.

## 3. What the vendor stack offers — nothing that reaches one tile

Searched in full on 2026-08-10, ASCII and UTF-16 strings with file offsets, over
everything the manufacturer shipped in `..\Dance Floor`:

| Looked at | Result |
|---|---|
| `Release\LedSet.exe`, `Release\screenSend.dll`, `Release\Player.exe` | **Zero** brightness / gamma / gain / colour-correction strings. Consistent with `PROTOCOL.md` Q6, which closed the same question from the other direction: the send path applies no transform to pixel values at all. |
| `LPlayer-sub-window-rev1436\` | Kingstar KS-series tooling for a different product line. `ClrTab\` — the one promising directory name — is **empty**. `ClkFreqCfg.csv` is LED-driver clock rates per chip type (LPD6803, P9813, TLS3001…), not colour. |
| `IPADE安装\升级包\` | Firmware images only (`McuFloor_V266.hex`, `lcd_video_v104.bin`, `P20108_v116.bin`). No calibration payload. |
| `IPADE安装\MultiController2\MultiController2.rar` → `MultifunctionController.exe` | The only binary in the whole folder with colour features: `RDM_SCREENBRIGHTNESS`, `RDM_MAXBRIGHTNESS`, `RDM_DIMMERCURVE`, `RDM_HALLCAL`, `ColCorrect`/`colCorrectStr`. But it is an **RDM-over-DMX/ArtNet fixture tool driven by FTDI USB serial**, with `FIXT_MOVING_MIRROR`, star-floor and SMT/BOM factory tabs — unproven against TP-878. And every parameter it exposes is **per-device global**, so it could not correct part of one tile out of fifty even if it did connect. |

Recorded here so nobody searches it a second time. If someone does want to chase
the RDM angle, the open question is whether a TP-878 controller answers RDM on
its DMX XLR port at all — that needs a DMX interface and a floor, and it would
still only give a whole-controller brightness.

## 4. The mechanism

A per-region RGB gain applied to the logical framebuffer, in our sender, before
the wire mapping. Two pieces:

- `mapper/calibration.py` — the file format and the maths. Portable, stdlib,
  unit-tested off-hardware.
- `tools/calibrate.py` — the by-eye tuner that produces the file. Windows-only
  today (raw keypresses via `msvcrt`); a macOS version is still owed.

### File format

```json
{
  "schema": "ddf-calibration/1",
  "floor": {"type": "8x8_4P", "cols": 10, "rows": 5},
  "regions": [
    {"x": 24, "y": 8, "w": 8, "h": 4, "gain": [1.0, 0.93, 0.90],
     "note": "why this region exists, and when it was measured"}
  ]
}
```

- Coordinates are **pixels in the logical framebuffer, pre-orientation** — the
  same space `patterns.tile()` and `gradient24` use. Orientation is permanently
  `identity` on this rig; this still matters if that ever changes.
- **Gains are `0.0 ≤ g ≤ 1.0`.** There is no headroom above 255, so a
  calibration brings the *good* area down to the bad one. A gain above 1.0 is
  rejected at load rather than silently clipped. The cost of the whole approach
  is that brightness.
- Overlapping regions are rejected. "Last one wins" is a silent trap.

### Applying it

Opt-in, always, on both commands:

```powershell
python -m mapper play <clip> --type 8x8_4P --cols 10 --rows 5 --calibration calibration.json
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --pattern white --calibration calibration.json
```

Nothing changes byte-for-byte without the flag. That is deliberate: a wire
output that depends on a file's mere existence is the invisible-instrument class
of error this project keeps getting caught by, and the uncalibrated floor must
stay one flag away for diagnosis. `--dry-run` applies the calibration too, so
the digest it prints is the digest of what the socket would carry.

### Tuning it

```powershell
python tools/calibrate.py --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78
```

| Key | |
|---|---|
| arrows | move the selection by one **tile** |
| `h` `j` `k` `l` | move the selection by one **pixel** |
| `[` `]` | halve / double the selection, min 1×1, clamped to the floor |
| `r` `g` `b` | choose the channel |
| `-` `+` | nudge the active channel ∓0.01 |
| `R` `G` `B` | choose that channel *and* drop it 0.05 — the coarse move |
| `space` | bypass correction — A/B against the raw floor |
| `t` | cycle the base level 255 → 192 → 128 → 64 |
| `n` / `0` / `d` | new region here / reset its gain / delete it |
| `Tab` / `Esc` | cycle between regions / deselect, freeing the cursor |
| `w` / `q` | write the file / quit (`q` twice when there is unsaved work) |

Arrows are a tile and `hjkl` a pixel because a console cannot reliably tell
shift+arrow from arrow. There is no coarse *increase*: this tool exists to bring
an over-bright area down, and `+` at 0.01 is the way back up.

The status line leads with `!!! SENDER THREAD DEAD, NOTHING IS ON THE WIRE !!!`
if the send thread ever dies. Read it. A wrong `--local-ip` kills that thread,
and without the banner the session looks completely normal while nothing reaches
the floor — controller 1 reverting to local content after ~5 s and 2 and 3 frozen
would be the only symptom, which reads as a floor fault rather than a tool fault.
The destination line printed at startup is the other half of that check.

`space` is the important one. Simultaneous A/B against the uncorrected floor is
the only honest check that the eye has not simply adapted to its own
adjustment.

## 5. Traps

- **A gain trimmed at full white is not guaranteed to hold at 25%.** If the
  tile's defect is not a clean per-channel scale, one gain triple cannot fix it
  at every level, and the correct answer is to record that rather than average
  it away. Check with `t` at 128 and 64 before saving, and with
  `--pattern steps` before tuning at all.
- **A calibration file is tied to a physical arrangement.** The regions are
  positions on the floor, not identities of tiles. Move a tile and the file is
  wrong — silently, and only on near-white content. Re-tune after any re-patch.
- **No byte comparison in this project can see whether a calibration is
  right.** Every frame is internally consistent either way. The floor is the
  only instrument, and the eye is the only detector.

## 6. Status

| | |
|---|---|
| Mechanism built | 2026-08-10 |
| Floor session (`steps` / per-channel diagnosis, tuning, saved file) | **not yet run** |
| Level-dependence of the defect (§5, first trap) | **unmeasured** |
| macOS tuner | **owed** — only `_read_key()` and its raw-mode setup need writing |
