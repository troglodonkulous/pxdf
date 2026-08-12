# ddf — working notes for Claude Code

Geometry-independent sender for Symphonia LED dance floor. Replace vendor Ledset software. This file hold things session cannot derive from code — would rediscover expensive, or get wrong.

## The one thing to internalise

**This project has produced seven self-consistent-but-wrong conclusions.** "512-byte packet", "byte 4 always 0x00", frame counts low by one across all six captures, fps wrong both directions, oracle classifier that passed genuinely wrong mapping by laundering it as vendor defect, `oracle.harness --live` silently grading stored capture while live send on wire, app acceptance gate reporting green while dependency it existed to check never installed.

Every measurement here taken through tooling this project also wrote. Error in instrument reproduces itself in result, look like confirmation. **Check provenance, never plausibility.** Result that look right is dangerous kind — ask which file it came from, when that file written. `docs/PRE-PROBE.md` §6 write up one instance full; `docs/RUNSHEET-10x5-4P.md` §11 write up most recent.

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
python -m unittest discover -t . -s mapper/tests        # 70 tests, ~20 s
python -m unittest discover -t . -s tools/oracle/tests  # 39 tests
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
    && npm run typecheck && npm test   # 56 tests
```

## The rig

**Shop:** 10 × 5 tiles of `8x8_4P` = 80 × 40 px on **three** controllers.
**Job:** 10 × 12 tiles of `8x8_4P` = **80 × 96 px**, same three controllers, ports 4/4/2, but **5 packets per port instead of 2** — 50 packets, 23,290 bytes per frame. Every job-rig number derived from `mapper plan`; none seen on hardware, and twelve tiles deep per chain not rehearsed by shop rig. White frame and per-column walk before content.

Cabled left-to-right, monotonic. Sender NIC `10.200.50.78/8`; dumpcap interface number **not stable across reboots** — re-derive with `python -m tools.oracle.harness list-interfaces`.

- Connector 1 = ports 0, 1; connector 2 = ports 2, 3 for `_4P` unit.
- Controller 1 (Master/IR) **times out ~5 s after packets stop**, reverts to local content; controllers 2 and 3 hold last frame forever. Not defect. Expect constantly with `--forever`.
- Power down all three controllers before moving any data cable.
- **Never run Ledset and either sender at the same time.**

## Settled — do not reopen

- **Orientation is `identity`, permanently.** Floor cabled left-to-right. `mapper/orientation.py` is *cabling compensation* — exists to correct mis-patched floor, applied at wire-mapping stage. Do not add orientation features, do not give `mapper/` non-identity default.
- **App's Rotation is not orientation, two must never merge.** Setup's Rotation (0/90/180/270) is *presentation* transform, so operator can author physically 80 × 96 portrait floor as 96 × 80 landscape canvas. Lives in app's final composite pass. `mapper/` still receives 80 × 96 row-major RGB framebuffer at every rotation, needs **zero** changes. Conflating two is how this become seventh self-consistent-but-wrong result.
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
- **Stopping the send does not black the floor.** Controller 1 reverts to local content ~5 s later while 2 and 3 hold last frame, so app BLACKOUT, cue gaps, idle must all send *black frames*. Socket opens with show file, never closes.
- **`design/mockups.html` renders superset of what ships.** Direction (Fwd/Rev/Bounce), Custom layout, Calibrate… all appear in it, all shelved or scrapped. `docs/REQUIREMENTS-v1.pdf` wins over mockups, `docs/APP-PLAN.md` say what cut and why.
- **Delegated builder acceptance command needs one leg that fails when dependency absent.** PR 1's was `typecheck && test && build`, run in sandbox without network where `npm install` silently no-op'd; gate reported green over the whole half of the PR it existed to check. No single leg buggy — externalising `electron` correct for bundler, `@ts-ignore` on unresolvable import normal local workaround, unit tests not spawning processes ordinary. Defect lived only in conjunction — why reading any one file would not show it. `typecheck` does catch it today, but only because no `@ts-ignore` masks the import any more — one re-added comment and that gone, so do not rely on it. `npm ls` is cheap unconditional check and **not** sufficient alone: `npm install` can report success while large binary payload never arrives, and `npm ls` call that healthy. Where deliverable is *process*, make something launch it. See **Delegating to Codex** below for sandbox mechanism this happened through and mitigations now in place.

## Delegating to Codex

Codex builder/critic pairs run through `codex` plugin `codex-companion.mjs`, which start every `--write` task in Codex CLI `workspace-write` sandbox. That sandbox network access controlled **only** by `[sandbox_workspace_write]` `network_access` in `.codex/config.toml` — never by anything in task prompt, because sandbox is process boundary Codex CLI enforces, not something Codex told about. PR 1's `npm install` silently no-op'd for exactly this reason: sandbox had no network and nothing in acceptance chain could see gap. Traps entry above is fix *around* that; this is mechanism it was never fix *of*.

- **`network_access = true` set in this repo `.codex/config.toml`, scoped to `ddf` only** — not in `~/.codex/config.toml`, which would widen it to every trusted project on this machine. Decided 2026-08-12. Lets `npm install` run inside sandbox, but also means any future `--write` Codex run in this repo can reach network for anything, not just installs. Accepted scoped risk, not non-issue — do not copy setting into global config without deciding that tradeoff again.
- **Network access does not remove need to verify.** Fixes "can sandbox reach npm," not "did install actually finish." After every Codex builder run touching dependencies, check `ls node_modules/<pkg>` (or run `npm ls`) yourself before trusting its acceptance report, and if deliverable is process, launch it. Green report not proof.
- **Forbid `@ts-ignore` / `@ts-expect-error` on import that will not resolve**, explicitly, in every builder prompt. That is the specific move that blinded `tsc` in PR 1, and it reads as reasonable local workaround every time it happens.
- **Stop-time review gate enabled** (`codex:setup
  --enable-review-gate`, toggled 2026-08-12). Reviews *orchestrator's* own turn at Stop, not Codex sandboxed run — exists to catch orchestrator accepting Codex report too readily, not to catch Codex itself. `--disable-review-gate` turns back off; state local to this machine checkout path, not part of repo.

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

| Read | For |
|---|---|
| `docs/APP-PLAN.md` | **The app, and canonical copy.** Stack, render pipeline, geometry rules, gates, build order, cut list. `docs/app-plan.html` is dated snapshot of same material, can lag — where differ, `.md` wins. |
| `docs/REQUIREMENTS-v1.pdf` | Feature scope with operator annotations. Wins over mockups. |
| `design/` | `mockups.html` is visual spec — open from disk, loads `support.js` and `design-system/` from this repo. `design-system/` holds tokens, spec, 20 components as readable source. |
| `docs/PROTOCOL.md` | Wire format and mapping. §3–§4 closed. |
| `docs/RUNSHEET-10x5-4P.md` | Floor-verified findings. §10 is gate-4 tables, §11 the Phase 4 media session. Authoritative. |
| `mapper/README.md` | Module layout, how to run suites, frame-rate/scaler/fit rationale. |
| `docs/PRE-PROBE.md` | §6 documents one instance of failure mode above. |
| `docs/HARDWARE-TILE-DEFECT.md` | Orange-at-white tile defect: symptom, exclusions, vendor-stack sweep, rail-droop hypothesis and its falsifying test, why calibration abandoned. §1–§3 findings; §4 onward unverified. |

Do not re-read decompiled Ledset source under `decompiled/` unless something specifically requires it; it is archaeology and has misled this project before.