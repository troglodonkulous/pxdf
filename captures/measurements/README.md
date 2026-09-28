# Measurements

Raw output from the `probe-*.mjs` instruments, kept because a measurement whose
output was thrown away is a claim rather than evidence. One file per run, named
for the instrument, the date and the corpus. Nothing here is a gate; nothing
runs these automatically and nothing should.

Each file's first lines record the exact command and the exit code, so a reader
can re-run it and compare rather than trust the transcript.

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
