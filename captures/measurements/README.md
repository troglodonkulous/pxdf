# Measurements

Raw output from the `probe-*.mjs` instruments, kept because a measurement whose
output was thrown away is a claim rather than evidence. One file per run, named
for the instrument, the date and the corpus. Nothing here is a gate; nothing
runs these automatically and nothing should.

Each file's first lines record the exact command and the exit code, so a reader
can re-run it and compare rather than trust the transcript.

---

## `decoder-load-2026-09-19-*` — the decoder fan-out, measured twice

`app/test/e2e/probe-decoder-load.mjs`, against the build on `app-media-logging`
(the heartbeat instrumentation from that branch is present, but nothing in these
two runs depends on it).

The question: `PlayScreen` fans out `captureThumbnail` per cue and
`probeCueDuration` per added cue with **no concurrency limit**. Does that
actually break anything? The claim had been made and had no evidence channel
behind it; the probe is that channel.

**The two runs disagree, and the disagreement is the result.**

| | dev corpus, 6 clips | job library, 71 clips |
|---|---|---|
| serial arm (positive control) | 6/6 decode | **71/71 decode** |
| concurrent arm | 6/6 decode | **71/71 decode** |
| app path — durations | 6/6 | **71/71** |
| app path — **thumbnails** | 6/6 | **6 of 71** |
| exit | 0 | **1** |

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
- Off-hardware, one machine, one Electron build, one run each. An Electron
  upgrade can move every number.
