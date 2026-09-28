# ddf — working notes for Claude Code

Geometry-independent sender for Symphonia LED dance floor. Replace vendor Ledset software. This file hold things session cannot derive from code — would rediscover expensive, or get wrong.

## The one thing to internalise

**This project failure mode is not wrong conclusions. It is conclusions that survive their own disproof, because the disproof had nowhere to go.**

Ten times now. Every one contradicted by something the system already knew: captures held the 458-byte packets, the classifier held the disproof and emitted it under a different label, the stored capture timestamp was on disk, `node_modules` was empty, the `SecurityError` was raised sixty times a second. None of it reached a reader. Full write-ups in `docs/POSTMORTEMS.md` — read it when a result looks right.

Every fix that ever worked here added a **channel for bad news**. When you build or fix any instrument, ask what it does when it is broken, and make that answer loud, propagating, and distinguishable from success.

- **Propagate to caller.** Fatal error sets non-zero exit. Script that print a failure and exit 0 is a green gate over a broken thing.
- **Let exceptions escape.** Page, process or subprocess that *threw* must never read as one that *answered*. Check `exceptionDetails`, check exit status. `catch {}` on a path that decides something is how the render loop died silently for a whole session.
- **Every measurement harness needs a positive control** — a row whose failure means *instrument broken, discard everything*. State it as refusal: print no table rather than a table of failures.
- **Grade operator-visible consequence, never internal symptom.** Internal symptoms move when you fix things. Consequences do not.
- **Silence must be distinguishable from success.** `allBlack([])` return `true`; a skipped test still report OK; zero packets pass a check written "all packets are black". Assert the count as well as the property.
- **Correction propagates to everything built on the old claim** — the list, the table, the prose that argued for it, the test, and the comment citing the measurement.
- **Cited evidence stays re-runnable and in repo.** Measurement whose instrument was thrown away is a claim, not evidence.
- **Channel that cry wolf is a destroyed channel.** A leak warning fired on every clean teardown, because a signal-killed child report `signalCode` and leave `exitCode` null forever. One false positive train everyone to ignore the true one.
- **Mutation-check.** Remove the fix, confirm red, restore. Only thing that catch a fix disarming the regression test for the bug it fixed.

Every measurement here taken through tooling this project also wrote. Error in instrument reproduce itself in result, look like confirmation. **Check provenance, never plausibility** — ask which file it came from, when that file written. **Two findings from one instrument are one finding**; they cannot corroborate each other.

Observation disagree with prediction: stop and diagnose. Do not rationalise.

## Environment

- **Python 3.12, no third-party dependencies in `mapper/`.** Keep that way. Rule scoped to `mapper/` and always was — `app/` is Electron project with ordinary `node_modules`, not violation. ffmpeg prerequisite of `tools/make_clip.py` only.
- **`python3` is Microsoft Store stub, will fail.** Use `python` or `py`. That, plus ffmpeg path below, are facts about **Windows** machine. App work happen on Mac, where `python3` fine and ffmpeg on `PATH`.
- **On macOS oracle suite reports `(skipped=1)`** — skip is `no powershell/pwsh on PATH`, expected there, not defect. The `(skipped=1)` to worry about is *mapper* suite's, below.
- **No pytest.** stdlib `unittest`.
- ffmpeg installed but may not be on shell `PATH` if shell predates install:
  `C:\Users\USER\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin`.
  Without it `mapper/tests/test_make_clip.py` round-trip **skips silently** and suite still reports OK — check for `(skipped=1)`.

## The verification bar

All run off-hardware. Run all before claiming anything done.

```bash
python -m unittest discover -t . -s mapper/tests        # ~20 s
python -m unittest discover -t . -s tools/oracle/tests
python -m mapper matrix                                 # 2400 configs
python -m tools.oracle.harness run --configs tools/oracle/configs.acceptance.json
python -m tools.oracle.harness run --configs tools/oracle/configs.appendix.json

# the cutover's whole grade — these two must print the same digest
python -m mapper play test-patterns/09-gradient24-8x8_4P-10x5.avi \
    --type 8x8_4P --cols 10 --rows 5 --dry-run | tail -1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 --dry-run | tail -1
#   -> 10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057

# the same bar at the job geometry, derived 2026-08-11. The app is graded
# against both -- see docs/APP-PLAN.md.
python -m mapper send --type 8x8_4P --cols 10 --rows 12 --pattern gradient24 --dry-run | tail -1
#   -> 12df0afcfb2c05be3b967822ae965dc251578b27f4813d372447c3d09d59352d

# the app. `npm ls` catches an unmet dependency; `electron --version` catches a
# package whose binary never downloaded, which `npm ls` reports as fine.
cd app && npm ls >/dev/null && npx electron --version >/dev/null \
    && npm run typecheck && npm test
```

Test counts are deliberately absent — they went stale in a day once. The runner prints them.

## The rig

**Shop:** 10 × 5 tiles of `8x8_4P` = 80 × 40 px on **three** controllers.
**Job:** 10 × 12 tiles of `8x8_4P` = **80 × 96 px**, same three controllers, ports 4/4/2, but **5 packets per port instead of 2** — 50 packets, 23,290 bytes per frame. Every job-rig number derived from `mapper plan`; none seen on hardware, and twelve tiles deep per chain not rehearsed by shop rig. White frame and per-column walk before content.

Cabled left-to-right, monotonic. Sender NIC `10.200.50.78/8`; dumpcap interface number **not stable across reboots** — re-derive with `python -m tools.oracle.harness list-interfaces`.

- Connector 1 = ports 0, 1; connector 2 = ports 2, 3 for `_4P` unit.
- Controller 1 (Master/IR) **times out ~5 s after packets stop and reverts to local content** — but that is Master/IR-mode behaviour specifically. **All three controllers can also run in slave mode**, in which case controller 1 holds its last frame indefinitely, the same as 2 and 3. Corrected 2026-08-14 from an unconditional claim; neither mode is a defect, and this repo does not track at runtime which mode controller 1 is actually in. Does not weaken the black-frames-on-idle rule below — see Traps.
- Power down all three controllers before moving any data cable.
- **Never run Ledset and either sender at the same time.**

## Settled — do not reopen

- **Orientation is `identity`, permanently.** Floor cabled left-to-right. `mapper/orientation.py` is *cabling compensation* — exists to correct mis-patched floor, applied at wire-mapping stage. Do not add orientation features, do not give `mapper/` non-identity default.
- **App's Rotation is not orientation, two must never merge.** Mapping's Rotation (0/90/180/270) is *presentation* transform, so operator can author physically 80 × 96 portrait floor as 96 × 80 landscape canvas. Lives in app's final composite pass. `mapper/` still receives 80 × 96 row-major RGB framebuffer at every rotation, needs **zero** changes. Conflating the two is a pre-written postmortem.
- **Mapping diagram is jack-level at every type**, decided 2026-08-13. Controller has 4 physical jacks; each carry 2 ports = 2 adjacent tile columns, so 10-column `8x8_4P` rig is **5 cables, not 10** (`docs/PROTOCOL.md` §1 gate 4, cable trace `docs/RUNSHEET-10x5-4P.md:1546-1560`). Ledset draw its `_4P` diagram port-wise and is **wrong** on this — deliberate departure, do not "fix" it back from `decompiled/`. Port↔column stay 1:1 in `mapper/`; jack layer live only in app diagram.
- **Status pill say what sender process do, never what floor do.** `sending`/`restarting`/`stopped`. `mapper` broadcast UDP and never `recv`, sidecar spawn Python with stdout `ignore` — no acknowledgement exist to read. Do not add ping/ARP probe; unverified on these controllers and a probe that go quiet is a channel that cry wolf.
- **Surface is called Mapping, never Setup.** Mockups say Mapping, operator says Mapping; old plan said Setup. Decided 2026-08-12. Same day, build order became PRs 1–6 with new **PR 3 `app-mapping`** inserted before compositor — `docs/APP-PLAN.md` build order is authority.
- **macOS app is Electron + TypeScript + React driving `mapper/` as sidecar**, decided 2026-08-11. Not SwiftUI, and **mapper is not ported** — only hardware-graded code in repo. Read `docs/APP-PLAN.md` before writing app code; hold render pipeline, geometry rules, gates. Supersede `README.md` old plan steps 4–6.
- **Composite at `floor_px × S`, downsample once at end.** Floor resolution is output format, never project format. Layer transforms stored normalised 0–1 however displayed. `docs/APP-PLAN.md` has the measurement this come from.
- **Ledset is reference-only** since 2026-08-08. `mapper play` beat it on wire: 80/80 frames exact, 0 tolerated defects, against Ledset 68/72 with 4. See `docs/RUNSHEET-10x5-4P.md` §11.
- **Frame rate, scaler, fit decided at floor**, not by reasoning. Floor drops no frames at 10/15/24/30/60 — 10 fps never ceiling, only vendor habit. `DEFAULT_FPS = 30`, `MAX_ADOPTED_FPS = 30` (60 renders faithfully, judders on fast motion, no gain). `play` reads clip own rate from `strh` and obeys, capped; explicit `--fps` wins and never capped. `--scaler area`, `--fit cover`.
- **`tools/Send-FloorTest.ps1` must not be modified.** Whole value = *independent* second implementation of wire protocol. If you invoke it, **`-PortsPerController 4` is mandatory** — default of 8 silently miscompute every controller boundary on this rig.
- Remaining `.ps1` files stay. Speculative ports explicitly declined.
- `gradient24` red channel wraps once at tile index 37, look like floor anomaly on hardware. Not — `docs/RUNSHEET-10x5-4P.md` §10, V4 row.
- **Colour calibration built, merged, reverted in full 2026-08-11.** Four tiles read orange at high white; cause is sagging 5 V rail on each tile own buck converter, so correction a gain would need is load-dependent and no per-region constant can track it. Do not re-add `mapper/calibration.py` or `tools/calibrate.py`. Defect, exclusions, fix ladder in `docs/HARDWARE-TILE-DEFECT.md`.

## Traps

- **Most test patterns wrong size.** `01`–`08` including `08-sweep.avi` are **64×40**, authored for old 8×5 rig, and `play` rejects them on this floor. Only `09-gradient24-8x8_4P-10x5.avi` and `10-sweep-8x8_4P-10x5.avi` are 80×40.
- **`oracle.harness --live` only captures for config row whose `capture` is `null`.** On row that already has one it now refuses with exit 2 rather than silently re-grading stored file. To measure new sender, add *new* row with new name and null capture — see `tools/oracle/configs.appendix.json`.
- **Clip sent at rate it was not authored for plays at wrong speed and no byte comparison in this project can see it** — every individual frame correct, only spacing between them wrong.
- `max_tolerated` budgets **measured per capture window and clip length**. Re-derive if either changes; budget carried over from different capture is exactly the unbounded tolerance the field exists to remove.
- **Stopping the send does not black the floor.** In Master/IR mode controller 1 reverts to local content ~5 s later; in slave mode it holds its last frame like 2 and 3 do unconditionally. Either way nothing blacks the floor on its own, so app BLACKOUT, cue gaps, idle must all send *black frames*. Socket opens with show file, never closes.
- **`design/mockups.html` renders superset of what ships.** Direction (Fwd/Rev/Bounce), Custom layout, Calibrate… all appear in it, all shelved or scrapped. `docs/REQUIREMENTS-v1.pdf` wins over mockups, `docs/APP-PLAN.md` say what cut and why.
- **Grab the log before relaunching after a fault.** `~/Library/Logs/DDF Sender/ddf.log`
  packaged, `~/Library/Logs/Electron/ddf.log` unpackaged — macOS derives that folder from
  the app name, not from `--user-data-dir`. Launch rotates it to `ddf.prev.log`, so one
  restart is survivable and **two overwrite the evidence**. Copy the file, do not rely on
  the rotation. Timestamps are ISO **UTC**, not venue local.
- **App traps live in `docs/APP-PLAN.md`, not here** — `corsEnabled` and the render loop that dies silently, a fix disarming the regression test for its own bug, `wire.mjs` asserting on wire then polling the DOM. Read it before app code.

## Git

Work lands via **pull request**, from 2026-08-08. Four merges already in history predate that decision — do not copy their direct-merge style.

**Stop at the open PR. Merging is the user's call, every time**, from 2026-08-10. Open PR, report its URL, wait. An approved plan that lists a merge step is not the approval — only the user saying so, for that PR, is. Applies to agents and subagents alike; no subagent merges anything.

```bash
git checkout -b <branch>          # never commit on main
git push -u origin <branch>
gh pr create --fill
# then stop. `gh pr merge --merge --delete-branch` only after the user says so.
```

**Merge, never squash, never rebase.** This project commit messages are primary record of *why* each decision made, several deliberately longer than their diffs. Squashing destroys that.

Large media (`test-patterns/Test Clips/`, ~188 MB) and `tools/oracle/out/` gitignored. Captures and test-pattern AVIs under ~1 MB **are** tracked, on purpose — they are evidence.

## Where the real documentation is

| When | Read |
|---|---|
| **A result looks right** — before believing it | `docs/POSTMORTEMS.md` |
| **Delegating to Codex** — builder, critic, any `--write` task | `docs/DELEGATION.md` |
| **Reading a floor-test log**, or extending what it records | `docs/APP-PLAN.md` §"The log, and the three failures that had no channel" — what each source means, what the heartbeat proves, and what is deliberately not logged |
| **Writing app code** — any of it | `docs/APP-PLAN.md`, **the app's only copy**. `docs/app-plan.html` deleted 2026-08-12; two forms of one plan drifted on load-bearing scope once already, do not recreate it |
| Deciding whether a feature is in scope | `docs/REQUIREMENTS-v1.pdf`, operator-annotated, wins over mockups |
| Building any UI | `design/mockups.html`, open from disk — loads `support.js` and `design-system/` from this repo |
| Touching wire format or mapping | `docs/PROTOCOL.md`, §3–§4 closed |
| Citing anything measured on hardware | `docs/RUNSHEET-10x5-4P.md` §10 gate-4 tables, §11 Phase 4 media |
| Running or extending a mapper suite | `mapper/README.md` |
| Building PR 3, the Mapping surface | `docs/MAPPING-DIAGRAM.md`, so nobody re-reads `decompiled/` for it |
| Planning a hardware session | `docs/PRE-PROBE.md` |
| Anyone raises the orange tiles again | `docs/HARDWARE-TILE-DEFECT.md`, §1–§3 findings, §4 onward unverified |

Do not re-read decompiled Ledset source under `decompiled/` unless something specifically requires it; it is archaeology and has misled this project before.
