# Postmortems — conclusions that survived their own disproof

Every entry below is a wrong conclusion this project held, acted on, and
published. They are not ten separate lessons. They are one mechanism, ten times:

> **In every case the conclusion was contradicted by something the system
> already knew, and that contradiction had no path to a place where anyone
> would see it.**

The captures held the 458-byte packets. The classifier held the disproof of the
mapping fault and emitted it under a different label. The stored capture's
timestamp was on disk. `node_modules` was empty. The `SecurityError` was raised
sixty times a second. None of it reached a reader. That is the whole failure
mode, and every fix that has ever worked here was **adding a channel for bad
news** — see `CLAUDE.md`, "Channels for bad news", which is the actionable form
of this document.

**Ordinals are retired.** These used to be cited as "the fifth", "the seventh",
"the eighth"; the numbering drifted across `ORACLE_HARNESS.md`, `RUNSHEET`,
`APP-PLAN.md` and `CLAUDE.md` until no two agreed, which is its own small
instance of the same thing. Cite by name.

Each entry is: what was concluded, what already contradicted it, why the
contradiction had nowhere to go, and the channel that now carries it.

---

## 512-byte packet

**Concluded** (`WINDOWS_BRIEF.md` line 20, 2026-08-05): a frame packet is 512
bytes, a 5-byte header plus a 507-byte body.

**Disproof already in hand:** the captures. Half of every frame is 458 bytes —
507 body except on each port's last packet, where it is 453.

**Why it had nowhere to go:** the analysis filtered packets on length 512. The
disproving packets were discarded before anything read them, so the surviving
sample agreed with the claim perfectly. A self-consistent sample is what a
sampling bias produces, not what a correct model produces.

**Channel:** `PROTOCOL.md` §"claims retired" states the retraction next to the
claim. `mapper/README.md` line 141 — fixtures now deliberately carry *both*
lengths, so a length-filtering regression fails a test rather than producing a
tidy answer.

---

## Byte 4 always `0x00`

**Concluded** (same brief, same day): header byte 4 is a constant `0x00`.

**Disproof already in hand:** the same captures. Byte 4 is the packet index
within the port, with bit 7 (`0x80`) set on the final packet of a frame — the
end-of-frame flag that latches the frame.

**Why it had nowhere to go:** the *same* length-512 filter. Byte 4 reads `0x00`
only on the 512-byte packets, which are exactly the ones a length-512 filter
keeps. One instrument defect authored two independent-looking findings, and
their agreement read as corroboration.

**Channel:** as above. The general form is worth stating: **two findings from
one instrument are one finding.** They cannot corroborate each other.

---

## Frame counts low by one

**Concluded** (2026-08-06): 45 / 45 / 43 / 45 / 237 / 49 frames across the six
captures. Corrected 2026-08-07 to 46 / 46 / 44 / 46 / 238 / 50.

**Disproof already in hand:** `20-ours-white.pcapng` has no trailing orphan
packet — our sender stopped cleanly on a frame boundary — and was still
reported one short. A capture-edge artifact cannot explain that row.

**Why it had nowhere to go:** the day's counting method counted frame
*transitions*, of which there are n − 1. Nothing tied the frame count back to
the packet total, so the error was invisible in every individual number and
only visible in arithmetic nobody ran.

**Channel:** counts come from `mapper/pcapng.py::split_frames`, and
`CAPTURE_RESULTS.md` line 33 now writes the closing arithmetic down —
46 × 16 + 1 = 737, 44 × 16 + 1 = 705, 238 × 16 + 1 = 3809, 50 × 16 = 800 — so
the check is re-runnable by hand. It also states the inverse: if you re-derive
the old numbers, you have reintroduced the off-by-one, and the code has not
regressed.

---

## fps wrong in both directions

**Concluded** (2026-08-06): Ledset runs at ~9.35 fps (~107 ms), our sender at a
clean 10.0 fps.

**Disproof already in hand:** no capture has a mean interval as low as 107 ms.
Re-measured over all five Ledset captures, the mean interval between frame
starts is 108.7–109.3 ms — ~9.2 fps, the extra ~9 ms being uncompensated
capture-and-map time against `Thread.Sleep(100)`. Ours averaged 97.6 ms
(10.24 fps) but ranged 34–126 ms. **Ledset is the steadier of the two.**

**Why it had nowhere to go:** both numbers came from the same day's tooling as
the n − 1 frame counts above. One broken instrument produced a wrong figure in
each direction, and neither was ever compared against raw packet timestamps.
The two errors pointing opposite ways is what made the pair look measured
rather than assumed.

**Channel:** `CAPTURE_RESULTS.md` line 160 keeps the retracted paragraph
visible in parentheses rather than silently replacing it, so the shape of the
error stays legible.

---

## The classifier launders a mapping fault

**Concluded** (`ORACLE_HARNESS.md` §8.1): the acceptance bar is "zero
*unexplained* rows, not zero diffs", implemented as a per-frame `_classify`
whose torn-frame arm was:

```python
if 0 < len(bad) < len(observed):
    return "torn-frame"
```

**Disproof already in hand:** inside the classifier itself. No bound on how
many packets, no bound on bytes within them, no contiguity requirement, no
relation to neighbouring frames. The complement was the whole story: the only
frame that could reach `unexplained` was one with a header mismatch, or one
where *every* packet's body was wrong and not all-zero. **A mapping fault that
spares even one packet was, by construction, indistinguishable from a
documented vendor defect.**

**Why it had nowhere to go:** the disproof came out of the instrument wearing
the label `torn-frame`. Injecting a real fault — swapping the tile column that
ports 3 and 4 read, headers left correct — produced 46 of 46 frames classified
`torn-frame` and `unexp = 0`. Implementing the documented criterion literally
would have printed `PASS ... 0 matched, 46 tolerated`. The only thing that
stopped it was an undocumented, untested `and matched > 0` in the source, and
that guard held only because a systematic fault corrupts *every* frame — true
only by accident of the acceptance media.

**Channel:** the injected fault is now a **positive control** in the suite. The
grader has to fail on a fault it is supposed to catch before any of its passes
mean anything.

---

## `--live` grades a stored capture

**Concluded** (2026-08-08, mid-session, `RUNSHEET-10x5-4P.md` §11): an ordinary
`PASS` from `oracle.harness --live`, reported while `mapper play` was actually
on the wire.

**Disproof already in hand:** the capture file's modification timestamp. The
numbers it printed were Ledset's gate-2 results, down to the loop-boundary
blank at frame 32 — a fingerprint of a *different run*, sitting in the output.

**Why it had nowhere to go:** `--live` opens a capture window only for a row
whose `capture` is `null`. On a row that already had one it fell through and
re-graded the stored file, and nothing in the path read the timestamp, the row
name, or the fact that a send was in progress. **Silence was indistinguishable
from success:** not capturing looked exactly like capturing.

**Channel:** it now refuses with exit 2 and names the fix. To measure a new
sender, add a *new* row with a new name and a null capture — see
`tools/oracle/configs.appendix.json`.

---

## Width/height stands in for floor type

**Concluded** (`PRE-PROBE.md` §6): `width=20ft height=10ft controllers=3`, read
back from Ledset, confirms the floor is `8x8_4P`.

**Disproof already in hand:** `mapper/floors.py`'s own comment. Ledset's feet
are `(index + 1) * 2` — a vendor bug that assumes every tile is 2 ft regardless
of the floor type's real pitch. That makes width/height a readout of
`tile_cols`/`tile_rows` **alone**, with zero dependence on `tile_px`. A
`6x6_4P` floor at the same 10 × 5 tile grid produces the identical three
numbers.

**Why it had nowhere to go:** the three numbers were standing in for
`cbo_Type`, which could not be read at the time (a closed combo box has zero
`Text` descendants until its popup has opened once). The substitute was never
checked for whether it *could* distinguish the two cases — only for whether it
agreed.

**Channel:** the geometry is now confirmed by two genuinely independent
readings, and §6 keeps the wrong reasoning struck rather than deleted. The
stronger reading is the capture: a wrong floor type yields a different packet
plan entirely — different packet count, lengths and byte-4 sequence — and it
never goes through the feet dropdowns at all.

---

## Green gate over an uninstalled dependency

**Concluded** (2026-08-12, PR 1): acceptance passed —
`typecheck && test && build`, all green.

**Disproof already in hand:** `node_modules` was empty. The Codex builder ran
in the CLI's `workspace-write` sandbox with no network, so `npm install`
silently no-op'd.

**Why it had nowhere to go:** **no single leg was buggy.** Externalising
`electron` is correct for the bundler. `@ts-ignore` on an unresolvable import
is a normal local workaround. Unit tests that spawn no process are ordinary.
The defect lived only in the *conjunction* — no leg of the chain would fail on
the dependency's absence — which is why reading any one file would not show it.
The gate reported green over exactly the half of the PR it existed to check.

**Channel:** `npm ls` **and** `npx electron --version` in the verification bar
(`npm install` can report success while a large binary payload never arrives,
and `npm ls` calls that healthy). `network_access = true` in this repo's
`.codex/config.toml`. Every builder prompt forbids `@ts-ignore` on an
unresolvable import. Where the deliverable is a *process*, something must
launch it. See `DELEGATION.md`.

---

## The `SecurityError` storm

**Concluded** (2026-08-12, PR 2, two at once): the wire gate reports "12/12
pass", and the app has a multi-second cue delay to diagnose.

**Disproof already in hand:** a `SecurityError` thrown sixty times a second.

**Why it had nowhere to go — this is the purest instance in the file.**
`ddf-media://` is cross-origin to the page however the page is served, so
without CORS-mode fetch the decoded video tainted the work canvas and
`getImageData` threw on every frame from the moment the first cue went live.
The throw landed mid-loop, so `writeFrame`, the preview paint, and the
`setStats` / `setSnapshot` publish below it were all skipped. The floor went
black. The cue stack froze mid-change. **Nothing anywhere reported an error**,
and the engine was correct the entire time. The "multi-second cue delay" was
never real — it was this, measured through an app the bug had already broken.

The gate's own "12/12" was a second instance stacked on the first: the DOM
assertion did a single unretried read against a React view that republishes on
a ≥250 ms tick, while the packet check exits the instant the first matching
packet lands. It failed about one run in two. **The gate was flaking, not the
app.**

**Channel:** composition never throws — it returns black and marks the source
failed (`player/compose.ts`), and the render loop writes exactly one frame per
animation frame on every path. The check that actually grades taint reads the
**error banner**, because that is the operator-visible consequence; the
"no uncaught exceptions" check was disarmed by the very fix that made
composition non-throwing, and only a mutation-check caught that. `wire.mjs`
asserts on the wire, then confirms in the DOM with a bounded poll. Full detail
in `APP-PLAN.md`.

---

## Container blacklist from belief

**Concluded** (2026-08-12): a list of media containers the picker must reject.

**This one is the most instructive, because it was self-inflicted while
producing the evidence for the fix to the previous one**, by someone who had
read the warning at the top of `CLAUDE.md` that morning.

**Disproof already in hand:** Chromium's behaviour, measurable in ten seconds.
The list was wrong on two of seven entries — `mkv` decodes fine, because
Chromium's WebM demuxer *is* a Matroska demuxer; and `ogv` fails for a
different reason than listed, its container opening cleanly with only the
Theora codec missing.

**Why it had nowhere to go:** the list was written from belief rather than
measurement, and a passing unit test over the wrong constant laminated the
belief in place. A test over a constant grades the constant against itself.

**Then the probe built to settle it empirically reproduced the whole pattern
four more times:**

1. The `evaluate()` helper never checked `exceptionDetails`, so a page-side
   throw returned `undefined` and the run continued as though it had answered.
2. It clicked "Add cue" before React had mounted — the same polling race
   `wire.mjs` already documents. The click threw, was swallowed, `allowedMedia`
   stayed empty, and every file 403'd. **A 403 body reaches the demuxer as
   `DEMUXER_ERROR_COULD_NOT_OPEN` — the identical string a genuinely
   unsupported container produces.** The result was a table that was plausible,
   internally consistent, uniformly formatted, and entirely false.
3. After the list and the measurement table were corrected, the prose paragraph
   that had argued for the *old* list was left in place, so the file asserted
   "none of those four decode" three lines above a table saying `mkv` decodes.
   **The correction did not propagate through the document.**
4. The probe printed `probe failed:` and exited 0, so `probe && next-thing`
   would sail straight past a failed positive control.
5. `node_modules/.bin/electron` is a Node shim that spawns the real binary as
   its own child, so `kill()` killed the shim and orphaned Electron, which kept
   debug port 9334 and hijacked the *next* run — a corruption that damages the
   following measurement, not the one that emits it.

**Channel — note the shape of what finally caught it: a positive control.**
`mp4` must decode. If it does not, the instrument is broken and **no table is
printed at all**. Without that, a uniformly-failing result is
indistinguishable from a finding. The probe lives at
`app/test/e2e/probe-containers.mjs` and `app/src/player/mediaFormats.ts` cites
it by path, because a measurement whose instrument was thrown away is a claim,
not evidence.
