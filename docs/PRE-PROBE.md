# Pre-probe — what was staged, and what the attended session found

**Date:** 2026-08-08
**Branch:** `generalize-geometry`
**Gate:** 2 — the attended Player-page probe and the first multi-controller
capture. **Run 2026-08-08, ~12:40 PDT. Both rows PASS.**

This document exists so the attended session spends its time capturing packets
and nothing else. Everything below the "staged" line was verified on this
machine on 2026-08-08 with nothing transmitted and nothing lit.

Read `docs/ORACLE_HARNESS.md` §6 for the reasoning behind the order of the run;
this is the operator's copy, not a replacement for it.

---

## Result — gate 2, 2026-08-08

Two 8-second windows, attended, controllers untouched (arrangement #1).

```
name                            status  pkts  frames  match   tol  unexp  part  recur
acceptance-gradient24-identity  PASS      20      72     68   4/8      0     1     1%
acceptance-white-identity       PASS      20      74     70   4/8      0     1     1%
```

Both captures are committed under `captures/oracle/` and both rows of
`configs.acceptance.json` now name them, so the verdicts reproduce from disk on
a plain `python -m tools.oracle.harness run --configs
tools/oracle/configs.acceptance.json` with no hardware. `python -m mapper
verify` agrees independently: 68/72 and 70/74 byte-identical, on exactly the
frames the harness named.

**What the five failure modes below actually did:**

| # | Mode | Outcome |
|---|---|---|
| 1 | First multi-controller oracle | **Settled.** 20 packets/frame across 3 controllers with a partial last one, matching the plan byte for byte. The first evidence of any kind that `tile_col -> (controller, port)` is right above one controller's worth of columns. |
| 2 | Device-Order convention | **Not settled, and could not be.** The bytes are correct on the wire; whether byte 1 = `k−1` names the physically-right unit is invisible here. The run-sheet's §3 sends resolve it. Still the project's most likely wrong assumption. |
| 3 | Port-fault claim on real data (F2) | **Settled.** Per-pixel-unique content, zero systematic mismatch, worst recurrence 1/72. |
| 4 | Scan table / serpentine | **Settled.** `mapper/floors.py::_identity_scan` is the real intra-tile order, not a decompilation guess. A serpentine would have mismatched inside every tile on every frame. |
| 5 | Ledset value transform (gamma/brightness) | **Settled, negative.** 68 frames of almost entirely intermediate pixel values matched byte for byte, so Ledset applies no LUT on the video→wire path. `docs/PROTOCOL.md` Q6 is closed for playback. |

The §5b discriminator was never needed: it exists to tell modes 4 and 5 apart
when recurrence reads ~100 %, and recurrence read 1 %. It remains unimplemented
and should stay that way until something asks for it.

**Vendor defects, measured at this geometry** — 3 consecutive loop-boundary
blanks and 1 torn frame, *identically* in both captures. `max_tolerated` was
re-measured from that and tightened 9 → 8; the arithmetic is in
`configs.acceptance.json`'s `_max_tolerated_derivation`.

**One defect found, in the instrument, not the floor.**
`verify-xml-control-path.ps1` printed `MATCH: False` on a geometry that had in
fact loaded correctly: its `ComboText 'cbo_Type'` read returned the empty
string, so the type comparison can never pass, while `width=20ft`,
`height=10ft` and `controllers=3` all read back correctly. The script's verdict
line is therefore currently useless and its three numeric reads are not — see
§6. Do not read a `MATCH: False` from it as a geometry failure without checking
the three numbers first.

---

## Safety — read before starting

**The floor is assembled, connected and powered. Playing the clip lights it
up.** That is what Ledset normally does and the user has authorised it, but
**not unattended.** Confirm the user is present and ready before anything
plays.

Nothing in the staging below transmits. `dumpcap` is a passive listener: it
opens no connection and sends nothing.

Two standing constraints, unchanged:

- **Do not click Save or Save As in Ledset without asking.** The on-disk mapper
  XML is untouched and discarding a dirty flag is safe.
- **Do not write into `C:\Users\USER\dev\Dance Floor\Release\`.** A bad write
  costs a reinstall. (`verify-xml-control-path.ps1` writes to `Configure.ini`'s
  `MapperPath` and restores the file's original bytes before exiting — that is
  the one sanctioned exception, and it restores.)

---

## Staged — verified 2026-08-08, nothing left to set up

| | |
|---|---|
| Media | `test-patterns\09-gradient24-8x8_4P-10x5.avi` — copied in, 583,126 bytes |
| Ledset media folder | `Configure.ini` `ProgramPath` = `C:\Users\USER\dev\ddf\test-patterns` **at the time of staging. It did not stay that way** — see the note below. |
| Mapper XML target | `Configure.ini` `MapperPath` = `C:\Users\USER\dev\Dance Floor\Lplayer\ledset-test.xml` |
| Floor NIC | Ethernet, `10.200.50.78`, 1 Gbps, up — **dumpcap interface 8** |
| `dumpcap` | `C:\Program Files\Wireshark\dumpcap.exe` |
| Suites | mapper 38 tests, oracle 39 tests, both green |

The interface number was confirmed against the source address in
`captures/02-white.pcapng` (`10.200.50.78 -> 255.255.255.255:60001`), not only
read off the adapter list — same NIC as the 2026-08-06 session. **Re-check it
after any reboot or re-cabling:** `python -m tools.oracle.harness list-interfaces`.

The AVI in `test-patterns\` is a gitignored staging duplicate. The tracked
original is `tools/oracle/media/09-gradient24-8x8_4P-10x5.avi`; if the staged
copy goes missing, copy it back.

**Ledset will not show the clip until its thumbnail cache is rebuilt** — press
Refresh on the Player page after launch. That is the only staging step that
needs the app open, which is why it is here and not above.

**`ProgramPath` will not still be `test-patterns` next session.** Read live
after the gate-2 captures it was `C:\Users\USER\dev\Dance Floor\IPAD????2\16?9`,
the vendor's own media folder. The operator changed it deliberately, after the
captures were taken, while exploring the stock media — nothing drifted on its
own and nothing about the captures is affected. But it is persisted
(`LedMapper_Closing` and `LedPalyer_Closing` both call `config.Save()`,
`LedSet.decompiled.cs:1186` and `:2770`), so the change outlives the session
that made it. **Read the live file at the start of every session** rather than
trusting this table or `captures/configure-ini-dump.txt`, and re-stage the clip
if it points somewhere else. `MapperPath` was unaffected.

---

## The session, in order

### 1. Geometry — set it, and prove Ledset read it back

Either set `8x8_4P` / 10 cols / 5 rows on the Mapper page by hand, or use the
XML control path, which is the better instrument because it also closes an open
item:

```bash
python -m mapper xml --type 8x8_4P --cols 10 --rows 5 --out candidate.xml
powershell -File tools\oracle\verify-xml-control-path.ps1 `
    -CandidateXml candidate.xml `
    -ExpectType 8x8_4P -ExpectWidthFeet 20 -ExpectHeightFeet 10 -ExpectControllers 3
```

Attended: it closes and relaunches Ledset, takes the foreground briefly, and
gives focus back. It never opens the Player page and never transmits. A pass
closes `docs/ORACLE_HARNESS.md` §2's "read side unverified live".

Whichever route: **confirm the Mapper page shows three controllers** before
going further. Two means the geometry did not take.

### 2. The gradient24 capture — the one that matters

```bash
python -m tools.oracle.harness run --live --interface 8 --seconds 8 \
    --configs tools/oracle/configs.acceptance.json \
    --only acceptance-gradient24-identity
```

The harness prints "start playback on the floor now" and captures for 8
seconds. It does not drive Ledset — pressing play is the operator's job. Start
the clip, let it run through the window, and let the capture close itself.

**`--only` is not optional**, and the harness refuses a multi-row `--live` run
without it (exit 2): each row is its own capture window, and one of them needs
the controllers physically moved first.

The capture lands in `captures/oracle/acceptance-gradient24-identity.pcapng` —
**the harness prints the exact path**, because a second take is written as
`-2`, `-3`, … rather than overwriting the first. Deciding which take was good
is a job for after the session. The verdict prints immediately. A second
opinion on the same file:

```bash
python -m mapper verify captures/oracle/acceptance-gradient24-identity.pcapng \
    --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 --allow-mismatch 9
```

### 3. Read the `recur` column, not just PASS/FAIL

This is the whole point of the capture, and the numbers it is calibrated
against are in `docs/ORACLE_HARNESS.md` §8:

- **~0–2 %** — Ledset's unlocked send thread. Normal.
- **~100 %, located at a `ctrlN/portM`** — that port is reading the wrong tile
  column. The row names the port; that is the diagnosis, not a starting point
  for one.

`90-synth-acceptance` is the instrument test for exactly this reading, and it
is reproducible in one command if the output looks implausible:

```bash
python -m tools.oracle.make_synth_capture --check              # PASS, recur 1%
python -m tools.oracle.make_synth_capture --fault f2 --check   # FAIL, recur 96%, ctrl1/port3
```

### 4. Re-measure `max_tolerated`, then write it down

The `9` in both config lists is **derived** — clip length × Ledset's ~9.2 fps ×
observed blanks per loop boundary — not measured, because no capture exists at
this geometry. Count what the real capture actually shows and put the number
and its justification into `configs.acceptance.json`'s `notes`. A budget
carried over from a different capture is the unbounded tolerance §8 exists to
remove.

### 5. While set up: the white row

```bash
python -m tools.oracle.harness run --live --interface 8 --seconds 8 \
    --configs tools/oracle/configs.acceptance.json \
    --only acceptance-white-identity
```

Cheap, and it checks packet count, headers and controller placement. It cannot
detect a port swap at all — solid colour carries no positional information.

---

## What this capture answers

Four open questions, one 8-second window. Nothing else on the project's list
approaches that ratio.

**Before reading any of them as the diagnosis, apply the discriminator in §5.**
Four of these five failure modes localise to a port. The fifth does not, and it
is the one that looks most like the others.

**1. The first multi-controller oracle.** Every capture in `captures/` is the
single-controller 2026-08-06 rig. Every multi-controller claim in `mapper/`
rests on invariants alone, and the acceptance geometry is three controllers
with a partial last one. *Failure looks like:* `systematic-mismatch` located at
a port on controller 1 or 2, with `recur` near 100 %.

**2. The Device-Order convention.** That Device Order `0k` means byte 1 = `k−1`
is **nowhere established**. Byte 1 was identified as the controller index from
a capture where it was always `0x00`, and a single-controller rig cannot
distinguish "byte 1 is the controller index" from any relabelling of it. The
entire §3 decision procedure in `docs/RUNSHEET-10x5-4P.md` is stated against
it. **This is the assumption most likely to be wrong in the whole project.**
*Failure looks like:* the bytes are right but land on the wrong physical unit —
invisible on the wire, visible only on the floor. The capture constrains it;
the run-sheet's §3 sends resolve it.

**3. Real data for the port-fault claim.** F2 — a port reading an adjacent tile
column — is undetectable in every existing capture, because tile columns 6 and
7 carry identical content in all of them. gradient24 is per-pixel-unique, so
this is the first file that contains the information.

**4. The scan table.** `mapper/floors.py::_identity_scan` is decompilation-only.
`CAPTURE_RESULTS.md` Q4's two observed pixels are **both on tile row 0**, where
a standard serpentine is indistinguishable from identity — so Q4 is **zero
evidence against serpentine**, the most common real tile wiring. A
per-pixel-unique capture is what discriminates. *Failure looks like:* a
mismatch that recurs on every port equally rather than locating to one, since a
wrong scan table is wrong inside every tile.

**5. Whether Ledset transforms pixel values on the way to the wire.** Newly
exercised by this capture, and not previously on the list. Every Ledset capture
the project holds is saturated-only — black, white, red, halves — and `0x00`
and `0xFF` are fixed points of any brightness scale or gamma LUT, so **nothing
captured so far constrains intermediate pixel values at all**. `PROTOCOL.md` Q6
carries brightness/gamma as open, and gradient24 is almost entirely
intermediate values, so this is the first file that can see it. *Failure looks
like:* zero frames matched, mismatch on every packet ordinal, `recur` near
100 % — **the same surface reading as a wrong scan table (4).**

### 5b. The discriminator — run this before concluding anything

Modes 1–3 localise: the failing rows name one or two `ctrlN/portM`. Modes 4 and
5 do not, and they are told apart by *what* the bytes are, not where:

- **A wrong scan table permutes bytes within a tile.** The multiset of byte
  values inside one tile's payload is unchanged; only their order moved.
- **A value transform changes the values.** Observed is a monotone function of
  expected — same ordering, different magnitudes — and the multiset changes.

The capture is already on disk, so this costs no floor time. Do not queue a
change against `mapper/floors.py::_identity_scan` until the multiset test has
ruled out mode 5. The "held" note below defers brightness/gamma on the grounds
that nothing in *our* send path touches pixel values; that says nothing about
Ledset's.

---

## 6. The `cbo_Type` read defect — found, diagnosed live, and fixed

`verify-xml-control-path.ps1`'s old `ComboText` helper collected the `Name` of
every descendant `Text` element of `cbo_Type` and joined them; against the live
app it collected nothing and returned `""`, so the four-way `-and` comparison
could never pass. **Root cause, found by exhaustive live enumeration** (every
`AutomationElement.*Property` on the selected item, `LegacyIAccessiblePattern`
absent from this UIA assembly, `ItemContainerPattern` returning only the
already-selected container): **a closed `cbo_Type` has zero `Text`
descendants.** The item's `DisplayName` TextBlock does not exist until the
popup has opened at least once — `06-halves`-style tile-uniform evidence, but
for UI Automation instead of packets.

**Fixed 2026-08-08**, and re-verified live against the same candidate used
above: `cbo_Type.ExpandCollapsePattern.Expand()` realizes all four items'
`Text` children (`6x6_4P` / `6x6_8P` / `8x8_4P` / `8x8_8P`, in `ItemsSource`
order), and — confirmed by comparing the selected item's `RuntimeId` before and
after — **`Expand()`/`Collapse()` changes only `ExpandCollapseState`, never the
selection**, and the realized containers stay realized after `Collapse()`. The
new `TypeComboText` matches the pre-expand selected item's `RuntimeId` against
the post-expand `ListItem`s and reads that one item's text, so it is still a
pure read in effect — nothing is clicked, nothing chosen — even though the
dropdown now opens and closes once. Re-run: `typeText='8x8_4P'`,
`MATCH: True`, everything else unchanged from the first run.

**The width/height reasoning in the original diagnosis was wrong and is struck
here rather than silently fixed**, because the error is worth keeping visible.
`width`/`height` come from `cbo_FeetOfWidth`/`cbo_FeetOfHeight`, and per
`mapper/floors.py`'s own comment, Ledset's feet are `(index + 1) * 2` — a bug
that assumes every tile is 2 ft regardless of the floor type's real pitch. That
makes `width`/`height` a readout of `tile_cols`/`tile_rows` **alone**, with zero
dependence on `tile_px`, so a `6x6_4P` floor at the same 10×5 tile grid would
have produced the exact same `width=20ft height=10ft controllers=3` reading.
Those three numbers therefore could not have distinguished `6x6_4P` from
`8x8_4P` — only `cbo_Type`'s own text (or the physical tile pitch, unobservable
from the UI at all) can. The geometry was still correctly `8x8_4P`, confirmed
independently by the packet capture below, but the three-number argument that
was standing in for `cbo_Type` never actually closed that gap.

The geometry is now confirmed by two independent readings:

1. `typeText='8x8_4P'`, `controllerCount = 3`, both read directly and matching
   what was written, and operator-confirmed on screen.
2. **The capture, which is stronger than any UI readback.** A wrong floor type
   yields a different packet plan entirely — different packet count, different
   lengths, different byte 4 sequence. 68 of 72 frames matched the `8x8_4P`
   10×5 plan byte for byte. Nothing else in the legal envelope does that, and
   this one is immune to the width/height blind spot above since it never goes
   through the feet dropdowns at all.

So the read side of decision 5's control path *is* verified live, cleanly now:
Ledset picked up a mapper XML written by `python -m mapper xml` and reported
back the exact geometry it described, `typeText` included. `docs/ORACLE_HARNESS.md`
§2's "read side unverified live" is closed, and the earlier caveat about the
script's own verdict line no longer applies — `MATCH: True` can be trusted
going forward.

---

## Held until after this probe — decisions, not oversights

Struck through where gate 2 settled them.

- ~~**`max_tolerated` re-measurement**~~ — done. Measured 4 tolerated frames in
  each of two captures; budget tightened 9 → 8.
- **The hardware floor session** per `docs/RUNSHEET-10x5-4P.md`, and
  arrangement #2 in the same session (decision 20). Gate 4. Every prediction in
  that run-sheet is untested; two critic rounds hardened it, no hardware has
  touched it. **This is now the first action**, and mode 2 above is what it
  exists to settle.
- **Arrangement #2's capture row** — the controllers have to move first, so it
  belongs to that session and was deliberately out of scope here.
- **Recurrence threshold refinement.** 25 %, resting on two measurements
  (2.3 % ceiling on real captures, ~93–96 % for injected faults). The real
  multi-controller capture came in at **1 %**, at the bottom of the band and
  nowhere near the middle, so the condition for revisiting it was not met and
  it stays at 25 %.
- **Player-page UI automation** (`docs/ORACLE_HARNESS.md` §6 item 4). The probe
  did the same work by hand in about ten minutes. Automating it is convenience,
  not evidence, and is now worth less than it was.
- ~~**Brightness/gamma** (`docs/PROTOCOL.md` Q6)~~ — closed for playback by the
  gradient24 capture. Ledset transforms nothing on the way to the wire.
- **`ComboText`'s empty read** — §6. Before gate 4, not during it.
- **The wiring-diagram generator** — parked per decision 16, and the argument
  for reimplementing rather than screenshotting it is in handoff 4 §5. The
  Ledset screenshot sweep is archived under `reference/ledset-diagrams/` as its
  fixture set.
- **Merge to `main`** — nothing lands until the *floor* confirms it, and gate 2
  confirmed the wire, not the floor. Gate 4 is still the condition.
