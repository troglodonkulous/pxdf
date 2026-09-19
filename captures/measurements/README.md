# Measurements

Raw output from the `probe-*.mjs` instruments, kept because a measurement whose
output was thrown away is a claim rather than evidence. One file per run, named
for the instrument, the date and the corpus. Nothing here is a gate; nothing
runs these automatically and nothing should.

Each file's first lines record the exact command and the exit code, so a reader
can re-run it and compare rather than trust the transcript.

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
