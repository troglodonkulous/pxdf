# Jobs

A dated record of specific shows: the geometry each one actually ran, what it
was cabled into, and what it taught. One section per job, newest first.

**Nothing here belongs in `CLAUDE.md`.** That file is for facts a session cannot
derive from the code and would get wrong or re-discover expensively — facts that
stay true. A booking's tile count is true for one night. When a job's geometry
sat in `CLAUDE.md` it went stale immediately and silently: it described the
floor as 10 × 12 for a month, and the only job that has ever run was 10 × 10.
Nothing contradicted it, because the number was never compared against anything.
That is this project's own failure mode with the notes as the subject.

So: job specifics live here, dated and closed. A permanent conclusion drawn
*from* a job is the thing that graduates to `CLAUDE.md`, and it graduates as the
conclusion, not as the booking.

**Every record carries a `build` row, copied from the show log's launch line**
(`build: <git describe>`). A show runs a packaged build of a `floor-` tag
(`docs/DECISIONS.md` D-20), so that string names a commit. If it ends in
`-dirty` or reads `unknown`, the record says so plainly: that show's code
cannot be reconstructed.

---

## 2026-09-05/06 — first real job

The app's first show. It succeeded; neither the client nor the room noticed a
problem. The operator worked around a steady stream of playback failures all
night, which is what the media-failure work exists to remove.

**Geometry actually run: 10 × 10 tiles of `8x8_4P` = 80 × 80 px.**

Not 10 × 12. All 483 heartbeats in the log report `floor=8x8_4P 10x10`, and the
sidecar was spawned at `--cols 10 --rows 10` ten times over the night. The one
`--rows 5` spawn is the app's compile-time default at launch, replaced seven
seconds later when the show file loaded. If you need a second geometry to reason
about, this is the one that has been on hardware.

| | |
|---|---|
| floor | `8x8_4P`, 10 × 10 tiles, 80 × 80 px |
| controllers | three |
| sender NIC | `10.200.50.78` |
| sender rate | `mapper stream --fps 30` |
| build | unpackaged, from `/Users/USER/dev/ddf`, on `app-media-content-length`. **Commit not recorded, and whether the working tree was clean is unknown.** The branch tip was `d10a575`, tagged `show-2026-09-05` after the fact; that is the best available answer, not a record |
| ran | 2026-09-06T00:01:59Z → 08:06:59Z (UTC; the venue evening of 09-05) |

**The log is tracked** at `captures/ddf-job-2026-09-05T23-2026-09-06T08.log`,
under the same convention as `captures/*.pcapng`: the artefact a claim was
measured from stays in the repo. It is the evidence base for the whole media
investigation and it was one relaunch from being destroyed when it was copied in
— launch rotates `ddf.log` to `ddf.prev.log`, so two restarts overwrite it.

What the night recorded:

- **483 heartbeats**, 00:03 → 08:06, median interval 60.04 s, exactly one
  excursion (99.2 s at 02:35). Silence in that file therefore means quiet rather
  than dead, which is what makes every other number in it readable.
- **221 player errors in two unrelated classes with zero clip overlap** — 105
  `DEMUXER_ERROR_COULD_NOT_OPEN` across 7 clips, 116 `PIPELINE_ERROR_DECODE`
  across 38. Operator-visible live-cue failure rate 46 of 320 attempts.
- **Three NIC dropouts** (02:35, 03:52, 08:06 teardown), all auto-recovered in
  ~2 s. The retry ladder worked.
- **The 02:35 watchdog alarm was correct**, despite reading like a false
  positive. Heartbeat cadence settles it: that interval was 99.2 s against a
  60.04 s median, the only such excursion all night, so the main process was
  blocked ~39 s and no frames reached the floor.
- **The renderer ran at 60 fps and the sender consumed 30**, so every second
  composed frame was overwritten in `LatestFrame` before it was ever sent.

Media came from six folders under `~/Downloads`, not one: `ddf_content/Pixel
Dance Floor`, `ddf_content/LED Pixel Floor Operator's Picks`, `ddf_content/Operator
Transfers`, `CLIP_ddf`, `CLIP_ddf_more` and `Archive`. Any analysis that reasons
about "the job's library" has to say which of those it covered — the first pass
at the `moov` correlation looked at one folder and would have missed an eighth
`moov=END` file sitting in another.

---

## 10 × 12 / 80 × 96 — planned, never run

Derived 2026-08-11 from `mapper plan`, for a job at that depth: same three
controllers, ports 4/4/2, **5 packets per port instead of 2** — 50 packets,
23,290 bytes on the wire per frame (23,040 of pixels plus per-packet headers).

**No part of it has been seen on hardware**, and twelve tiles deep per chain is
not rehearsed by the shop rig. It is a paper geometry and should be described as
one. It is kept because it is still the deepest configuration the mapper is
graded against, not because a show is booked at it.

It survives in two places on purpose, and both are about geometry independence
rather than about a booking:

- `app/src/render/geometry.ts` exports it as `JOB_RIG`, and
  `app/test/gate.digest.test.ts` grades the one-pass against it —
  `12df0afcfb2c05be3b967822ae965dc251578b27f4813d372447c3d09d59352d`, from
  `python -m mapper send --type 8x8_4P --cols 10 --rows 12 --pattern gradient24
  --dry-run`. Re-derive rather than trusting that line if `mapper/` changes.
- `CLAUDE.md`'s verification bar runs the same digest, as the second of two
  geometries. A sender that is geometry-independent has to prove it at more than
  one shape, and a second shape that differs from the shop rig in tile *depth*
  is the one that would catch a packets-per-port assumption.

The name `JOB_RIG` is now misleading — it is not the job's rig, and the job's
real rig was 10 × 10. Renaming it to something that describes the shape rather
than a booking (`DEEP_RIG`, or naming it by its dimensions) is worth doing the
next time that file is open; it is a test-fixture rename touching
`geometry.ts` and three test files.
