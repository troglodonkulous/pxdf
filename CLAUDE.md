# ddf — working notes for Claude Code

A geometry-independent sender for a Symphonia LED dance floor, replacing the
vendor's Ledset software. This file holds the things a session cannot derive
from the code and would otherwise rediscover expensively — or get wrong.

## The one thing to internalise

**This project has produced six self-consistent-but-wrong conclusions.** The
"512-byte packet", "byte 4 always 0x00", frame counts low by one across all six
captures, fps wrong in both directions, an oracle classifier that passed a
genuinely wrong mapping by laundering it as a vendor defect, and
`oracle.harness --live` silently grading a stored capture while a live send was
on the wire.

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
  ffmpeg is a prerequisite of `tools/make_clip.py` only.
- **`python3` is the Microsoft Store stub and will fail.** Use `python` or `py`.
- **No pytest.** stdlib `unittest`.
- ffmpeg is installed but may not be on a shell's `PATH` if the shell predates
  the install:
  `C:\Users\USER\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin`.
  Without it `mapper/tests/test_make_clip.py`'s round-trip **skips silently** and
  the suite still reports OK — check for `(skipped=1)`.

## The verification bar

All of it runs off-hardware. Run all of it before claiming anything is done.

```bash
python -m unittest discover -t . -s mapper/tests        # 155 tests, ~20 s
python -m unittest discover -t . -s tools/oracle/tests  # 39 tests
python -m mapper matrix                                 # 2400 configs
python -m tools.oracle.harness run --configs tools/oracle/configs.acceptance.json
python -m tools.oracle.harness run --configs tools/oracle/configs.appendix.json

# the cutover's whole grade — these two must print the same digest
python -m mapper play test-patterns/09-gradient24-8x8_4P-10x5.avi \
    --type 8x8_4P --cols 10 --rows 5 --dry-run | tail -1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 --dry-run | tail -1
#   -> 10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057
```

## The rig

10 × 5 tiles of `8x8_4P` = 80 × 40 px on **three** controllers. Cabled
left-to-right, monotonically. Sender NIC is `10.200.50.78/8`; dumpcap interface
number is **not stable across reboots** — re-derive with
`python -m tools.oracle.harness list-interfaces`.

- Connector 1 = ports 0, 1; connector 2 = ports 2, 3 for a `_4P` unit.
- Controller 1 (Master/IR) **times out ~5 s after packets stop** and reverts to
  local content; controllers 2 and 3 hold their last frame indefinitely. Not a
  defect. Expect it constantly when using `--forever`.
- Power down all three controllers before moving any data cable.
- **Never run Ledset and either sender at the same time.**

## Settled — do not reopen

- **Orientation is `identity`, permanently.** The floor is cabled left-to-right.
  Any content-side flip happens at media-authoring time. Do not add orientation
  features.
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
- **Colour calibration is opt-in and off by default.** `--calibration FILE` on
  `play`/`send`; with no flag the wire is unchanged byte for byte. Region
  coordinates are **pre-orientation** logical framebuffer pixels, and a saved
  file is tied to a physical arrangement — move a tile and it is silently wrong,
  visible only on near-white content. It masks a tile hardware defect and
  measures nothing. `docs/CALIBRATION.md`.
- `max_tolerated` budgets are **measured per capture window and clip length**.
  Re-derive if either changes; a budget carried over from a different capture is
  exactly the unbounded tolerance the field exists to remove.

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
| `docs/PROTOCOL.md` | Wire format and mapping. §3–§4 are closed. |
| `docs/RUNSHEET-10x5-4P.md` | Floor-verified findings. §10 is the gate-4 tables, §11 the Phase 4 media session. Authoritative. |
| `mapper/README.md` | Module layout, how to run the suites, and the frame-rate/scaler/fit rationale. |
| `docs/PRE-PROBE.md` | §6 documents an instance of the failure mode above. |

Do not re-read the decompiled Ledset source under `decompiled/` unless something
specifically requires it; it is archaeology and it has misled this project before.
