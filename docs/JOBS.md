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

## 2026-11-20 — second job

The app's second show, and the first since decode-error recovery became the
open problem. **It ran 3 h 41 min in its final session with no player error of
any kind and no live cue lost.** The operator: "not a single dropout or
playback failure", against September's steady workaround. The night's one
outage was the network, not playback: see *18:21* below.

**Geometry actually run: 8 × 8 tiles of `8x8_4P` = 64 × 64 px, two
controllers.** Every heartbeat from 16:21 onward reports `floor=8x8_4P 8x8`. It
is a third shape, and the first job on two controllers, not three.

| | |
|---|---|
| floor | `8x8_4P`, 8 × 8 tiles, 64 × 64 px, 32 packets/frame, 12,448 bytes/frame |
| controllers | two |
| sender NIC | `en7` = `192.168.1.100`, by DHCP from a router at `192.168.1.1` — not the shop's static `10.200.50.78`. A job fact; `CLAUDE.md`'s shop NIC is unchanged |
| sender rate | `mapper stream --fps 30`, pacing `clock` (the default) |
| build | `floor-2026-11-20` = `a3ca5f5`, clean. **Unpackaged** (`npm run dev:floor`, `packaged=false`), an explicit exception to D-20, taken for time. Sessions 1–2 log the same commit as `show-2026-09-05-55-ga3ca5f5`: the `floor-` tag was created between session 2's launch and session 3's, so `git describe` changed and the code did not |
| ran | three launches, 2026-11-21T00:15:36Z → 06:05:58Z (UTC; the venue evening of 11-20, 16:15 → 22:05 PST). Doors about 18:00 PST |

**The logs are tracked**, one per launch, because each launch rotated the last:

| session | file | span (PST) | what it was |
|---|---|---|---|
| 1 | `captures/floor-2026-11-20-main-a.log` | 16:15–16:20 | qualification start. Ended without `app quitting` or the quit black frame: the app and the `dev:floor` terminal were closed in some order. The operator judged it minor |
| 2 | `captures/floor-2026-11-20-main-b.log` | 16:21–18:24 | qualification and doors, to the NIC loss. Clean quit |
| 3 | `captures/floor-2026-11-20-show.log` | 18:24–22:05 | the show. Clean quit (`app quitting`, then the black frame) |

Graded with `grade_floor_log.py --nic 192.168.1.100`. That grader is not in
this repo yet, so the numbers below are re-derivable from the logs by `grep`,
which is the standard they are held to.

What the night recorded:

- **Zero player errors in all three sessions, about 350 minutes of app time.**
  No `PIPELINE_ERROR_DECODE`, no `DEMUXER_ERROR_COULD_NOT_OPEN`. September
  raised 116 and 105 over 485 minutes. This is the baseline the decode-recovery
  branch must not regress, and it is not evidence that recovery is unneeded:
  September's decode errors had no recipe, and one quiet night does not
  produce one.
- **Session 3: 221 heartbeats, intervals 60.0–61.0 s**, every one
  `status=sending renderer=live`. 105 promotions to live across 77 distinct
  clips; 2,049 decoders opened, peak 10 at once.
- **840 `buffering (waiting)` WARN lines in session 3**, 24 in session 2. The
  most on one clip was 34 (`Color Blinking Grid Floor`). Not a fault: no live
  stop follows any of them. But the line does not say whether the waiting
  element was live or preview, so the log cannot say whether any were visible.
  Watch item.
- **Frame rate, session 3: median 28.5 fps, seven minutes under 80 % of 30**
  (lowest 20.3, 18:28). They cluster in fast cue changes, mostly HEVC clips
  from 19:36 to 19:57. **They are not explained.** The first of them, at 18:28,
  had `ORANGE5` live, which probes as 768² H.264, so it is not the 2160²
  cause below. Per-frame `draw` max reached 447.9 ms at 18:26. Nothing was
  visible at the floor.
- **Frame rate, session 2: 43 minutes under 80 % between 16:23 and 17:10**
  (lowest 16.7 fps). **This one is explained**: it is the still images
  converted to 2160 × 2160 H.264. With `WHITE_1` live, 16:30–16:37, `draw`
  averaged 50–53 ms against about 9 ms on 768² content — about 17 fps. The
  conversion script was the cause; it now writes 768² H.264. The show did not
  use those clips.
- **Startup.** Each launch spawned the sidecar at the app's compile-time
  default (`10 × 5`), then `8 × 5`, then `8 × 8` as the show file loaded,
  within about 30 s. Session 3 first bound `en0` (Wi-Fi, `192.168.32.138`),
  because `en7` had no lease yet. The lease arrived at 18:24:36, and the
  sidecar was re-pointed at 18:24:39.

**18:21 — the floor NIC lost its address, and the floor had no content from the app for about
three minutes.** During doors.

- **18:21:31.** `en7`'s `192.168.1.100` disappeared. The sidecar died with
  `[Errno 49] Can't assign requested address`, and the retry ladder ran four
  spawns in 1.2 s.
- **18:21:33.** The NIC watch logged `floor NIC 192.168.1.100 is no longer
  assigned to any interface — check the cable` and suspended the sender. This
  is the designed behaviour: loud, and not a respawn loop.
- **18:21:51.** `en7` was back up but only with `169.254.169.142`, a
  self-assigned address. The link had returned; the router's DHCP had not
  answered yet.
- **18:23:43.** The sender was re-pointed at `en0`, Wi-Fi. Status read
  `sending` from then on. Per D-07 the status reports the process, not the
  floor, so it was true and reached nothing.
- **18:24:07.** The app was quit. It was relaunched at 18:24:17. `en7` got its
  lease at 18:24:36, and the floor was back on 18:24:48 at 8 × 8.

The cause of the drop is not in the log: cable, adapter, switch or router. The
log cannot say what the floor showed in those three minutes either. Stopping
the send does not black it, and the controllers' mode was not recorded. What
the log can say is that the alarm was correct and immediate. Recovery waited on
the router's DHCP, not on the app. The app re-arms the sidecar when the bound
address returns (`electron/nicWatch.ts`), so it would have resumed by itself
at 18:24:36 without the relaunch.

Two things for the next job with a DHCP floor network:

- A static address, or a DHCP reservation, removes the wait for a lease.
- A NIC picker that offers Wi-Fi offers a sender that cannot reach the floor
  and reports `sending`.

Media came from five folders under `~/Downloads`. 72 of the 105 promotions
came from `ddf_content/LED Pixel Floor Operator's Picks`. The rest came from
`ddf_content/Pixel Dance Floor` (26), `ddf_content/Operator Transfers` (4),
the stills-converted folder (2) and `CLIP_ddf_more` (1). Folder names that
carry a person's or client's name are written here by role.

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
