# Measurements

Raw output from the `probe-*.mjs` instruments, kept because a measurement whose
output was thrown away is a claim rather than evidence. One file per run, named
for the instrument, the date and the corpus. Nothing here is a gate; nothing
runs these automatically and nothing should.

Each file's first lines record the exact command and the exit code, so a reader
can re-run it and compare rather than trust the transcript.

---

## `render-rate-pacing-2026-09-29-10x10` — the app path, per `mapper stream --pacing` mode

`app/test/e2e/probe-render-rate.mjs` at commit 8a59b1f (plus the per-arm
printing added later), `REPEATS=3`: modes `clock`, `precise`, `arrival` × 60,
30 and 24 fps sources × 3 repeats = 27 arms of 60 s, interleaved so machine
load lands on every mode alike. Renderer capped at 30 (as shipped). Exit 0,
every positive control passed, including the two new ones: 1b (each arm's
`mapper stream` names the arm's own pacing in its opening line — the argv is
not taken on trust) and 7 (a Python sender puts a known ±10 ms schedule on
the tap before any launch: 120/120 frames, 100 % of intervals within 2 ms of
the sender's, worst 0.33 ms, spread 10.71 ms). A WebKit process was at ~55 %
CPU when the run started; interleaving spreads it, it does not remove it.

Cadence errors — steps off each arm's ideal pattern, per run:

| source | clock (ships) | precise | arrival |
|---|---|---|---|
| 60 fps | 35.62, 24.30, 14.91 % | 18.40, 25.73, 13.60 % | 12.98, 18.11, 8.51 % |
| 30 fps | 21.21, 9.44, 20.43 % | 2.05, 6.93, 9.81 % | 9.43, 9.62, 7.34 % |
| 24 fps | 0.29, 2.40, 4.52 % | 3.76, 2.05, 4.99 % | 0.65, 0.65, 0.47 % |

Wire interval at 30-on-30, p99 / max per run: clock 40.53/80.25,
37.49/40.83, 41.88/59.64; precise 35.20/56.51, 35.46/57.08, 35.56/47.92;
arrival 35.08/112.97, 34.55/40.33, 36.04/44.41 ms.

### What the numbers say

- **Both candidates beat `clock`; neither reaches 0 %.**
- **`arrival` loses the run-to-run bimodality; `precise` keeps it.** At
  30-on-30 `precise` reads anywhere from 2.05 to 9.81 %, the shape the capped
  renderer had: it still has a tick, the renderer is on the display clock, and
  a run's result depends on where the two sat. `arrival` reads 7.34–9.62 %
  every time, and is best or tied in all six 60 and 24 fps runs.
- **The ~8 % left under `arrival` is upstream of the pipe — inferred.**
  `arrival` sends each renderer write once (wire 29.85–29.99 fps against ~30
  writes/s), so its wire is the renderer's output; its 30-on-30 errors are
  paired repeats and skips (78/80, 82/82, 62/63), a video frame composed twice
  and its successor never. In the stream probe, with no renderer, `arrival`
  is 0 %. That is handoff 1 (video to renderer), plan step 6's other half. Not
  measured at the renderer itself.
- **`arrival`'s longest gaps are longer**: 112.97 and 172.17 ms maxima, in
  runs whose renderer draw max was 49.8 and 165.3 ms. It forwards a renderer
  stall as a wire gap where `clock` fills it with a repeat. Still far under
  controller 1's ~5 s timeout, and `arrival` repeats after 1 s regardless.

### Decision (user, 2026-09-29)

Keep `arrival`, remove `precise`, in the same PR. `clock` stays the default
until a floor capture (D-02). `precise` can be re-run from commit dfa3af4.

### What this does not establish

- Anything on hardware. Loopback, one Mac, off-floor; the default changes only
  after a floor capture, by eye on a smooth pan (plan step 8).
- That handoff 1 is the whole residue — see the inferred bullet above.
- Three runs per cell. The spread claim is about three samples.

---

## `stream-pacing-2026-09-29` — `clock`, `precise` and `arrival`, `mapper stream` alone, by phase

`tools/probe_stream_cadence.py` at commit dfa3af4, defaults: 20 phases
(1.67 ms apart) × 3 senders × 3 repeats × 2 geometries, 10 s windows, plus the
24 Hz repeat/pause control and (for `arrival`) the 20 Hz ±12 ms jitter
control per repeat. Exit 0. Eight runs re-run after control 7 alone refused
(writer late 3–43 ms, listed in the file); control 10 compared sender and tap
on 384/384 runs.

Off-pattern steps at the 30 Hz writer, every non-zero run:

- **stock (`clock`)**: 10x10 14.0–62.2 % in 11 of the 12 runs at 26.67–31.67 ms
  (one 0 %), plus 0.7 % and 2.9 % once each; 10x12 17.0–54.6 % at
  28.33–31.67 ms, and in rep 2 from 23.33 ms, plus three runs under 7 %.
- **precise**: one run, 1.5 % (10x10, 16.67 ms). 10x12: none.
- **arrival**: one run, 0.4 % (10x12, 16.67 ms) — a single +2 step.

| | 10x10 stock | 10x10 precise | 10x10 arrival | 10x12 stock | 10x12 precise | 10x12 arrival |
|---|---|---|---|---|---|---|
| steps, all 30 Hz runs | +0 578, +1 15104, +2 572, +3 2 | +0 3, +1 16256, +4 1 | +1 16260 | +0 515, +1 15233, +2 513 | +1 16260 | +1 16258, +2 1 |
| wire p99, per run (ms) | 37.52–46.02 | 33.92–37.08 | 33.70–36.53 | 37.08–46.27 | 33.64–35.68 | 33.75–47.57 |
| wire max, per run (ms) | 38.07–97.14 | 34.08–118.89 | 33.88–52.41 | 37.39–64.49 | 33.85–37.68 | 33.94–66.72 |
| write end → wire, p50 / p99 (ms) | 20.01 / 36.88 | 19.94 / 36.33 | **3.72 / 9.07** | 19.71 / 36.88 | 20.18 / 36.74 | **4.06 / 23.53** |
| repeats: write in progress at wake / reader lag | 506 / 72 | 3 / 0 | 0 / 0 | 463 / 52 | 0 / 0 | 0 / 0 |

Controls: 24 Hz — metronomes 20.1 % repeats, mean step 0.799, 74–76 frames in
the 2.5 s pause; `arrival` 0.0 % repeats, 3 frames in the pause, longest
silence 1.01 s. Jitter control: wire p99 − p50 17.4, 20.1, 20.3 ms (≥ 8).

### What the numbers say

- **The stock repeat mechanism is now measured, not inferred.** Of the stock
  repeats the sender's own `--emit-timing` record could classify, 969 were a
  write still arriving when the sender woke and 124 reader lag. This settles
  step 5's open question in favour of the wake.
- **Both candidates remove it on this instrument.** `precise` narrows the band
  below the 1.67 ms phase step; `arrival` has no phase relation at all (its
  phase column jumps from −4 to +29 ms against its own lead-in and the error
  rate does not move).
- **`arrival` is ~16 ms fresher**: write end to wire p50 3.7–4.1 ms against
  ~20 ms for both metronomes.
- The stream probe cannot pick between them: its writer is on the sender's own
  clock. The app-path entry above does.

### The sweep before it refused, and why that was the instrument

`stream-pacing-2026-09-29-refused.txt`, commit 92d7c08, exit 2: one run of
384, 10x12 stock 24 Hz, control 9 "pause carried [240], not the last frame
241" — one of 76 pause frames. Reproduced 7 of 50 times at 10x12 24 Hz,
stock and precise, with the sender's stamps kept: each time the sender read
the slot 0.9–3.2 ms *before* the last write ended (240 was the newest it
had), and its first packet landed after, inside the pause window, because
`build_frame` takes a few ms at 10x12. Control 9 judged by arrival time. It
now excuses one such in-flight frame — first, `last − 1`, and read before the
slot held `last` by the sender's own record — and every other stale frame
still refuses (dfa3af4, checked with synthetic records). The sweep above never
used the excuse.

Seen there, inferred: the reader adopted that last write 1.4–3.3 ms after it
ended, lining up with a send starting — GIL contention with the sending
thread, most likely. The sweep's own reader-lag p99 is 3.45 ms (stock 10x10)
and 0.11–0.13 ms under `arrival`, which sends while the reader is idle.

### What this does not establish

- Anything about the app path or hardware — see the entry above.
- Loopback, one Mac, a writer on the sender's own clock.

---

## `stream-cadence-2026-09-28` — `mapper stream` alone, fed a steady 30 fps, by phase

`tools/probe_stream_cadence.py`. The first arm of attributing the app-path
judder below (D-03, reopened): Chromium removed entirely. A Python writer feeds
`mapper stream` numbered frames at 30 fps on the sender's own `perf_counter`
clock, so it holds one fixed phase against the sender's tick for a whole run;
a loopback tap reads every wire frame's number back. The probe fits the tick
grid from the sender's black lead-in, then sweeps the writer's phase across
the period: 10 phases × 3 reps × 2 geometries × 2 senders, 10 s each, plus a
24 fps control arm per rep. Exit 0, no run re-run.

Two senders, alternated at every phase. **stock** is `mapper stream` exactly as
the app runs it. **sliced** is the same code with one substitution made at
runtime, not in `mapper/`: `sender.run()`'s single `time.sleep` per tick
becomes 1 ms slices.

Off-pattern steps (anything but +1) as a share of steady steps, per rep:

| phase (ms) | 10×10 stock | 10×12 stock | 10×10 sliced | 10×12 sliced |
|---|---|---|---|---|
| 0.00–23.33 (8 phases) | 0 % in 23 of 24 runs; 10.3 % once (3.33) | 0 % in 23 of 24; 1.5 % once (23.33) | 0 % in all 24 | 0 % in all 24 |
| 26.67 | 49.8, 45.9, 43.9 % | 0.0, 45.2, 34.7 % | 0, 0, 0 % | 0, 0, 0 % |
| 30.00 | 28.8, 38.6, 34.2 % | 6.6, 41.3, 46.5 % | 0, 0, 0 % | 0, 0, 0 % |
| step histogram, 30 runs | +0: 343, +1: 7449, +2: 339 | +0: 239, +1: 7654, +2: 238 | +1: 8130 | +1: 8130 |
| wire interval sd | 2.23–4.78 ms | 2.24–4.35 ms | 0.26–0.67 ms | 0.49–1.11 ms |

24 fps control: 20.1 % repeats, mean step 0.799, in all twelve runs.

### What the numbers say

- **Handoff 2 alone is sufficient to cause the judder, at the app path's
  magnitude.** With no Chromium, no video and a writer that holds its phase to
  under 1 ms, stock `stream` goes 29–50 % off-pattern — the app path measured
  35–46 % — in 10 of the 12 runs whose write lands in the last ~7 ms before
  the tick, and is clean in 46 of the other 48. The errors come as paired +0/+2 steps: a frame shown
  twice, then its successor skipped.
- **How the sender sleeps is sufficient to cause it; late wakes are the
  leading mechanism.** The only
  difference between the arms is how `sender.run()` sleeps, and sliced is
  0.0 % in all 60 of its runs. MEASURED separately, same Mac: one ~33 ms
  `time.sleep` wakes 7–15 ms late (p50 6.7, max 15.5), because macOS grants
  timer leeway in proportion to the interval; 1 ms slices land p99 0.56 ms
  late. The inferred mechanism, not measured end to end: the late wake
  smears the tick — the wire-interval sd above — so a write near the
  adoption boundary is taken on this tick or the next at random. See the
  first bullet under "What this does not establish".
- **This is the shape the capped app runs had.** Run to run, the same phase
  reads 0 % or 45 % (10×12 at 26.67 and 30.00): the boundary itself moves
  between runs. A renderer on the display clock drifts slowly through every
  phase, so an app run's cadence depends on how long it spends in the bad
  band — the bimodal spread under `render-rate-2026-09-28-capped-10x10`.

### What this does not establish

- **That handoff 1 (video to renderer) is clean.** This shows handoff 2 is
  sufficient, not that it is the only cause on the app path. That half of
  plan step 5 is not measured.
- **That slicing is the fix.** Sliced narrows the boundary to below this
  sweep's 3.33 ms phase step; it does not remove it. A writer on another
  clock still crosses a narrower band, less often. Whether that is enough, or
  the sender must be paced from the writer, is step 6's question under D-02.
- **That the late wake is the only mechanism.** The arms differ only in how
  `sender.run()` sleeps, so the sleep is what matters; that it acts through
  wake jitter rather than, say, when the stdin reader thread gets to drain
  the pipe is inferred, not measured. The sweep does not record how long
  each pipe write blocked or when the reader adopted each frame. What bounds
  it: write-end to first wire arrival never exceeded 40.4 ms (about one
  period plus the send), so no frame sat unread for a whole tick; and in the
  control 7 diagnostic, at two of these configs, no pipe write took over
  0.15 ms. A per-frame adoption timestamp inside `stream` would settle it,
  and needs a `mapper/` change (D-02).
- Loopback, one Mac, a Python writer on the sender's own clock. The phase
  numbers are specific to this machine's send path; the sufficiency is not.

### Positive controls, and one that was changed after seeing data

Controls 0–7 are in the probe's docstring; any failure refuses (exit 2, no
table). Each was broken on purpose, 10×10, one phase, 4 s windows, and every
mutation refused with exit 2:

| mutation | caught by |
|---|---|
| decoder reads `k // 2` (control 0 disarmed) | control 5, mean step 0.494 of 1.000 |
| decoder stuck on one index (control 0 disarmed) | control 3, no wire frames in the window |
| decoder byte-swaps k | control 0 |
| decoder checks only the marker | control 0, flipped byte still decoded |
| repeat detector drops repeats | control 6 (0.0 %), also controls 4 and 5 |
| writer uses one plain `time.sleep` | control 7, p99 ~5 ms |
| sender dies at start-up (exit 3) | controls 2 and 1, with its stderr |
| sender killed mid-run | control 1, "write of frame 25 failed: Broken pipe" |

Two earlier full sweeps refused, and both are why the probe reads as it does:

- **Control 3 was wrong.** It required the exact frames at each end of the
  steady window to reach the wire; a sender that skips frames — the thing
  under test — skipped them, and four stock runs refused. The window now runs
  from the first frame at or after one bound to the last at or before the
  other.
- **Control 7 was changed after seeing data.** Each sweep refused on one or
  two of ~130 runs with writer jitter p99 3.4–7.6 ms, on the idle Mac. A
  diagnostic, 32 runs of 10 s: the writer loop alone and with the tap thread
  showed p99 0.31–0.34 ms and no write over 2 ms; inside the full probe, 2 of
  ~4,800 writes were late (3.5, 3.9 ms), each entirely in the wake from
  `time.sleep`, with the write before it taking under 0.2 ms. Not pipe
  backpressure, not the GIL: rare OS wake bursts. A run refused by control 7
  and nothing else is now re-run once, printed with the refusal it replaced,
  and discarded; a second failure refuses the sweep. Mutation-checked: a
  writer always late still refuses; one late on its first run only is re-run
  and passes; control 7 with any other failure is not re-run. The 2 ms bound
  did not move. This sweep needed no re-run.

---

## `render-rate-2026-09-28-capped-10x10` — the same probe, renderer capped to the send rate

The "after" half of the comparison below. `src/render/framePacing.ts` gates the
render loop so it composes no faster than `mapper stream` sends — 30 fps, one
constant shared with the sidecar's `--fps`. Three 60 s runs of the capped
build, against the two uncapped samples on disk (60 s and 30 s windows).

Cadence errors — steps off each arm's own ideal pattern, as a share of steady
steps. Lower is better; the ideal is 0 % in every arm.

| source | uncapped (2 runs) | capped (3 runs) |
|---|---|---|
| 60 fps | 73.03 %, 68.94 % | 32.04 %, 21.36 %, 26.83 % |
| 30 fps | 34.98 %, 45.61 % | 36.03 %, **0.23 %**, 5.52 % |
| 24 fps | 15.16 %, 13.18 % | 2.23 %, 2.76 %, 16.01 % |

| | uncapped | capped |
|---|---|---|
| composes/s | 54–56 | 29.8–30.1 |
| draw avg (ms) | 10.1–11.3 | 6.4–8.5 |

**Seven of the nine capped arm-runs beat every uncapped run of the same arm.
The other two do not: 30-on-30 run 1 (36.03 %) sits between the two uncapped
runs, and 24 fps run 3 (16.01 %) is worse than both.** That is not a
contradiction to explain away; it is the result's shape. Capped is bimodal where
uncapped is not. At 30-on-30, two of the three capped runs are nearly clean
(0.23 %, 5.52 %) and the third is as bad as uncapped. That is the shape two ~30 Hz clocks were predicted to have:
a renderer locked to vsync and a sender on its own metronome drift in and out
of phase slowly, so a run is clean while their phases are apart and judders
while they sit close together. Uncapped, the renderer composes at an irregular
~55 Hz, and no run is clean.

So the cap does not remove the judder. It changes it from constant to
intermittent and halves the compose load. Draw time per compose also fell
(about 10.5 to 7.5 ms), which is contention going away rather than work being
skipped — a skipped animation frame composes nothing and is not counted.

### What this does not establish

- **The judder that remains has a cause this change does not touch**: two
  clocks at the same nominal rate with no shared phase. Removing it means
  pacing the renderer from the sender's clock, or the sender from the
  renderer's. At the time of this run, `mapper/` was not allowed to change for
  the app; `docs/DECISIONS.md` D-02 now permits an opt-in, graded change to
  `mapper stream`, and D-03 records this measurement against the send clock.
  It is still a design question, not a follow-up commit.
- Nine arm-runs on one Mac. The bimodality means a single capped run can read
  anywhere from clean to as-bad-as-uncapped; that is the finding, not noise to
  average away.
- One capped run recorded a 74 ms wire interval and a 25.9 ms readback max in
  the same arm (run 1, 24 fps). The sender's metronome is `mapper`'s, so an
  interval that long is the whole process stalling, not the renderer. Not
  diagnosed; it did not recur in runs 2 and 3.
- Everything under **What they do not establish** for the uncapped baseline
  applies here unchanged: app path only, loopback, off-hardware, and nothing
  about `mapper play`.

---

## `render-rate-2026-09-28-baseline-10x10` — frame cadence on the wire, renderer uncapped

`app/test/e2e/probe-render-rate.mjs`. This is the **baseline for a proposed
30 fps render cap**. `App.tsx` composes and writes a frame on every
`requestAnimationFrame` (~60 Hz). The sidecar sends at 30 fps from a one-slot
mailbox, so about half of the composed frames are overwritten before they are
sent. The cap would halve compose cost. Its risk is two independent ~30 Hz
clocks beating against each other: repeat one frame, skip the next. No byte
comparison in this project can see that, because every frame on the wire is a
correct frame and only the spacing between them is wrong.

So the probe writes each source frame's index into the picture as whole
black/white tiles and generates the clips at probe time: 60, 30 and 24 fps
sources. The app plays each one through the real decode → compose → `writeFrame`
→ `mapper stream` path, with the geometry driven to `8x8_4P` 10 × 10 through
the Mapping UI. The probe reads UDP off loopback and decodes the index from
every wire frame, using `mapper`'s own `send_buffer_sources`. It sends nothing
over CDP during the 60 s window.

The step between consecutive wire frames is the cadence. At a 30 fps sender it
should be 2 for a 60 fps source, 1 for 30, and for 24 fps it should be 1 four
times in five and 0 once. A step outside that set is a **cadence error**. Each
one is a frame the operator sees held too long or skipped.

| source | wire fps | steps 0 / 1 / 2 / other | cadence errors | composes/s | draw avg/max ms |
|---|---|---|---|---|---|
| 60 fps | 30.00 | 292 / 459 / 459 / 492 | **73.03 %** | 53.92 | 11.28 / 111.50 |
| 30 fps | 30.00 | 324 / 1108 / 219 / 53 | **34.98 %** | 55.58 | 10.37 / 59.20 |
| 24 fps | 30.00 | 609 / 835 / 252 / 6 | **15.16 %** | 55.84 | 10.13 / 46.70 |

### What the numbers say

**The uncapped app path already shows heavy off-pattern cadence.** At 30 fps
source on the 30 fps sender, 34.98 % of steps in this run are a repeat or a
skip, where the ideal is none. The other two arms are worse in the same way:
the 60 fps source stepped anywhere from 0 to 7 frames, and once by 17. The
24 fps arm's repeats land anywhere from 1 to 8 steps apart, where the ideal
pulldown puts them 5 apart.

Nothing is lost overall. The mean step matches `source_fps / 30` to within
0.4 % in every arm, so the defect is spacing and not throughput. The renderer
composed 54–56 frames/s rather than 60, with draw averaging about 10–11 ms.
That matches the job's own heartbeat (`draw=13.01/45.40ms`), so the probe's
compose load is representative.

**The spread between runs is large.** A diagnostic run of the same instrument
read 53.20 % at 30-on-30. The copy that produced it differed only in the
repeat-share band, and it is deleted, so that number is a note and not
evidence. Both runs are far off pattern. How far is not a stable number, so
any comparison against a capped build needs several runs of each.

### What they do not establish

- **The cause is not diagnosed.** Irregular renderer timing is a hypothesis:
  55 composes/s rather than 60, and draw peaks of 47–112 ms. Nothing here tests
  it. The `<video>` element's own presentation timing, the IPC path and the
  pipe to the sidecar are equally unexamined.
- **This is the app path only**: off-hardware, one Mac (Intel i7-9750H,
  Electron 43.4.0), loopback UDP. It says **nothing about `mapper play`**,
  which reads frames from a file on its own metronome and was graded on the
  floor separately (`docs/RUNSHEET-10x5-4P.md` §11).
- **It does not by itself argue for or against the cap.** It is the "before"
  half of a comparison. The "after" half is the same probe against a capped
  build, run enough times to see past the spread above.

### Positive controls, and one that was changed after seeing data

Each of these refuses with no table and exit 2 if it fails:

- **0a.** Every generated clip decodes back to its own indices.
- **0b.** A known frame packetised by `mapper`'s own `build_frame` decodes
  correctly.
- **1.** Every heartbeat in the window reads `floor=8x8_4P 10x10`.
- **2.** At least 99 % of wire frames decode.
- **3.** The wire runs at 29–31 fps.
- **4.** Every arm's mean step is within ±2 % of `source_fps / 30`, which
  checks the time axis.
- **5.** At least 15 % of the 24 fps arm's steps are repeats, which proves the
  repeat detector can see a repeat.
- **6.** The page raised no exception and no Electron process survived.

**Control 5 first read "15–25 %", and the first real run refused on it at
28.2 %.** The 25 % ceiling was a guess and was never derived. It assumed the
uncapped pipeline puts a clean 1-in-5 pulldown on the wire. That made it a
measure of **cadence quality, which is the quantity under test**, not of
instrument health. The run it refused had a mean step of 0.800 exactly, and
every repeat above 20 % was paid back by a skip. That is a detector seeing
judder, not a blind one. So the ceiling came out, and the mean-step check went
in on every arm as control 4.

This is not a loosened gate. The replacement still refuses the failures the
band existed to catch, and both mutations were re-run against the committed
file:

```
every wire frame forced to one index   control 4 in all three arms: mean step 0.000     exit 2
two bit tiles swapped in decodeIndex   controls 0a + 0b, before any launch               exit 2
```

In the fixed-index mutation, control 5 passed, because 100 % repeats is
">= 15 %". A floor on repeats catches only a *blind* detector. One that sees
nothing but repeats is caught by the time axis, which is why control 4 went in
on every arm rather than only replacing the ceiling on one.

---

## `decoder-load-2026-09-19-*` — the decoder fan-out, measured, then bounded

`app/test/e2e/probe-decoder-load.mjs`. The first two runs are against the build
on `app-media-logging` (the heartbeat instrumentation from that branch is
present, but neither of those runs depends on it). The third is against the
same 71 clips on `app-media-fanout`, after `PlayScreen`'s two fan-outs were put
behind `app/src/player/taskPool.ts` — and after the probe itself gained a
fourth arm, for the reason set out under **The third column** below. The first
two files were written by the three-arm version; nothing in them was re-graded
or re-run.

The question: `PlayScreen` fans out `captureThumbnail` per cue and
`probeCueDuration` per added cue with **no concurrency limit**. Does that
actually break anything? The claim had been made and had no evidence channel
behind it; the probe is that channel.

**The first two runs disagree, and the disagreement is the result.**

| | dev corpus, 6 clips | job library, 71 clips | job library, **bounded** |
|---|---|---|---|
| serial arm (positive control) | 6/6 decode | **71/71 decode** | 71/71 decode |
| concurrent arm | 6/6 decode | **71/71 decode** | 71/71 decode |
| app path — durations | 6/6 | **71/71** | 71/71 |
| app path — **thumbnails** | 6/6 | **6 of 71** | **71/71**, 3.4 s |
| decoder census `peak` | not read | **142** | **8** |
| exit | 0 | **1** | 0 |

`65 of 71 thumbnails never arrived — the fan-out lost decoders`

Read that table carefully, because the interesting part is which rows are clean.
Every clip decodes, serially **and** concurrently. The media is fine, the codecs
are fine, and the instrument is sound — the serial arm is the positive control
and it passed. What fails is the app's own fan-out, at a library size the
6-clip dev corpus cannot reach.

This is why the run was pointed at the job's own media. The dev corpus returns a
clean result at every width the app can produce, and a 2026-08-15 run of the
same probe recorded `24/24 thumbnails` — so the ceiling sits somewhere between
24 and 71 cues and is invisible below it. A measurement taken on the dev corpus
would have re-confirmed a null result on a population that never exhibited the
failure.

**Thumbnails failed and durations did not.** That asymmetry is why the probe
grades them as two channels rather than one: `PlayScreen` swallows a thumbnail
rejection into a blank square (`.catch(() => {})`) and a duration rejection into
`mediaDurationMs: null`, an em dash in the inspector. Grading either one alone
would have passed a run in which the other lost every probe.

The asymmetry has since been measured rather than reasoned about, on the same
page and the same 71 files, by running the two shapes back to back at full
width:

| arm, 71 concurrent | landed | ms min / median / max |
|---|---|---|
| poll `video.duration` — what the duration probe needs | 71/71 | 201 / 212 / 407 |
| seek + `drawImage` — what the thumbnail needs | 71/71 | 218 / **3972** / 4032 |

Neither arm loses anything. They differ by a factor of nearly twenty in **how
long each one takes when seventy of its peers are asking at the same time**. A
duration needs the container's metadata and no video decoder, so seventy-one of
them are genuinely parallel. A thumbnail needs a decoded frame, and Chromium
serialises those behind a finite decoder pool — so the seek+draw at the back of
the queue waits about four seconds for a decoder while its own 5 s deadline,
which started when the fan-out created it, runs down. In the app, with the
duration fan-out, 71 `toDataURL` calls and 71 React renders on the same main
thread, 65 of 71 crossed it. The failure was never "this clip will not decode";
it was "this clip was still waiting its turn when the caller gave up".

This is why the fix is a concurrency limit and not a longer deadline. A longer
deadline would have hidden the same queue behind a longer wait.

### What this does and does not establish

It establishes that the unbounded fan-out is a **real, operator-visible defect**:
add a folder of ordinary size and 92 % of the cue rows come up blank.

It does **not** establish that the fan-out causes the job's Class B failures.
The signature here is a lost thumbnail and, in the synthetic load walk, a
`TIMEOUT` — not the `PIPELINE_ERROR_DECODE` the job logged 116 times. Those may
share a cause and may not. Treating this as a Class B diagnosis would be
adopting a conclusion the measurement does not carry.

### Caveats that belong with the numbers

- **The load walk at 142 / 284 / 568 decoders is synthetic and is reported, not
  graded.** It is far past anything the app does; `0/N decode` there describes a
  machine pushed well past its ceiling, not a defect on its own.
- The `banner:` line in both files is
  `floor NIC 10.200.50.78 is no longer assigned to any interface`, which is this
  Mac lacking the floor NIC. Environmental, not a probe result.
- Off-hardware, one machine, one Electron build, one run each — two for the
  bounded run, and its header says how they differed. An Electron upgrade can
  move every number.

### The third column

The bounded run is the same instrument, unmodified, so the two job-library
files are a before/after pair rather than two different measurements. The
`peak` row is not from this instrument at all: it is the app's own decoder
census, read out of `~/Library/Logs/Electron/ddf.log` from a separate launch
with `DDF_HEARTBEAT_SECONDS=5` and the same 71 cues added. `opened` was 142 in
both, so the fan-out still does all of its work — it just stops doing all of it
at once.

**The first mutation-check came back green, and that is why the probe changed.**
With the concurrency limit taken back out and nothing else touched, the
three-arm probe printed 71/71 thumbnails and exited 0 anyway.

The three outcome arms count a race. `captureThumbnail` carries a 5 s deadline
that starts when the fan-out creates it, and whether a queued decoder beats it
depends on the OS page cache. The 6/71 in the pre-fix file was a cold library;
four later runs of unbounded builds in the same session read 43, 43, 63 and 71
out of 71 once all 71 files were cached, against 71, 71, 71 for three bounded
runs. Nothing on this machine can make the library cold again without a
privileged purge. **A gate that passes over a build with the fix removed is a
green gate over a broken thing**, so the probe was given a fourth arm that does
not depend on timing: the high-water mark of the app's own decoder census, read
back out of the heartbeat. It is graded without naming any limit — `peak` must
come in under the number of cues added, which no per-cue fan-out can manage —
and only at 32 cues or more, below which 2N is too small for the check to
distinguish anything and the run says so instead of passing.

Re-run against that version, the mutation-check is red:

```
limit in place    census: peak=8     ... exit 0
limit removed     census: peak=142   ... exit 1
  - the window held 142 decoders open at once for 71 cues — that is a
    fan-out with no limit on it, whatever the thumbnail count above says
```

The removed-limit run printed `71/71 cue rows show a thumbnail` on its way to
failing, which is the case for arm 4 in one line. The bound is additionally
graded off-hardware by `app/test/taskPool.test.ts`, 5 of whose 7 cases go red
when the limit is removed — that is the part that needs no 71-clip library.

What the third column does **not** establish is any change to the job's Class B
failures. It grades one operator-visible consequence — cue rows that came up
blank when a library was added — and the signature it moved is a lost
thumbnail, not the `PIPELINE_ERROR_DECODE` the job logged 116 times. The
caveat in the section above stands unchanged.
