# ddf — working notes for Claude Code

A geometry-independent sender for a Symphonia LED dance floor, replacing the
vendor's Ledset software. This file holds the things a session cannot derive
from the code and would otherwise rediscover expensively — or get wrong.

## The one thing to internalise

**This project has produced seven self-consistent-but-wrong conclusions.** The
"512-byte packet", "byte 4 always 0x00", frame counts low by one across all six
captures, fps wrong in both directions, an oracle classifier that passed a
genuinely wrong mapping by laundering it as a vendor defect,
`oracle.harness --live` silently grading a stored capture while a live send was
on the wire, and an app acceptance gate that reported green while the dependency
it existed to check was never installed.

Every measurement here is taken through tooling this project also wrote, so an
error in the instrument reproduces itself in the result and looks like
confirmation. **Check provenance, never plausibility.** A result that looks right
is the dangerous kind — ask which file it came from and when that file was
written. `docs/PRE-PROBE.md` §6 writes up one instance in full;
`docs/RUNSHEET-10x5-4P.md` §11 writes up the most recent.

If an observation disagrees with a prediction, stop and diagnose. Do not
rationalise.

## Environment

- **Python 3.12, no third-party dependencies in `mapper/`.** Keep it that way.
  The rule is scoped to `mapper/` and always was — `app/` is an Electron project
  with an ordinary `node_modules`, and that is not a violation of it.
  ffmpeg is a prerequisite of `tools/make_clip.py` only.
- **`python3` is the Microsoft Store stub and will fail.** Use `python` or `py`.
  That, and the ffmpeg path below, are facts about the **Windows** machine. App
  work happens on the Mac, where `python3` is fine and ffmpeg is on `PATH`.
- **On macOS the oracle suite reports `(skipped=1)`** — the skip is
  `no powershell/pwsh on PATH`, which is expected there and not a defect. The
  `(skipped=1)` to worry about is the *mapper* suite's, below.
- **No pytest.** stdlib `unittest`.
- ffmpeg is installed but may not be on a shell's `PATH` if the shell predates
  the install:
  `C:\Users\USER\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin`.
  Without it `mapper/tests/test_make_clip.py`'s round-trip **skips silently** and
  the suite still reports OK — check for `(skipped=1)`.

## The verification bar

All of it runs off-hardware. Run all of it before claiming anything is done.

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
**Job:** 10 × 12 tiles of `8x8_4P` = **80 × 96 px**, same three controllers with
ports 4/4/2, but **5 packets per port instead of 2** — 50 packets and 23,290
bytes per frame. Every number for the job rig is derived from `mapper plan`;
none of it has been seen on hardware, and twelve tiles deep per chain is not
rehearsed by the shop rig. White frame and per-column walk before content.

Cabled left-to-right, monotonically. Sender NIC is `10.200.50.78/8`; dumpcap
interface number is **not stable across reboots** — re-derive with
`python -m tools.oracle.harness list-interfaces`.

- Connector 1 = ports 0, 1; connector 2 = ports 2, 3 for a `_4P` unit.
- Controller 1 (Master/IR) **times out ~5 s after packets stop** and reverts to
  local content; controllers 2 and 3 hold their last frame indefinitely. Not a
  defect. Expect it constantly when using `--forever`.
- Power down all three controllers before moving any data cable.
- **Never run Ledset and either sender at the same time.**

## Settled — do not reopen

- **Orientation is `identity`, permanently.** The floor is cabled left-to-right.
  `mapper/orientation.py` is *cabling compensation* — it exists to correct a
  mis-patched floor, applied at the wire-mapping stage. Do not add orientation
  features, and do not give `mapper/` a non-identity default.
- **The app's Rotation is not orientation, and the two must never be merged.**
  Setup's Rotation (0/90/180/270) is a *presentation* transform, so an operator
  can author a physically 80 × 96 portrait floor as a 96 × 80 landscape canvas.
  It lives in the app's final composite pass. `mapper/` still receives an
  80 × 96 row-major RGB framebuffer at every rotation, and needs **zero**
  changes. Conflating the two is how this becomes the seventh
  self-consistent-but-wrong result.
- **The macOS app is Electron + TypeScript + React driving `mapper/` as a
  sidecar**, decided 2026-08-11. Not SwiftUI, and **the mapper is not ported** —
  it is the only hardware-graded code in the repo. Read `docs/APP-PLAN.md`
  before writing app code; it holds the render pipeline, the geometry rules and
  the gates. It supersedes `README.md`'s old plan steps 4–6.
- **Composite at `floor_px × S`, downsample once at the end.** Floor resolution
  is an output format, never a project format, and layer transforms are stored
  normalised 0–1 however they are displayed. `docs/APP-PLAN.md` has the
  measurement this comes from.
- **Ledset is reference-only** since 2026-08-08. `mapper play` beat it on the
  wire: 80/80 frames exact with 0 tolerated defects, against Ledset's 68/72 with
  4. See `docs/RUNSHEET-10x5-4P.md` §11.
- **Frame rate, scaler and fit were decided at the floor**, not by reasoning.
  The floor drops no frames at 10/15/24/30/60 — 10 fps was never a ceiling, only
  the vendor's habit. `DEFAULT_FPS = 30`, `MAX_ADOPTED_FPS = 30` (60 renders
  faithfully and judders on fast motion for no gain). `play` reads the clip's own
  rate from `strh` and obeys it, capped; explicit `--fps` wins and is never
  capped. `--scaler area`, `--fit cover`.
- **`tools/Send-FloorTest.ps1` must not be modified.** Its entire value is being
  an *independent* second implementation of the wire protocol. If you invoke it,
  **`-PortsPerController 4` is mandatory** — its default of 8 silently
  miscomputes every controller boundary on this rig.
- The remaining `.ps1` files stay. Speculative ports were explicitly declined.
- `gradient24`'s red channel wraps once at tile index 37 and looks like a floor
  anomaly on hardware. It is not — `docs/RUNSHEET-10x5-4P.md` §10, V4 row.
- **Colour calibration was built, merged, and reverted in full on 2026-08-11.**
  Four tiles read orange at high white; the cause is a sagging 5 V rail on each
  tile's own buck converter, so the correction a gain would need is
  load-dependent and no per-region constant can track it. Do not re-add
  `mapper/calibration.py` or `tools/calibrate.py`. The defect, the exclusions
  and the fix ladder are in `docs/HARDWARE-TILE-DEFECT.md`.

## Traps

- **Most test patterns are the wrong size.** `01`–`08` including `08-sweep.avi`
  are **64×40**, authored for the old 8×5 rig, and `play` rejects them on this
  floor. Only `09-gradient24-8x8_4P-10x5.avi` and `10-sweep-8x8_4P-10x5.avi` are
  80×40.
- **`oracle.harness --live` only captures for a config row whose `capture` is
  `null`.** On a row that already has one it now refuses with exit 2 rather than
  silently re-grading the stored file. To measure a new sender, add a *new* row
  with a new name and a null capture — see `tools/oracle/configs.appendix.json`.
- **A clip sent at a rate it was not authored for plays at the wrong speed and
  no byte comparison in this project can see it** — every individual frame is
  correct and only the spacing between them is wrong.
- `max_tolerated` budgets are **measured per capture window and clip length**.
  Re-derive if either changes; a budget carried over from a different capture is
  exactly the unbounded tolerance the field exists to remove.
- **Stopping the send does not black the floor.** Controller 1 reverts to local
  content ~5 s later while 2 and 3 hold their last frame, so the app's BLACKOUT,
  cue gaps and idle must all send *black frames*. The socket opens with the show
  file and never closes.
- **`design/mockups.html` renders a superset of what ships.** Direction
  (Fwd/Rev/Bounce), Custom layout and Calibrate… all appear in it and are all
  shelved or scrapped. `docs/REQUIREMENTS-v1.pdf` wins over the mockups, and
  `docs/APP-PLAN.md` says what is cut and why.
- **A delegated builder's acceptance command needs one leg that fails when a
  dependency is absent.** PR 1's was `typecheck && test && build`, run in a
  sandbox without network where `npm install` silently no-op'd; the gate
  reported green over the whole half of the PR it existed to check. No single
  leg was buggy — externalising `electron` is correct for a bundler, a
  `@ts-ignore` on an unresolvable import is a normal local workaround, and unit
  tests not spawning processes is ordinary. The defect lived only in the
  conjunction, which is why reading any one file would not have shown it.
  `typecheck` does catch it today, but only because no `@ts-ignore` masks the
  import any more — one re-added comment and that is gone, so do not rely on it.
  `npm ls` is the cheap unconditional check and is **not** sufficient alone:
  `npm install` can report success while a large binary payload never arrives,
  and `npm ls` calls that healthy. Where the deliverable is a *process*, make
  something launch it. See **Delegating to Codex** below for the sandbox
  mechanism this happened through and the mitigations now in place.

## Delegating to Codex

Codex builder/critic pairs run through the `codex` plugin's
`codex-companion.mjs`, which starts every `--write` task in the Codex CLI's
`workspace-write` sandbox. That sandbox's network access is controlled
**only** by `[sandbox_workspace_write]` `network_access` in a
`.codex/config.toml` — never by anything in the task prompt, because the
sandbox is a process boundary the Codex CLI enforces, not something Codex is
told about. PR 1's `npm install` silently no-op'd for exactly this reason: the
sandbox had no network and nothing in the acceptance chain could see the gap.
The Traps entry above is the fix *around* that; this is the mechanism it was
never a fix *of*.

- **`network_access = true` is set in this repo's `.codex/config.toml`,
  scoped to `ddf` only** — not in `~/.codex/config.toml`, which would widen it
  to every trusted project on this machine. Decided 2026-08-12. It lets
  `npm install` run inside the sandbox, but it also means any future
  `--write` Codex run in this repo can reach the network for anything, not
  just installs. That is an accepted, scoped risk, not a non-issue — do not
  copy the setting into the global config without deciding that tradeoff
  again.
- **Network access does not remove the need to verify.** It fixes "can the
  sandbox reach npm," not "did the install actually finish." After every
  Codex builder run that touches dependencies, check `ls node_modules/<pkg>`
  (or run `npm ls`) yourself before trusting its acceptance report, and if the
  deliverable is a process, launch it. A green report is not proof.
- **Forbid `@ts-ignore` / `@ts-expect-error` on an import that will not
  resolve**, explicitly, in every builder prompt. That is the specific move
  that blinded `tsc` in PR 1, and it reads as a reasonable local workaround
  every time it happens.
- **The stop-time review gate is enabled** (`codex:setup
  --enable-review-gate`, toggled 2026-08-12). It reviews the *orchestrator's*
  own turn at Stop, not Codex's sandboxed run — it exists to catch the
  orchestrator accepting a Codex report too readily, not to catch Codex
  itself. `--disable-review-gate` turns it back off; its state is local to
  this machine's checkout path, not part of the repo.

## Git

Work lands via **pull request**, from 2026-08-08. The four merges already in
history predate that decision — do not copy their direct-merge style.

**Stop at the open PR. Merging is the user's call, every time**, from
2026-08-10. Open the PR, report its URL, and wait. An approved plan that lists
a merge step is not the approval — only the user saying so, for that PR, is.
This applies to agents and subagents alike; no subagent merges anything.

```bash
git checkout -b <branch>          # never commit on main
git push -u origin <branch>
gh pr create --fill
# then stop. `gh pr merge --merge --delete-branch` only after the user says so.
```

**Merge, never squash, never rebase.** This project's commit messages are the
primary record of *why* each decision was made and several are deliberately
longer than their diffs. Squashing destroys that.

Large media (`test-patterns/Test Clips/`, ~188 MB) and `tools/oracle/out/` are
gitignored. Captures and test-pattern AVIs under ~1 MB **are** tracked, on
purpose — they are evidence.

## Where the real documentation is

| Read | For |
|---|---|
| `docs/APP-PLAN.md` | **The app, and the canonical copy.** Stack, render pipeline, geometry rules, gates, build order, cut list. `docs/app-plan.html` is a dated snapshot of the same material and can lag it — where they differ, the `.md` wins. |
| `docs/REQUIREMENTS-v1.pdf` | Feature scope with the operator's annotations. Wins over the mockups. |
| `design/` | `mockups.html` is the visual spec — open it from disk, it loads `support.js` and `design-system/` from this repo. `design-system/` holds the tokens, the spec and 20 components as readable source. |
| `docs/PROTOCOL.md` | Wire format and mapping. §3–§4 are closed. |
| `docs/RUNSHEET-10x5-4P.md` | Floor-verified findings. §10 is the gate-4 tables, §11 the Phase 4 media session. Authoritative. |
| `mapper/README.md` | Module layout, how to run the suites, and the frame-rate/scaler/fit rationale. |
| `docs/PRE-PROBE.md` | §6 documents an instance of the failure mode above. |
| `docs/HARDWARE-TILE-DEFECT.md` | The orange-at-white tile defect: symptom, exclusions, vendor-stack sweep, the rail-droop hypothesis and its falsifying test, and why calibration was abandoned. §1–§3 are findings; §4 onward is unverified. |

Do not re-read the decompiled Ledset source under `decompiled/` unless something
specifically requires it; it is archaeology and it has misled this project before.
