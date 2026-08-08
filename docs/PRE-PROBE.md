# Pre-probe — what is staged, and the attended session script

**Date:** 2026-08-08
**Branch:** `generalize-geometry`
**Gate:** 2 — the attended Player-page probe and the first multi-controller
capture. Listed as the first action in every handoff since 2026-08-07 and not
yet run.

This document exists so the attended session spends its time capturing packets
and nothing else. Everything below the "staged" line was verified on this
machine on 2026-08-08 with nothing transmitted and nothing lit.

Read `docs/ORACLE_HARNESS.md` §6 for the reasoning behind the order of the run;
this is the operator's copy, not a replacement for it.

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
| Ledset media folder | `Configure.ini` `ProgramPath` = `C:\Users\USER\dev\ddf\test-patterns` (read live; the dump in `captures/configure-ini-dump.txt` is stale) |
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

**`--only` is not optional.** Without it the run walks all three acceptance
rows back to back, including the one that needs the controllers physically
moved first, and records three windows of whatever was on the wire.

The capture lands in `captures/oracle/acceptance-gradient24-identity.pcapng`
and the verdict prints immediately. A second opinion on the same file:

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

---

## Held until after this probe — decisions, not oversights

- **`max_tolerated` re-measurement** — needs the capture (step 4 above).
- **The hardware floor session** per `docs/RUNSHEET-10x5-4P.md`, and
  arrangement #2 in the same session (decision 20). Gate 4. Every prediction in
  that run-sheet is untested; two critic rounds hardened it, no hardware has
  touched it.
- **Arrangement #2's capture row** — the controllers have to move first.
- **Recurrence threshold refinement.** 25 %, resting on two measurements
  (2.3 % ceiling on real captures, ~93–96 % for injected faults). The gap is
  wide enough that precision buys nothing; revisit only if the real capture
  lands anywhere near the middle.
- **Player-page UI automation** (`docs/ORACLE_HARNESS.md` §6 item 4). Steps 1–5
  do the same work by hand. Automating it is convenience, not evidence.
- **Brightness/gamma** (`docs/PROTOCOL.md` Q6). Nothing in the send path
  touches pixel values. Low-priority appendix at the end of the floor session.
- **The wiring-diagram generator** — parked per decision 16. The Ledset
  screenshot sweep is archived under `reference/ledset-diagrams/` as its
  reference.
- **Merge to `main`** — nothing lands until the floor confirms it.
