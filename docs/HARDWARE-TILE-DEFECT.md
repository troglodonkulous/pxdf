# The orange-at-white tile defect

Four tiles on the 10 × 5 `8x8_4P` rig read orange instead of white at high
levels. This file is the whole record: what was observed, what was ruled out,
what the vendor stack does and does not offer, the leading hardware hypothesis,
and the test that would falsify it.

**Status: the symptom and the exclusions in §1–§3 are observed. §4 onward is a
hypothesis with a strong fit to those observations, plus a falsifying test that
has not yet been run.** Nothing from §4 onward has been confirmed at the floor.
Per `CLAUDE.md`, treat it as a prediction to be disproved, not a finding. The
cheap decisive test is in §6; run it before touching hardware.

A software fix was attempted and abandoned — see §9.

---

## 1. The symptom

Observed 2026-08-10. One or two tiles read slightly orange at full white while
the other ~48 read neutral. The affected area is **part of a tile, not a whole
tile**. On coloured content the mismatch is invisible.

Per-tile detail, from the 2026-08-10 session: whole contiguous pixel rows, with
band size tracking severity — C5R1 5 rows (worst), C3R2 4 rows, C7R5 3 rows,
C8R5 2 rows. Clean at `level:32` and `level:128`, orange at `level:224` and
`level:255`. Single-channel full fields (`red`, `green`, `blue` alone) are clean
on all four tiles.

## 2. What it is — settled

**Tile hardware.** Established by the only test that distinguishes the
candidates: power down, physically swap the affected tile with a known-good one,
send white again. **The fault followed the tile.** It is therefore not rail
droop across the floor's shared distribution, not a chain position effect, and
not a power connector at that position — all of which would have stayed where
they were.

The "only at full white" behaviour is consistent with that: white is the only
content that drives all three channels to full scale simultaneously, so it is
the only content where a per-channel gain error in the tile has nowhere to hide.

This finding is also *not* vulnerable to a pattern-dependent spatial confound,
because a physical swap does not depend on which pattern was being displayed.

## 3. What the vendor stack offers — nothing that reaches one tile

Searched in full on 2026-08-10, ASCII and UTF-16 strings with file offsets, over
everything the manufacturer shipped in `..\Dance Floor`. Recorded here so nobody
searches it a second time.

| Looked at | Result |
|---|---|
| `Release\LedSet.exe`, `Release\screenSend.dll`, `Release\Player.exe` | **Zero** brightness / gamma / gain / colour-correction strings. Consistent with `PROTOCOL.md` Q6, which closed the same question from the other direction: the send path applies no transform to pixel values at all. |
| `LPlayer-sub-window-rev1436\` | Kingstar KS-series tooling for a different product line. `ClrTab\` — the one promising directory name — is **empty**. `ClkFreqCfg.csv` is LED-driver clock rates per chip type (LPD6803, P9813, TLS3001…), not colour. |
| `IPADE安装\升级包\` | Firmware images only (`McuFloor_V266.hex`, `lcd_video_v104.bin`, `P20108_v116.bin`). No calibration payload. |
| `IPADE安装\MultiController2\MultiController2.rar` → `MultifunctionController.exe` | The only binary in the whole folder with colour features: `RDM_SCREENBRIGHTNESS`, `RDM_MAXBRIGHTNESS`, `RDM_DIMMERCURVE`, `RDM_HALLCAL`, `ColCorrect`/`colCorrectStr`. But it is an **RDM-over-DMX/ArtNet fixture tool driven by FTDI USB serial**, with `FIXT_MOVING_MIRROR`, star-floor and SMT/BOM factory tabs — unproven against TP-878. And every parameter it exposes is **per-device global**, so it could not correct part of one tile out of fifty even if it did connect. |

If someone does want to chase the RDM angle, the open question is whether a
TP-878 controller answers RDM on its DMX XLR port at all — that needs a DMX
interface and a floor, and it would still only give a whole-controller
brightness.

---

## 4. What the board in the photograph actually is

Inputs for §4 onward: `C:\Users\USER\dev\tile-defect\ddf-hardware-diagnosis-handoff.md`
(session findings), a photograph of a tile's power/data board, and web research
on the parts identified from that photograph.

It is **not** the LED driver chip. It is the per-tile **power and data**
board: `DJ-XSP-5V-20221227-01`, silkscreened `A8744Z`, TOPdance branding. The
panel is V-scored into two identical, electrically independent halves.

Per half:

| Ref | Part | Role |
|---|---|---|
| J1 | 2-pin `+24V` / `GND` | Power in from the floor's 24 V bus |
| C1 | 470 µF / 35 V | Input bulk |
| **U1** | **XL4015E1** (XLSEMI) | 180 kHz non-synchronous buck, TO-263-5. FB reference **1.25 V**; output set by the R1/R2 divider |
| L1 | silk reads `471` | Buck inductor — see §10, the value matters |
| D1 | SS54 | Catch diode, 5 A / 40 V |
| C2 | 220 µF / 10 V | Output bulk on the 5 V rail |
| J2, J5 | 3-pin `GND` / `DI` / `5V` | Out to LED strings — **two ports per half** |
| J6 | 4-pin `DO-` `DO+` `DI-` `DI+` | Differential data in/out |
| U2 | SOIC-8 + R5/R6/R8/R9 | Differential receiver / repeater for the data chain |

Two halves × two ports = **four ports per panel**, which matches the rig's
`8x8_4P` tile type and the existing cabling note (connector 1 = ports 0, 1;
connector 2 = ports 2, 3).

### The structural fact that reframes the problem

**Each tile generates its own 5 V locally, on two independent rails.** The
floor bus distributes 24 V, not 5 V.

This kills the "shared 5 V rail droops across the floor" model recorded as a
hypothesis in the session diary (`.remember`, not published, 2026-08-10 12:19 — that entry was
never committed, so the hypothesis survives only as stated here). The suspect rail is roughly
20 mm of copper on one tile's own board, downstream of that tile's own buck
converter. That is *consistent* with, not contradicted by, the tile-swap finding
in §2 — the converter travels with the tile.

The differential data path (J6 → U2) is re-driven per tile and is not implicated
in a colour defect. Set it aside.

---

## 5. Proposed mechanism

Blue LED forward voltage is roughly 3.0–3.2 V; red is roughly 2.0 V. The pixel
driver needs a further ~0.4–0.6 V of headroom above Vf to regulate. Once the
5 V rail falls below roughly **4.4–4.6 V**, blue drops out first, then green.
Red keeps working down to about 3 V.

White therefore degrades white → yellow → orange. That is the observed defect,
and the ordering is not adjustable — it is set by the physics of the dice.

### Fit against every observation on record

- **Single-channel full fields are clean on all four tiles.** A single channel
  draws one third the current, so the rail does not sag; and blue alone at a
  nearly healthy rail still clears its Vf. Consistent.
- **Clean at 32 and 128, orange at 224 and 255.** Droop is proportional to
  current. The rail crosses blue's dropout somewhere in the untested 128–224
  gap. Consistent, and it predicts where that gap resolves.
- **Whole contiguous pixel rows, and band size tracks severity** (§1). This is a
  *chain-position* signature: the orange starts at the electrical tail of the
  LED string and marches backward as droop worsens. A monotonic size-versus-
  severity ordering across four independent tiles is very hard to produce with a
  data, timing, or per-channel-gain fault.
- **The fault follows the tile when tiles are physically swapped** (§2). The
  buck converter is on the tile. Consistent.

Conclusion of the hypothesis: **on each defective tile, one of the two 5 V
rails is running low or sagging under load, and the far end of the LED chain it
feeds falls below blue's dropout voltage.**

---

## 6. Decisive test — run this first. No meter, no disassembly

On C5R1, display a uniform mid-to-high grey at 200, 224, 240 and 255 in
sequence, and watch the orange band.

**Prediction:** the band grows monotonically — zero rows, then a row, up to five
rows at 255 — and is **always anchored at the same end of the tile**, never
appearing in the middle or moving.

- If the band grows from one fixed end: droop confirmed. Proceed to §7.
- If the band appears whole, jumps position, or does not track level: this
  hypothesis is dead. Stop and diagnose, per the project's standing rule. Do
  not rationalise a partial match.

> The 2026-08-10 session drove these levels through `mapper send --pattern
> level:N`, which arrived with the calibration work and was reverted with it
> (§9). Re-add a throwaway grey pattern, or author a clip, before running this.

### Still outstanding from the previous session

The two-of-three channel test (yellow = R+G, magenta = R+B, cyan = G+B) was
executed cleanly, but the visual observation was never recorded. Get it.

**Prediction under the droop hypothesis:** each 2-channel combination draws two
thirds of white's current, so the band should be **smaller than at white, or
absent entirely**. Magenta (R+B) is the combination most likely to still show
blue loss, because blue is the channel with no headroom.

If instead a 2-channel combination shows a band *larger* than white's, or a
combination without blue in it shows a colour shift, the hypothesis is wrong.

---

## 7. Measurements — DMM, about five minutes

> **Safety:** 24 V is not a shock hazard, but power down all three controllers
> before unplugging or reseating any connector — this is already a standing rule
> in `CLAUDE.md` for data cables and applies here too. Probe live only at
> exposed pins. Do not short 24 V to the 5 V rail.

Meter set to DC volts, black lead on tile ground:

| Probe point | Under `black` | Under `white` | What it means |
|---|---|---|---|
| J1 `+24V`, defect tile | ~24 V | **< 22 V** | Problem is upstream: the 24 V distribution or PSU, not the tile |
| J2 / J5 `5V` pin, defect tile | ~5.0 V | **< 4.6 V** | That tile's buck converter — root cause found |
| J2 / J5 `5V` pin, known-good tile | ~5.0 V | ~4.9 V | Baseline for comparison |
| 5 V at the far end of the affected string, if reachable | — | compare to J2 reading | The delta separates buck sag from voltage lost in wire and crimps |

That last row is the one that discriminates between the two sub-causes. A low
reading *at the board* means the converter; a healthy reading at the board with
a low reading at the string tail means the interconnect.

Also touch U1 and L1 at full white. Uncomfortably hot implies thermal foldback.

**Load arithmetic, for reference:** an 8×8 tile is 64 pixels, so 32 pixels per
buck rail. At roughly 60 mA per pixel at full white that is about **1.9 A per
rail** — comfortably inside the XL4015's realistic ~3 A continuous ceiling in
this package with no forced air. Thermal shutdown is therefore *unlikely*, and a
marginal component or a marginal joint is the better first bet.

---

## 8. Fix ladder, cheapest and least invasive first

1. **Reflow and reseat.** Resolder the pins of J1, J2, J5 and U1's tab on the
   defective tiles. Reseat or re-crimp every connector between the board and the
   LED string. A 0.4 V loss in a single poor crimp reproduces this defect
   exactly and is load-dependent, and the whole-row granularity of the defect
   fits a per-port connector well.
2. **Replace C2** (220 µF / 10 V) with a low-ESR polymer part, and add
   100–220 µF of bulk at the LED end of the affected string. Addresses sag, and
   is also the most likely fix for the separate flicker described in §10.
3. **Raise the rail.** The XL4015's FB reference is 1.25 V, so
   `Vout = 1.25 × (1 + R2/R1)`. Changing one SMD resistor in that divider lands
   the rail at **5.1–5.2 V**, restoring blue's headroom.

   > **Caution.** Do not exceed 5.3 V. SM16703 / WS281x-class pixels are 5 V
   > parts and margin above that is thin on some variants. This is a permanent,
   > per-board hardware modification. Do it on one defective tile, verify at the
   > floor, and only then decide about the others. Raising the rail floor-wide
   > shifts brightness on every tile.

4. **Replace the board.** These are commodity TOPdance panels. If the rail
   measures low with good joints and a good output capacitor, swapping the board
   is faster than continuing to debug it.

---

## 9. Why the software fix was abandoned

An opt-in per-region RGB gain — `mapper/calibration.py` plus a by-eye tuner
`tools/calibrate.py` — was built and merged on 2026-08-10, then **reverted in
full on 2026-08-11**. It is not in the tree and should not come back.

The reason is §5. A gain scales red and green *down* to match a collapsed blue:
the tile simply gets dimmer, and remains wrong at every level other than the one
the gain was trimmed at. The defect is a rail that sags under load, so the
required correction is itself load-dependent — a single per-region constant
cannot track it. It masks the symptom at one brightness and measures nothing.

It also carried a standing hazard: region coordinates are pre-orientation
logical framebuffer pixels, so a saved file is tied to one physical arrangement
and goes silently wrong when a tile moves.

The remedy is the hardware fix in §8.

---

## 10. The separate flicker at mid grey

Flicker was visible widely across the floor at `level:128` only — absent at 32,
224, 255 and during full white. It was logged rather than chased.

Likely the same power stage. Mid PWM duty is where the buck sees the largest AC
current swing: 255 is a near-DC load, 32 is a small perturbation, and mid-scale
is exactly where a slow control loop rings.

If L1 really is `471` — that is **470 µH** — the loop crossover is very low and
transient response correspondingly poor. **This value should be verified
directly on the board**; many XL4015 designs use 47 µH, which is marked `470`,
and the two markings are easy to confuse in a photograph. The reading here comes
from a photograph and nothing else.

Same remedy as fix 2 in §8: more low-ESR output capacitance.

Cheap confirmation: film a flickering tile at mid grey with a phone at 240 fps
and look for banding.

---

## 11. Provenance

Per `CLAUDE.md`'s standing warning about instrument-caused false confirmations,
here is where each claim came from:

- **§1–§3** — the symptom, the tile-swap exclusion and the vendor string sweep:
  observed and executed during the 2026-08-10 session. These are findings.
- **Board identification, part numbers, connector pinout, two-rails-per-tile
  structure** (§4): read directly off a photograph of one board. Silkscreen was
  legible for U1, C1, C2, D1, J1, J2, J5, J6 and the board part number. The
  inductor value is the one reading that is genuinely uncertain — see §10.
- **XL4015 electrical characteristics** (1.25 V FB reference, 180 kHz, 8–36 V
  in, 5 A rating, real-world thermal derating to about 3 A): vendor datasheet
  and secondary sources, cited below.
- **LED forward voltages and driver headroom, and the resulting blue-first
  dropout ordering**: standard for this LED class, corroborated by the pixel-LED
  sources below. Not measured on this floor.
- **Which tiles, which rows, which levels, which channels**: taken from the
  2026-08-10 session handoff, which itself flags the 128–224 gap as untested and
  the 2-of-3 channel observation as never captured.
- **Nothing in §5's mechanism has been verified on this hardware.** §6 exists
  specifically to give it a chance to fail.

## Sources

- XL4015 datasheet — https://www.scribd.com/document/331748365/XL4015-datasheet-pdf
- XL4015E1 part page, LCSC — https://www.lcsc.com/product-detail/C51661.html
- XL4015 practical thermal limits — https://www.flywing-tech.com/blog/xl4015-buck-converter-module-guide/
- SM16703P specification sheet — https://suntechlite.com/wp-content/uploads/2024/08/SM16703P-Specification-Sheet.pdf
- 24 V distribution for 5 V pixel LEDs — https://quinled.info/24v-power-distribution-for-5v-leds/
