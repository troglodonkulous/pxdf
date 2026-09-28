# ddf — working notes for Claude Code

A geometry-independent sender for the Symphonia LED dance floor, replacing the vendor's Ledset software. This file holds what a session cannot derive from the code: things it would rediscover expensively, or get wrong.

## The one thing to internalise

**This project's failure mode is not wrong conclusions. It is conclusions that survive their own disproof, because the disproof had nowhere to go.**

It has happened ten times. Each time, something the system already knew contradicted the conclusion: the captures held the 458-byte packets; the classifier held the disproof and emitted it under a different label; the stored capture timestamp was on disk; `node_modules` was empty; the `SecurityError` was raised sixty times a second. None of it reached a reader. The full write-ups are in `docs/POSTMORTEMS.md` — read it when a result looks right.

Every fix that has ever worked here added a **channel for bad news**. When you build or fix any instrument, ask what it does when it is broken, and make that answer loud, propagating, and distinguishable from success.

- **Propagate to the caller.** A fatal error sets a non-zero exit. A script that prints a failure and exits 0 is a green gate over a broken thing.
- **Let exceptions escape.** A page, process or subprocess that *threw* must never read as one that *answered*. Check `exceptionDetails`; check the exit status. A `catch {}` on a path that decides something is how the render loop died silently for a whole session.
- **Every measurement harness needs a positive control** — a row whose failure means *the instrument is broken, discard everything*. Make it a refusal: print no table rather than a table of failures.
- **Grade the operator-visible consequence, never an internal symptom.** Internal symptoms move when you fix things. Consequences do not.
- **Silence must be distinguishable from success.** `allBlack([])` returns `true`; a skipped test still reports OK; zero packets pass a check written "all packets are black". Assert the count as well as the property.
- **A correction propagates to everything built on the old claim** — the list, the table, the prose that argued for it, the test, and the comment citing the measurement.
- **Cited evidence stays re-runnable and in the repo.** A measurement whose instrument was thrown away is a claim, not evidence.
- **A channel that cries wolf is a destroyed channel.** A leak warning fired on every clean teardown, because a signal-killed child reports `signalCode` and leaves `exitCode` null forever. One false positive trains everyone to ignore the true one.
- **Mutation-check.** Remove the fix, confirm the test goes red, restore it. It is the only thing that catches a fix disarming the regression test for the bug it fixed.

Every measurement here is taken through tooling this project also wrote. An error in the instrument reproduces itself in the result and looks like confirmation. **Check provenance, never plausibility** — ask which file a number came from and when that file was written. **Two findings from one instrument are one finding**; they cannot corroborate each other.

When an observation disagrees with a prediction, stop and diagnose. Do not rationalise.

**The same applies to this project's own rules.** Every standing decision lives in `docs/DECISIONS.md` with what it protects, its evidence, and what would reopen it. When evidence contradicts one, record it on the entry (`Challenged by:`) rather than working around the rule or ignoring the evidence. See [Decisions](#decisions).

## Environment

- **Python 3.12, standard library only, in `mapper/`** (D-05). The rule is scoped to `mapper/` and always was; `app/` is an Electron project with ordinary `node_modules`. ffmpeg is a prerequisite of `tools/make_clip.py` only.
- **On the Windows machine, `python3` is the Microsoft Store stub and fails.** Use `python` or `py`. That and the ffmpeg path below are facts about the Windows machine. App work happens on the Mac, where `python3` works and ffmpeg is on `PATH`.
- **On macOS the oracle suite reports `(skipped=1)`.** The skip is `no powershell/pwsh on PATH`, expected there and not a defect. The `(skipped=1)` to worry about is the *mapper* suite's, below.
- **No pytest.** The suites use stdlib `unittest`.
- On Windows, ffmpeg is installed but may not be on a shell's `PATH` if the shell predates the install:
  `C:\Users\USER\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin`.
  Without it, the `mapper/tests/test_make_clip.py` round-trip **skips silently** and the suite still reports OK — check for `(skipped=1)`.

## The verification bar

All of it runs off-hardware. Run all of it before claiming anything is done.

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

# The same bar at a second, deeper geometry -- twelve tiles per chain against
# the shop rig's five. This is what grades the "geometry-independent" claim in
# the first line of this file: one shape cannot catch a packets-per-port
# assumption. It is a paper geometry, never run on hardware, and it is NOT
# "the job" -- see docs/JOBS.md. The app is graded against both; see
# docs/APP-PLAN.md. Digest derived 2026-08-11; re-derive if mapper/ changes.
python -m mapper send --type 8x8_4P --cols 10 --rows 12 --pattern gradient24 --dry-run | tail -1
#   -> 12df0afcfb2c05be3b967822ae965dc251578b27f4813d372447c3d09d59352d

# the app. `npm ls` catches an unmet dependency; `electron --version` catches a
# package whose binary never downloaded, which `npm ls` reports as fine.
cd app && npm ls >/dev/null && npx electron --version >/dev/null \
    && npm run typecheck && npm test
```

Test counts are deliberately absent — they went stale in a day once. The runner prints them.

## The rig

**Shop:** 10 × 5 tiles of `8x8_4P` = 80 × 40 px on **three** controllers. The bench rig, and the only one this repo can assume.

**A specific show's geometry is not a fact about this project** (D-19). Tile counts belong to a booking and go stale the moment it ends — quietly, because nothing in the repo contradicts them. This file carried "the job is 10 × 12" for a month, and the only job that has ever run was 10 × 10. Per-show records live in `docs/JOBS.md`, dated and closed; what graduates back here is the durable conclusion, never the booking. **Read `mapper plan` for the geometry in front of you, and do not assume any floor but the shop rig.**

Send a white frame and a per-column walk before content, at any geometry not already rehearsed.

The floor is cabled left to right, monotonically. The sender NIC is `10.200.50.78/8`. The dumpcap interface number is **not stable across reboots** — re-derive it with `python -m tools.oracle.harness list-interfaces`.

- On a `_4P` unit, connector 1 = ports 0 and 1; connector 2 = ports 2 and 3.
- Controller 1 (Master/IR) **times out ~5 s after packets stop and reverts to local content** — but only in Master/IR mode. **All three controllers can also run in slave mode**, in which case controller 1 holds its last frame indefinitely, the same as 2 and 3. Corrected 2026-08-14 from an unconditional claim. Neither mode is a defect, and this repo does not track at runtime which mode controller 1 is in. This does not weaken the black-frames-on-idle rule — see Traps.
- Power down all three controllers before moving any data cable.
- **Never run Ledset and either sender at the same time.**

## Decisions

The full entries — what each protects, its evidence, and what reopens it — are in `docs/DECISIONS.md`, the only copy. This index exists so every session sees every rule. **To change one, argue from its `Reopen if` line in a PR; do not work around it.**

- **D-01** — The wire encoding and the byte output of `play`/`send` are frozen. Reopen if: a controller renders this encoding wrongly, or a new tile type needs a layout it cannot express.
- **D-02** — `mapper stream` may change for the app: opt-in, default unchanged, graded by the digests plus a cadence instrument, and the default only after a floor capture. Reopen if: a boundary problem proves unfixable inside `stream` alone.
- **D-03** — Python owns the send clock. Reopen if: content cadence on the wire is off-pattern. **Reopened 2026-09-28** — cause not yet diagnosed; see the entry.
- **D-04** — Do not port the mapper (a preference). Reopen if: the sidecar boundary blocks a fix that D-02 cannot deliver, or packaging Python becomes a recurring show risk.
- **D-05** — `mapper/` uses the Python standard library only. Reopen if: a needed capability has no reasonable stdlib route.
- **D-06** — `tools/Send-FloorTest.ps1` is never modified; invoke it with `-PortsPerController 4`. Reopen if: the protocol changes.
- **D-07** — The status pill reports the sender process, never the floor; no reachability probe is built. Reopen if: a hardware session shows the controllers answer a probe reliably.
- **D-08** — Frame rate, scaler and fit are decided at the floor, not by reasoning. Reopen if: a new floor or content type is judged by eye and disagrees.
- **D-09** — `MAX_ADOPTED_FPS = 30`. Reopen if: sender pacing jitter or a panel-refresh beat is ruled out and 60 is judged again, or the app's cadence work changes what 60 looks like.
- **D-10** — Composite at `floor_px × S`, downsample once; S defaults to 8 (provisional). Reopen if: S = 4 is judged indistinguishable at the floor, or compose cost limits cadence.
- **D-11** — The app is Electron + TypeScript + React with `mapper/` as a sidecar. Reopen if: Electron blocks a show requirement.
- **D-12** — Rotation is a presentation transform, not orientation; the two never merge. Not reopenable.
- **D-13** — Orientation is `identity`, permanently. Not reopenable; a mis-patched floor is corrected with `orientation.py`'s parameters.
- **D-14** — The mapping diagram is jack-level at every type. Reopen if: a controller with different jack-to-port wiring is used.
- **D-15** — The surface is called Mapping, never Setup. Reopen if: the operator starts calling it something else.
- **D-16** — Ledset is reference-only. Reopen if: a floor capability exists only in Ledset.
- **D-17** — Colour calibration stays out. Reopen if: the tiles' power is fixed and a load-independent colour error remains.
- **D-18** — The user merges every PR, with a merge commit. Reopen if: the user says so.
- **D-19** — A booking's details are never facts about this project. Not reopenable.
- **D-20** — Merge on the off-hardware bar; the floor certifies a `floor-` tag, and shows run a packaged build of one. Reopen if: an untested change reaches a show, or `main` again falls weeks behind open work.

## Traps

- **Most test patterns are the wrong size.** `01`–`08`, including `08-sweep.avi`, are **64 × 40**, authored for the old 8 × 5 rig, and `play` rejects them on this floor. Only `09-gradient24-8x8_4P-10x5.avi` and `10-sweep-8x8_4P-10x5.avi` are 80 × 40.
- **`gradient24`'s red channel wraps once at tile index 37**, which looks like a floor anomaly on hardware. It is not — `docs/RUNSHEET-10x5-4P.md` §10, V4 row.
- **`oracle.harness --live` only captures for a config row whose `capture` is `null`.** On a row that already has one, it refuses with exit 2 rather than silently re-grading the stored file. To measure a new sender, add a *new* row with a new name and a null capture — see `tools/oracle/configs.appendix.json`.
- **A clip sent at a rate it was not authored for plays at the wrong speed, and no byte comparison in this project can see it** — every individual frame is correct; only the spacing between them is wrong. The same blindness hides cadence judder (D-03).
- **`max_tolerated` budgets are measured per capture window and clip length.** Re-derive them if either changes; a budget carried over from a different capture is exactly the unbounded tolerance the field exists to remove.
- **Stopping the send does not black the floor.** In Master/IR mode controller 1 reverts to local content ~5 s later; in slave mode it holds its last frame, as 2 and 3 always do. Either way nothing blacks the floor on its own, so the app's BLACKOUT, cue gaps and idle must all send *black frames*. The socket opens with the show file and never closes.
- **`design/mockups.html` renders a superset of what ships.** Direction (Fwd/Rev/Bounce), Custom layout, Calibrate… all appear in it, and all were shelved or scrapped. `docs/REQUIREMENTS-v1.pdf` wins over the mockups, and `docs/APP-PLAN.md` says what was cut and why.
- **Grab the log before relaunching after a fault.** It is `~/Library/Logs/DDF Sender/ddf.log`
  packaged and `~/Library/Logs/Electron/ddf.log` unpackaged — macOS derives that folder from
  the app name, not from `--user-data-dir`. Launch rotates it to `ddf.prev.log`, so one
  restart is survivable and **two overwrite the evidence**. Copy the file; do not rely on
  the rotation. Timestamps are ISO **UTC**, not venue local.
- **App traps live in `docs/APP-PLAN.md`, not here** — `corsEnabled` and the render loop that dies silently, a fix disarming the regression test for its own bug, and `wire.mjs` asserting on the wire and then polling the DOM. Read it before writing app code.

## Git

Work lands via **pull request**, from 2026-08-08. Four merges in history predate that decision — do not copy their direct-merge style.

**Stop at the open PR. Merging is the user's call, every time** (D-18). Open the PR, report its URL, and wait. An approved plan that lists a merge step is not the approval — only the user saying so, for that PR, is. This applies to agents and subagents alike; no subagent merges anything.

```bash
git checkout -b <branch>          # from main; never commit on main
git push -u origin <branch>
gh pr create --fill
# then stop. `gh pr merge --merge --delete-branch` only after the user says so.
```

**A PR is ready to merge when reviewer findings are resolved and the verification bar passes** (D-20). Nothing is held in draft waiting for hardware; that is what `floor-` tags are for. If a PR is stacked on another, retarget the one above to `main` *before* its base branch is deleted — deleting the base closes the PR stacked on it instead of retargeting it.

**Shows run a tag, never a branch.** After a floor session passes, the user tags the tested commit `floor-YYYY-MM-DD`. A show build is `npm run dist` from a `floor-` tag; it refuses a dirty `app/` or `mapper/`, and the launch line in the show log names the build. Copy that `build:` value into the show's `docs/JOBS.md` record.

**Merge, never squash, never rebase.** This project's commit messages are the primary record of *why* each decision was made, and several are deliberately longer than their diffs. Squashing destroys that.

Large media (`test-patterns/Test Clips/`, ~188 MB) and `tools/oracle/out/` are gitignored. Captures and test-pattern AVIs under ~1 MB **are** tracked, on purpose — they are evidence.

## Where the real documentation is

| When | Read |
|---|---|
| **A result looks right** — before believing it | `docs/POSTMORTEMS.md` |
| **A rule is in the way**, or you are about to argue with one | `docs/DECISIONS.md` — the entry's `Protects` and `Reopen if` lines |
| **Delegating to Codex or any agent** — builder, critic, any `--write` task | `docs/DELEGATION.md` |
| **Reading a floor-test log**, or extending what it records | `docs/APP-PLAN.md` §"The log, and the three failures that had no channel" — what each source means, what the heartbeat proves, and what is deliberately not logged |
| **Writing app code** — any of it | `docs/APP-PLAN.md`, **the app's only plan**. `docs/app-plan.html` was deleted 2026-08-12; two forms of one plan drifted on load-bearing scope once already, so do not recreate it |
| **Anything about a specific show** — what geometry it ran, what it was cabled into, what its log says | `docs/JOBS.md`. Also where a job's numbers go; they do not come back to this file |
| Reading or adding a measurement | `captures/measurements/README.md` |
| Deciding whether a feature is in scope | `docs/REQUIREMENTS-v1.pdf`, operator-annotated, wins over the mockups |
| Building any UI | `design/mockups.html`, opened from disk — it loads `support.js` and `design-system/` from this repo |
| Touching the wire format or mapping | `docs/PROTOCOL.md`, §3–§4 closed |
| Citing anything measured on hardware | `docs/RUNSHEET-10x5-4P.md` §10 gate-4 tables, §11 Phase 4 media |
| Running or extending a mapper suite | `mapper/README.md` |
| Changing the Mapping surface | `docs/MAPPING-DIAGRAM.md`, so nobody re-reads `decompiled/` for it |
| Planning a hardware session | `docs/PRE-PROBE.md` |
| Anyone raises the orange tiles again | `docs/HARDWARE-TILE-DEFECT.md`, §1–§3 findings, §4 onward unverified |

Do not re-read the decompiled Ledset source under `decompiled/` unless something specifically requires it; it is archaeology and has misled this project before.
