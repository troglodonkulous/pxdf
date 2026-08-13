# Tile-walk timing sheet

Floor: 8 x 5 tiles (64 x 40 px), 2.0s per position.

Times are from the START OF THE VIDEO, not the start of the capture.
Note when playback begins, then add these offsets.

| # | tile (col,row) | starts at | ends at |
|---|---|---|---|
| 0 | (black lead-in) | 0.0s | 2.0s |
| 1 | (0,0) | 2.0s | 4.0s |
| 2 | (1,0) | 4.0s | 6.0s |
| 3 | (2,0) | 6.0s | 8.0s |
| 4 | (3,0) | 8.0s | 10.0s |
| 5 | (0,1) | 10.0s | 12.0s |
| 6 | (0,2) | 12.0s | 14.0s |
| 7 | (0,3) | 14.0s | 16.0s |
| 8 | (0,4) | 16.0s | 18.0s |
| 9 | (7,0) | 18.0s | 20.0s |
| 10 | (7,4) | 20.0s | 22.0s |
| 11 | (4,2) | 22.0s | 24.0s |

---

## The 2026-08-06 capture only reaches row 8

`captures/07-tilewalk.pcapng` is **truncated**. It holds 238 complete frames over
a 25.879 s span: a 102-frame black lead-in, then rows 1-7 at 18-19 frames each,
then row 8 `(0,4)` for **7 frames**, and the capture ends. There is no successor
position — the capture stops ~0.65 s *into* row 8, at video time ~16.7 s of 24.
(An earlier revision of this file said rows 1-8 were complete and the cut fell in
row 8's successor. That was wrong; `docs/CAPTURE_RESULTS.md` had it right.)

**Rows 9, 10 and 11 were never transmitted to the wire.** They are exactly the
positions that would resolve tile columns 7 and 4 on their own, so with this
capture alone those columns — and 5 and 6 — are constrained only as a *set*, by
`06-halves`. See `docs/CAPTURE_RESULTS.md` § "What remains".

Recapturing this video to completion is the cheapest way to close that gap: the
asset already contains the missing positions. **No code change is needed when
that capture lands.** `EXPECTED_WALK` in `mapper/tests/test_oracle_capture.py`
is no longer typed — it is read out of `07-tilewalk.avi` by `mapper/avi.py`, and
the capture is asserted to be a *prefix* of it. A complete capture simply makes
the prefix 11 long instead of 8.

This sheet was **generated** by `tools/make_test_patterns.py` from the same
`positions` list that rendered the video, so it is a description of the asset,
not independent evidence about it. Nothing in the test suite reads this file.
That generator was deleted on 2026-08-13 with the retired 64 × 40 pattern set,
so this sheet is now a frozen record rather than a regenerable one — which
changes nothing about what it is worth, since it never was evidence. What
grades `07-tilewalk.avi` is `mapper/tests/test_oracle_capture.py`, from the
file itself.
