# Decisions

Every standing decision in this project, with what it protects, what it rests
on, and what would reopen it. `CLAUDE.md` carries a one-line index of this file
so a session sees every rule at start; this file is the only full copy.

## Why this file exists

This project's failure mode, in `CLAUDE.md`'s words, is "conclusions that
survive their own disproof, because the disproof had nowhere to go". Until
2026-09-28 the rules were the worst case of it. They sat in a section headed
"Settled — do not reopen", as bare prohibitions: none said what it protected or
what evidence would make it wrong. So when evidence arrived it had nowhere to
land.

It happened with the send clock. A cadence probe found repeat-and-skip judder
on the wire (`captures/measurements/README.md`, render-rate sections), and the
fix was parked behind "`mapper/` does not change to accommodate the app", a rule
whose reason no longer applied. A second rule, "core PRs stay draft until
floor-tested", kept `main` six weeks behind while the only real show ran from an
unmerged branch; it lived in one machine's private memory, where no other agent
could see it, and is replaced by the release flow in its own PR.

## How an entry works

```
### D-nn — the rule, in one line
Protects:  what breaks if this is violated — the operator-visible consequence
Evidence:  floor YYYY-MM-DD <cite> | off-hardware <cite> | reasoning only
Reopen if: a concrete observation that would make this wrong
```

- **`Evidence: reasoning only` is not a weaker form of proof.** It says no
  measurement stands behind the rule. It must never be quietly upgraded; an
  entry moves to `off-hardware` or `floor` only by citing the file that shows it.
- **When evidence contradicts an entry, add a `Challenged by:` line** citing it.
  If the evidence meets the entry's own `Reopen if`, the heading also gains
  **(reopened)**. Either way the entry stays in force until a PR resolves it, so
  a challenge is recorded rather than acted on silently.
- **A few entries are conventions, not findings**, and nothing observable should
  undo them. They say `Reopen if: not reopenable — <why>`, so the exception is
  written down rather than hidden behind a trigger that can never fire.
- **Entries are never deleted.** A superseded entry keeps its text, gains
  `Superseded by D-nn` with the date, and its heading is struck through.
- **Changing an entry is a PR the user merges**, like any other change here.
- **Reopening is not breaking.** A change that contradicts an entry states the
  entry's number and argues from its `Reopen if` line, in the PR.

Facts about the hardware (cabling, controller modes, safety) are not decisions
and stay in `CLAUDE.md` § The rig. Traps (things that fail silently) stay in
`CLAUDE.md` § Traps and `docs/APP-PLAN.md`.

---

## The wire and the sender

### D-01 — The wire encoding, and the byte output of `play` and `send`, are frozen
Protects: the only wire encoder this project has graded on hardware. `mapper
play` matched 80/80 frames exactly where Ledset managed 68/72.
Evidence: floor 2026-08-08, `docs/RUNSHEET-10x5-4P.md` §11 P4-7. Pinned
byte-exact off-hardware by the digests in `CLAUDE.md` § The verification bar:
the 10 × 5 digest is the floor-graded one; the 10 × 12 digest is a
self-derived regression pin for a geometry never run on hardware.
Reopen if: a controller renders a frame this encoding produced wrongly, or a
new tile type needs a packet layout the encoder cannot express.

Scope: `build_frame`, packetisation and the EOF flag, and what `play` and `send`
put on the wire. Any change here must leave both digests unchanged. If one
must move, the 10 × 5 digest is re-derived against a floor capture, and the
10 × 12 pin is re-derived only after that and says so. This entry replaces the
broader "nothing in `mapper/` may change to accommodate the app"; see D-02.

### D-02 — `mapper stream` may change for the app, opt-in, graded before it becomes the default
Protects: the app's ability to fix what only the handoff between app and sender
can fix — cadence, above all — without putting D-01 at risk.
Evidence: reasoning only. The old blanket rule ("nothing in `mapper/` may
change to accommodate the app", stated in `mapper/cli.py` and
`app/electron/sidecar.ts`; `docs/APP-PLAN.md` § The integration seam said
"Nothing existing is edited") dates from 2026-08-11, before the app existed.
Its reason, protecting the graded encoder, is what D-01 now protects directly.
Reopen if: a problem at the app–sender boundary is shown to be unfixable inside
`stream` alone — then D-01 or D-04 is what reopens.

A change to `stream`'s timing or handoff ships behind a flag with the current
behaviour as the default. It is graded by the digests (bytes) and by a cadence
instrument with a positive control (`app/test/e2e/probe-render-rate.mjs`, or a
successor). It becomes the default only after a floor capture. Digests certify
bytes, not timing, so they are necessary and never sufficient here.
Status 2026-09-29: the first such change exists — `mapper stream --pacing
{clock,arrival}`, default `clock`, graded by both digests (unchanged) and by
`tools/probe_stream_cadence.py` and `probe-render-rate.mjs` with positive
controls (`captures/measurements/README.md`, stream-pacing-2026-09-29). The
floor capture that would make `arrival` the default has not happened.

### D-03 — Python owns the send clock (reopened)
Protects: steady packet pacing. `sender.run()` sends from a one-slot
`LatestFrame` on its own metronome, so a renderer hitch costs a repeated frame,
never a gap.
Evidence: off-hardware, `docs/RUNSHEET-10x5-4P.md` §11: "Sender pacing is
clean in absolute terms but not as a share of a frame" — stdev ~0.4 ms, but a
~1.3 ms worst case that is 7.8 % of a frame at 60 fps.
Reopen if: content cadence on the wire is measured off-pattern.
Challenged by: `captures/measurements/README.md`, render-rate-2026-09-28. On
the app path at 30-on-30, 35–46 % of wire frames repeat or skip with the
renderer uncapped (~55 Hz), and 0.2–36 % with it capped to 30. **The cause is
not diagnosed**; two unsynchronised ~30 Hz clocks is the leading hypothesis, and
the video-to-renderer handoff is not yet ruled out. What is established is
that the rule graded packet pacing, an internal symptom, while the operator
sees content cadence. Unresolved; attribution and any pacing change follow D-02.
Challenged by: `captures/measurements/README.md`, stream-cadence-2026-09-28.
`mapper stream` alone, fed a steady 30 fps with no Chromium, goes 29–50 %
off-pattern when the write lands in the last ~7 ms before its tick, and is
clean at other phases. The same code with `sender.run()`'s single
`time.sleep` replaced by 1 ms slices is 0.0 % at every phase. So how the send
clock sleeps is sufficient to cause the judder, with its late wakes (7–15 ms
on macOS) the leading mechanism, not yet isolated from stdin-reader timing; the video-to-renderer handoff is still unmeasured. Any change to how
`stream` sleeps or paces is step 6 of the plan, under D-02.
Challenged by: `captures/measurements/README.md`, stream-pacing-2026-09-29
and render-rate-pacing-2026-09-29-10x10. The mechanism is now measured: of
the stock repeats the sender's own timing classifies, 969 were a write still
arriving when the sender woke and 124 reader lag. `mapper stream --pacing
arrival` — send each new frame as it lands, no faster than `--fps`, repeat
after 1 s of silence — is 0 % off-pattern at every phase alone, and on the app
path cuts 30-on-30 cadence errors from 9.4–21.2 % to 7.3–9.6 %, without the
run-to-run bimodality; the residue is inferred to be the video-to-renderer
handoff, since `arrival` forwards each renderer write once. Under `arrival`
the renderer owns the clock and Python keeps only a ceiling and a liveness
repeat. It is opt-in (`PXDF_STREAM_PACING=arrival`); `clock` stays the default
until a floor capture (D-02). A second candidate, the same tick slept to in
1 ms slices (`precise`), was built, graded and removed: still bimodal on the
app path (2.1–9.8 %).
Challenged by: `captures/measurements/README.md`,
render-rate-video-frames-2026-09-29. The residue under `arrival` is now
measured at the renderer, not inferred: on main its compose errors track the
wire's run for run, as paired repeats and skips. It was also not steady —
more runs of the same build read 0.82–8.23 %. The fix is in the renderer, not
Python: `VideoSource` keeps a `requestVideoFrameCallback` armed for the
element's life instead of stopping at ready, which on this Electron evens out
how Chromium hands a detached element its frames. `arrival` at 30-on-30 went
from 2.53–4.59 % to 0.00–0.59 % (three final runs; the 0.59 % is a ~100 ms
renderer stall, skips only), 60 fps to 0.00 %, 24 fps to 0.00–0.18 %.
Composing on the callback (gating on `presentedFrames`) was built too and
measured no better; removed. `clock` stays the default until a floor capture
(D-02); its wire is still bimodal (0.00–46.48 %) because the metronome is.

### D-04 — Do not port the mapper to TypeScript or Swift (a preference)
Protects: D-01's graded encoder from a rewrite's regressions.
Evidence: reasoning only (`docs/APP-PLAN.md` § The decision, item 1). Its
original second reason, that a port "buys nothing", is no longer true: a port
would remove a process, a pipe, the packaged Python dependency and the
sidecar-death handling. The digests would grade a port byte for byte.
Reopen if: the sidecar boundary blocks a fix that an opt-in `stream` change
under D-02 cannot deliver, or packaging Python becomes a recurring show risk.

### D-05 — `mapper/` uses the Python standard library only
Protects: a sender that runs on any machine with Python and nothing installed.
Evidence: reasoning only. The rule is scoped to `mapper/`; `app/` is an ordinary
Node project. ffmpeg is a prerequisite of `tools/make_clip.py` alone.
Reopen if: a needed capability has no reasonable standard-library route.

### D-06 — `tools/Send-FloorTest.ps1` is never modified
Protects: an independent second implementation of the wire protocol, which is
its whole value as a cross-check of D-01.
Evidence: reasoning only (`docs/RUNSHEET-10x5-4P.md:84-88`). Invoking it needs
`-PortsPerController 4`; its default of 8 silently miscomputes every controller
boundary on this rig.
Reopen if: the protocol changes (then it is replaced, not edited).

The remaining `.ps1` files stay; speculative ports of them were declined.

### D-07 — The status pill reports what the sender process does, never the floor
Protects: the operator from a green light that means nothing. The pill reads
`sending`, `restarting` or `stopped`. `mapper` only broadcasts UDP and never
receives, so no acknowledgement from the floor exists to read. (The sidecar
does capture `mapper`'s stdout, but that is the sender describing itself, not
the floor answering. `CLAUDE.md` said stdout was ignored until 2026-09-28; the
spawn at `app/electron/sidecar.ts` pipes it.)
Evidence: reasoning only. No reachability probe (ping, ARP) is built: whether
these controllers answer one is unverified, and a probe that goes quiet would
cry wolf.
Reopen if: a hardware session shows the controllers answer a probe reliably. A
probe could then prove reachability, still never displayed pixels, and would be
a separate indicator.

## Rate, resolution and fit

### D-08 — Frame rate, scaler and fit are decided at the floor, not by reasoning
Protects: choices that only a person looking at the floor can grade.
Evidence: floor 2026-08-08, `docs/RUNSHEET-10x5-4P.md` §11 P4-1 to P4-6. No
dropped frames at 10, 15, 24, 30 or 60 fps — 10 fps was never a ceiling, only
the vendor's habit; `DEFAULT_FPS = 30`; `--scaler area`; `--fit cover`.
Reopen if: a different floor or content type is judged by eye and disagrees.

### D-09 — `MAX_ADOPTED_FPS = 30`
Protects: fast hard-edged motion. At 60 the floor renders every frame but
judders on fast hard-edged motion, with no smoothness gain over 30.
Evidence: floor 2026-08-08, P4-3, measured through `mapper play` from a file,
not through the app pipeline. The runsheet (§11) names two candidate causes and
separates neither: the sender's ~1.3 ms worst-case pacing jitter (7.8 % of a
frame at 60), and a beat against the panels' own refresh.
Reopen if: either cause is removed or ruled out and 60 is judged again, or the
app's cadence work changes what 60 looks like.

`play` reads a clip's own rate from its `strh` header and adopts it, up to this
cap; an explicit `--fps` always wins and is never capped.

### D-10 — Composite at `floor_px × S` and downsample once at the end; S defaults to 8
Protects: sub-pixel motion and edges. A floor-resolution render aliases every
edge. Floor resolution is an output format, never a project format; layer
transforms are stored normalised 0–1.
Evidence: off-hardware, via `tools/make_clip.py --scaler area`, not via the app
(`docs/APP-PLAN.md` § The render pipeline). That measurement favoured 16×; the
default of 8 is **provisional** — `docs/APP-PLAN.md` calls it "settled at the
shop against real clips", and no record of that shop session exists. Cost
scales as S² (APP-PLAN, same section); on the app path the draw costs ~10 ms
per compose against ~1.7 ms of readback at S = 8
(`captures/measurements/README.md`, render-rate).
Reopen if: S = 4 is judged indistinguishable at the floor, or compose cost is
shown to limit cadence.

## The app

### D-11 — The app is Electron + TypeScript + React, driving `mapper/` as a sidecar
Protects: a UI built from the working mockups and native Canvas2D, with the
graded sender untouched (D-01).
Evidence: reasoning 2026-08-11, then floor: the 2026-09-05/06 show ran on it for
eight hours (`docs/JOBS.md`).
Reopen if: Electron itself blocks a show requirement, such as Syphon/NDI or
unattended soak.

This superseded the Swift plan and steps 4–6 of the old plan in `README.md`.
`docs/APP-PLAN.md` holds the render pipeline, geometry rules and gates; read it
before writing app code.

### D-12 — Rotation is a presentation transform, not orientation, and the two never merge
Protects: `mapper/` from needing any change for rotation. The operator can
author a physically portrait floor on a landscape canvas; `mapper` still
receives the floor's own row-major framebuffer at every rotation.
Rotation lives in the app's final composite pass.
Evidence: reasoning only (`docs/APP-PLAN.md` § Rotation is not orientation).
Reopen if: not reopenable — conflating the two is a pre-written postmortem.

### D-13 — Orientation is `identity`, permanently
Protects: a correct floor. The floor is cabled left to right, monotonically, as
a fixed convention; `orientation.py` is cabling compensation for a mis-patched
floor, applied at wire mapping.
Evidence: floor 2026-08-08. `docs/PROTOCOL.md` §8, Q1: logical (0,0) is
physical (P1, R1), no rotation or mirror, derived with
`docs/RUNSHEET-10x5-4P.md` §5's method against the M0 walk and confirmed by V3.
Reopen if: not reopenable — the cabling convention is fixed. A mis-patched floor
is corrected with `orientation.py`'s parameters for that session; never give
`mapper/` a non-identity default or add orientation features.

### D-14 — The mapping diagram is jack-level at every type
Protects: an operator counting cables. A controller has 4 physical jacks, each
carrying 2 ports (2 adjacent tile columns), so a 10-column `8x8_4P` rig is 5
cables, not 10.
Evidence: decided 2026-08-13 from the floor's gate-4 findings,
`docs/PROTOCOL.md` §1 gate 4, and the cable trace at
`docs/RUNSHEET-10x5-4P.md:1546-1560`. Ledset draws `_4P` port-wise and is wrong
on this; do not "fix" it back toward the vendor's drawing. Port-to-column stays 1:1 in
`mapper/`; the jack layer lives only in the app diagram.
Reopen if: a controller model with a different jack-to-port wiring is used.

### D-15 — The surface is called Mapping, never Setup
Protects: one name for one surface — the name the operator and the mockups
use. The old plan's "Setup" was a second name for the same thing.
Evidence: decided 2026-08-12; the mockups and the operator both say Mapping.
The same day, PR 3 `app-mapping` was inserted before the compositor; the build
order in `docs/APP-PLAN.md` records that sequence.
Reopen if: the operator starts calling it something else.

### D-16 — Ledset is reference-only
Protects: the show from the vendor's loop-boundary blanks and tears.
Evidence: floor 2026-08-08, P4-7: `play` 80/80 exact with 0 tolerated defects,
against Ledset's 68/72 with 4.
Reopen if: a floor capability exists only in Ledset.

Never run Ledset and either sender at the same time.

### D-17 — Colour calibration stays out
Protects: against a correction that cannot work. Four tiles read orange at
high white, and a gain correction would have to track a load-dependent error
that no per-region constant can.
Evidence: floor 2026-08-10/11 for the fault itself: it travels with the tile
(`docs/HARDWARE-TILE-DEFECT.md` §1–§3). The mechanism — a sagging 5 V rail on
each tile's own converter — is reasoning only (§5, "Proposed mechanism"; §4
onward is unverified). Why the software fix was abandoned is §9. Built, merged,
and reverted in full on 2026-08-11.
Reopen if: the tiles' power is fixed and a residual, load-independent colour
error remains. Do not re-add `mapper/calibration.py` or `tools/calibrate.py`
before then.

## How work lands

### D-18 — The user merges every PR, with a merge commit
Protects: the user's control over what reaches `main`, and commit messages as
the primary record of why each decision was made (squashing destroys them).
Evidence: decided 2026-08-08 (PRs) and 2026-08-10 (the user merges).
Reopen if: the user says so.

No agent or subagent merges anything. An approved plan that lists a merge step
is not approval for that merge.

### D-19 — A booking's details are never facts about this project
Protects: `CLAUDE.md` from going stale silently. "The job is 10 × 12" sat there
for a month; the only show that has run was 10 × 10.
Evidence: `docs/JOBS.md`, 2026-09-18.
Reopen if: not reopenable — a booking is true for one show. Per-show records
live in `docs/JOBS.md`, dated and closed.

### D-20 — Merge on the off-hardware bar; the floor certifies a tag, and shows run a tag
Protects: two things the old rule traded against each other. `main` stays
current, so work is not stacked for weeks. And a show runs code that the floor
has tested and that the log can name.
Evidence: the rule it replaces failed on both counts. "Core PRs stay draft
until floor-tested", kept in one machine's private memory, left `main` six weeks
and 86 commits behind, while the 2026-09-05/06 show ran from an unmerged branch
whose exact commit and tree state were never recorded (`docs/JOBS.md`).
Reopen if: a merged-but-untested change reaches a show, or `main` again falls
weeks behind open work.

- A PR merges when reviewer findings are resolved and the off-hardware bar
  passes. The user still approves every merge (D-18); nothing is held in draft
  waiting for hardware.
- After a floor session passes, the user tags the tested commit
  `floor-YYYY-MM-DD` (annotated). `git log floor-<latest>..main` is what the
  floor still owes a test.
- A show runs `npm run dist` from a `floor-` tag. `dist` refuses a tree with
  uncommitted changes under `app/` or `mapper/` (`app/scripts/releaseTree.mjs`);
  `PXDF_ALLOW_DIRTY=1` overrides, and such a build logs a WARN at every launch.
  The launch line's `build:` field goes into the show's `docs/JOBS.md` record.
- A failed floor session means fix forward or revert. The previous `floor-` tag
  is still there to run.
