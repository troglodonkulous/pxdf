# Oracle harness — `tools/oracle/`

**Bar:** a config list goes in, a pass/fail diff table comes out, unattended.

For each `(floorType, cols, rows)` config, the harness decodes what was
captured on the wire and diffs it against what `mapper/` predicts, then
emits one row: config, packets expected, frames matched/tolerated/unexplained,
first divergence (controller/port/packetIndex/byte offset), pass/fail.
Machine-readable JSON comes out alongside the table, for the orchestrator's
progress page.

This document covers: the control path, the capture recipe, how to run it,
what it cannot yet do, and exactly what remains blocked on the attended
Player-page session. Read `mapper/README.md` first if you haven't — this
harness reuses `mapper/` end to end and does not reimplement any of it.

---

## 1. Architecture — reuse, not a second decoder

```
tools/oracle/
  config_list.py     one config -> an OracleConfig (geometry, pattern, orientation, capture path)
  decode_diff.py      decode + diff one config, reusing mapper.pcapng / mapper.verify
  report.py           ConfigResult list -> text table + JSON
  capture.py           dumpcap start/stop, two modes (duration-based, and start/stop)
  harness.py            CLI: `python -m tools.oracle.harness run [--live]`
  __main__.py            `python -m tools.oracle ...` entry point
  configs.dryrun.json      default config list -- captures/*.pcapng, no hardware
  configs.acceptance.json   the list for the attended session (every capture is null today)
  verify-xml-control-path.ps1   live control-path verification (built, not run this session -- S3)
  make-gradient-avi.ps1          renders mapper.patterns.gradient24 as a Ledset-loadable AVI
  media/09-gradient24-8x8_4P-10x5.avi   the rendered file, verified to decode via VideoGrabber.dll
  tests/                     unit tests, stdlib unittest, 33 tests
```

Nothing here reimplements the protocol. `decode_diff.py` calls
`mapper.pcapng.read_udp` / `split_frames` to parse a capture, and
`mapper.verify.compare_frame` for the byte-level diff -- both used exactly as
`mapper/` exports them. What this package adds on top:

- maps a mismatch's packet ordinal back to `(controller, port, packetIndex,
  byte4)` via `build_plan()`, instead of leaving it as a bare index;
- classifies an unmatched frame against the two Ledset playback defects
  `docs/CAPTURE_RESULTS.md` documents (loop-boundary all-black frame; torn
  frame from the vendor's unlocked send thread). A header mismatch is never
  classified as either defect, since a real mapping bug is free to break
  headers and neither vendor defect is;
- **checks those defect labels against the rest of the capture.** A per-frame
  classifier cannot tell a vendor tear from a mapping fault, because the
  difference between them is not visible in one frame: a tear is a timing
  accident and lands somewhere new each time, a mapping fault is a property of
  the packet plan and lands on the same packet every frame. `decode_diff.py`
  therefore also computes, across the whole capture, how often each packet
  ordinal differed, and promotes a recurring one out of "tolerated" into
  `systematic-mismatch` -- **located at the offending
  `(controller, port, packetIndex)`**, which is the thing an operator can act
  on. Round 1 shipped without this and a misassigned port was absorbed
  completely; see S8, which is the whole story;
- bounds every "explained" bucket, so none of them is an unbounded output
  counter: `max_tolerated` per config, a maximum blank run, and partial frames
  allowed only at the capture-window edges;
- turns a list of configs into one table + one JSON file.

**The bar is stated once, in full, in S8.** Do not restate it as "zero
unexplained rows" anywhere -- that was round 1's phrasing, it was one clause of
five, and implementing it literally passed a misassigned port.

## 2. The control path -- design, statically verified; live verification blocked

Decision 5: writing a mapper XML to the file Ledset already reads its
geometry from, then restarting Ledset, loads the geometry with **no UI
automation at all**. This session confirmed the mechanism precisely, read
directly from `decompiled/LedSet.decompiled.cs`:

- `App()` constructor -> `Config = new Configuration(WorkingPath + "Configure.ini"); Config.Read()`
  (line 674-677) reads `Configure.ini`'s `MapperPath=` key
  (`Configuration.GetMapperPath()`, line 606-609).
- `LedMapper_Loaded` -> `ReadParam()` (line 1175-1184): *"if `config.MapperFile`
  is non-empty and the file exists, `OpenFile(config.MapperFile)`."*
- `OpenFile(path)` (line 1286-1297): deserialises the XML into `MapperData`,
  sets `cbo_Type` / `cbo_FeetOfWidth` / `cbo_FeetOfHeight`'s `SelectedIndex`
  directly (no click), sets `isFloorParamChanged = false`, calls
  `Btn_OK_Click(null, null)` to redraw, and marks the Save button clean.

None of this touches `screenSend.dll` -- `Btn_OK_Click`'s only side effect
besides the redraw is `PipeMsgSend.SetSize(...)`, IPC to the (always-running,
per `App()`'s unconditional `RunPlayDialog()`) Player helper process for
preview sizing, not the floor protocol.

**Write side verified, live, this session:**

```
$ python -m mapper xml --type 8x8_8P --cols 8 --rows 5 --out generated-test3.xml
$ diff reference/Test3.mapper.xml generated-test3.xml
(no output -- byte-identical)
```

`mapper.mapper_xml.to_xml()`'s output is byte-for-byte identical to the
vendor's own file, confirming the write side of decision 5 end to end.

**Read side (the actual "Ledset picks it up and reports the geometry back")
is designed and built, not run live this session.** `verify-xml-control-path.ps1`
implements it: write the candidate XML to the file `Configure.ini`'s
`MapperPath` already points at, `CloseMainWindow()` on the running LedSet
process (its own `Closing` handler stops the send timer -- `PipeMsgSend.SetTimer(isSet:
false)` -- before `Application.Current.Shutdown()`, per
`decompiled/LedSet.decompiled.cs:2770-2801`), relaunch, then **read-only**
UI Automation (`SelectionPattern.GetSelection()`, no `Select()`/`Invoke()`
anywhere in the script) to confirm `cbo_Type`/`cbo_FeetOfWidth`/`cbo_FeetOfHeight`
and the drawn controller count match. It restores the target file's original
content and the caller's foreground window before exiting either way.

It was not run: an attempt was blocked by this environment's own permission
system (`Stage 2 classifier error` on the Bash tool, twice, non-transient),
independent of and in addition to the design constraint that Ledset must not
be disturbed while attended. **Live verification of the read side is
therefore blocked twice over** -- by the permission system in this session,
and, regardless of that, it needs the operator's attention because it briefly
closes and relaunches Ledset. See S6, item 2.

Wrote no files under `C:\Users\USER\dev\Dance Floor\Release\` (the vendor
install). The XML target (`Configure.ini`'s `MapperPath` value,
`...\Dance Floor\Lplayer\ledset-test.xml`) is a sibling directory, not the
install, and its distinctive non-vendor filename indicates it was already
staged for exactly this kind of test by an earlier session -- but this
session never wrote to it either, since the verification never ran.

## 3. The capture recipe

**Tool:** `C:\Program Files\Wireshark\dumpcap.exe` (v4.6.7, confirmed present
and runnable this session). Passive only -- opens no connection, sends
nothing. Running it never crosses the "does this transmit" line.

**Interface + filter, re-confirmed this session** (per
`docs/RUNSHEET-10x5-4P.md` PF3: *"re-derive this every session, the number
is not stable across reboots"*):

```
$ dumpcap.exe -D
...
8. \Device\NPF_{...} (Ethernet)
...
$ Get-NetIPAddress -AddressFamily IPv4 | Where InterfaceAlias -eq Ethernet
Ethernet   10.200.50.78   8
```

Interface **8**, alias `Ethernet`, `10.200.50.78/8` -- unchanged from
`docs/CAPTURE_RESULTS.md`. Filter: `udp port 60001` (every capture in this
repo uses it; the protocol has nothing else to catch).

**Two programmatic modes, both in `tools/oracle/capture.py`:**

```python
# duration-based, for an unattended sweep -- dumpcap stops itself, no signal needed
capture.capture_for(interface="8", out_path="...", duration_s=6)
#   -> dumpcap -i 8 -f "udp port 60001" -a duration:6 -w <out>

# start-now/stop-on-request, for the attended case (mirrors docs/CAPTURE_PLAN.md's
# manual "start capture, do the floor action, then stop" exactly)
handle = capture.start(interface="8", out_path="...")
# ... trigger playback ...
capture.stop(handle)   # sends CTRL_BREAK_EVENT; dumpcap flushes a valid trailer
```

**Verified this session, structurally:** `capture_for()` was run against the
Windows **loopback** pseudo-interface (`9. \Device\NPF_Loopback`) with a
tiny synthetic UDP send during the window, to prove the subprocess start/duration/stop
mechanics without going near the floor NIC. `dumpcap` started, ran for the
fixed window, exited cleanly on its own, and produced a fully parseable
pcapng file -- the mechanism works exactly as designed.

**An important, unplanned finding from that test:** the capture on the
loopback interface was not confined to loopback traffic. It also contained
real `10.200.50.78 -> 255.255.255.255` UDP/60001 packets, shaped exactly
like live floor protocol traffic (byte 1 cycling 0/1/2, byte 3 cycling
0..3, `0x81` EOF on controller 2's port 1 -- the exact signature of the
current 3-controller `8x8_4P` rig). Windows/Npcap's loopback pseudo-adapter
apparently mirrors locally-originated broadcast sends **system-wide**, not
just true `127.0.0.1` traffic -- so it is not an isolated test surface on
this machine. This is independent confirmation that something was actively
transmitting to the floor during that window (almost certainly the user's
own concurrent, authorised use of the Player page, consistent with what the
orchestrator had already reported). **The incidental capture file was
deleted immediately** and not analysed beyond the source/destination IP
check needed to identify what it was; no further loopback self-tests were
run this session to avoid repeating the exposure. This harness's own tests
never touch the loopback adapter for this reason -- `capture.py`'s mechanics
are exercised only through the classifier-blocked live path and this one
(now-deleted) structural check.

**Not re-verified against the real floor NIC this session** -- interface 8
was only enumerated (`dumpcap -D`, read-only), never captured on, since
every actual transmission on it is either the hard-stopped Player-page probe
or the user's own concurrent activity.

## 4. How to run

```bash
cd C:\Users\USER\dev\ddf

# the default: dry-run against captures/*.pcapng, no hardware, no Ledset, no transmission
python -m tools.oracle.harness run

# a different config list
python -m tools.oracle.harness run --configs my-list.json

# find the floor NIC's current dumpcap interface number
python -m tools.oracle.harness list-interfaces

# the harness's own tests
python -m unittest discover -t . -s tools/oracle/tests
```

`run` always writes `tools/oracle/out/report.json` (override with
`--json-out`) alongside the printed table, and exits non-zero if any config
did not pass -- including a config with no capture, which is reported as a
row with `error` set rather than silently skipped.

### Dry-run output, this session, against the real `captures/*.pcapng`

```
name                         status  pkts  frames  match     tol  unexp  part  recur  detail
--------------------------------------------------------------------------------------------
01-black                     PASS      16      46     46     0/0      0     1     0%  -
02-white                     PASS      16      46     43     3/3      0     1     2%  frame 4 [torn-frame] ctrl0/port0/pkt0 byte4=0x00 body offset 0: expected 255 got 0
03-red                       PASS      16      44     40     4/4      0     1     2%  frame 11 [loop-boundary-blank] ctrl0/port0/pkt0 byte4=0x00 body offset 2: expected 255 got 0
06-halves                    PASS      16      46     41     5/5      0     1     2%  frame 6 [torn-frame] ctrl0/port0/pkt1 byte4=0x01 body offset 69: expected 255 got 0
20-ours-white                PASS      16      50     50     0/0      0     0     0%  -
8x8_4P_10x5-acceptance-gradient24 ERROR      -       -      -       -      -     -      -  no capture available for this config

5/6 configs passed
```

Reading the columns:

- `tol` is **tolerated / budget**, not a bare count. The budget is the config
  list's `max_tolerated`, measured per capture (S8). `3/3` means the capture
  spent its whole budget and one more tolerated frame would fail it.
- `part` counts partial frames -- groups whose packet count is not the plan's.
  Every Ledset capture here ends one datagram into the next frame, because the
  capture window closes mid-frame; `20-ours-white` stops on a frame boundary.
  They are counted rather than dropped, because the table's denominator must
  not be something the code chose without saying so, and a partial frame
  *inside* the capture is a controller dropout and fails.
- `recur` is the worst packet ordinal's mismatch rate across frames -- the
  cross-frame reading, printed on every row whether it passes or not. **2 % is
  a vendor tear. 100 % is a mapping fault.** It is printed on passing rows
  deliberately: this project's recurring failure mode is a measurement that
  agrees with itself, and a number that is always on the row regresses
  visibly, where a boolean only flips.

Exit code 1 (the acceptance-geometry row has no capture yet -- intentional;
see S5). The 46-frame counts for `02-white` and `06-halves` match
`mapper/README.md`'s own figures (43/46, three tolerated) computed
independently by this harness's classifier, not copied from
`docs/CAPTURE_RESULTS.md` -- whose frame counts are documented elsewhere
this session to be off by one. Do not cite that document's frame-count
numbers; this harness computes its own from `mapper.pcapng.split_frames`
directly.

`--live` starts a **passive** capture and waits `--seconds`; it never
drives Ledset, never opens media, never sends anything. As of this writing
every entry in `configs.acceptance.json` has `capture: null`, so there is
nothing for `--live` to usefully run against yet regardless -- see S5.

## 5. What it cannot yet do

- **No multi-controller oracle exists.** Every capture in `captures/` is the
  single-controller 2026-08-06 rig. The acceptance geometry (`8x8_4P`,
  10x5, three controllers, partial last controller) has never been
  captured through Ledset.
- **No capture can currently detect a misplaced tile or a misassigned
  port**, project-wide (not specific to this harness -- a critic found this
  against `mapper/`, and `docs/RUNSHEET-10x5-4P.md` S0 documents the same
  gap independently). Every existing capture is tile-uniform (solid
  colours, or one lit tile in isolation), so nothing today constrains
  intra-tile pixel order or `tile_col -> (controller, port)` port
  assignment at the packet-capture level. `gradient24` closes this --
  S6 item 1.
  **Measured this session, exactly:** injecting "tile column 7 reads column 6"
  into `mapper.plan.build_plan` changes **not one byte** of the expected frame
  for `01-black`, `02-white`, `03-red`, `06-halves` or `20-ours-white`
  (SHA-256 of the whole frame identical in all five). No change to this
  harness can ever detect that fault from those files, because the files do
  not contain the information. `06-halves` constrains tile columns only as
  the two sets `{0,1,2,3}` and `{4,5,6,7}`; any permutation *within* a set is
  invisible. S8 has the numbers.
- **Every diff is against one still expected frame.** The harness builds a
  single expected frame from the config's pattern and compares every captured
  frame to it, so the capture must be of *static* content. A moving clip
  disagrees on nearly every frame and now reads as `systematic-mismatch` --
  which is the correct verdict (it does not match) but a misleading diagnosis
  (nothing is wrong with the port mapping). `07-tilewalk.pcapng` is exactly
  this shape and is deliberately absent from every config list;
  `mapper/tests/test_oracle_capture.py` handles it with a different method.
- **The XML control path's read side (Ledset picks the geometry back up) is
  unverified live** -- designed, code-complete, blocked this session (S2).
- **`--live` has never transmitted or captured a real frame.** Its
  mechanics (`capture.capture_for`/`start`/`stop`) are verified
  structurally against the loopback interface only (S3); the real floor NIC
  has only been enumerated, never captured on.
- **Arrangement #2 (decision 20) has no oracle plan yet beyond
  `configs.acceptance.json`'s placeholder row** -- its wire bytes are
  predicted to be identical to arrangement #1's (orientation is a
  framebuffer-read-side transform, applied before packing, never a packet
  reorder -- `mapper/orientation.py`), so the packet oracle does not need a
  second capture to prove the byte-level claim; it exists to support the
  *physical* corner checks in `docs/RUNSHEET-10x5-4P.md` S9, not to add a
  second wire-level test.

## 6. Blocked on the attended session -- ordered list

Hand this to the user as one session, in this order. Nothing below opens
media or presses play except where explicitly marked -- everything else is
either passive capture or Mapper-page-only automation.

1. **Capture `09-gradient24-8x8_4P-10x5.avi` through Ledset at the
   acceptance geometry.** Top priority, per the critic's finding that this
   is the one capture that can catch a misplaced tile or a misassigned
   port, and it simultaneously becomes the first multi-controller oracle.
   - File is already built and verified this session:
     `tools/oracle/media/09-gradient24-8x8_4P-10x5.avi`, 80x40 px, 60
     frames @ 10fps (6s), confirmed to **load and decode** via Ledset's own
     `VideoGrabber.dll` without launching Ledset
     (`tools\Test-LedsetCanLoad.ps1` reported `WorksInLedset = True`). Its
     pixel content is cross-checked byte-for-byte against
     `mapper.patterns.gradient24` by `tools/oracle/tests/test_make_gradient_avi.py`.
   - Copy or symlink it into Ledset's media folder (`Configure.ini`'s
     `ProgramPath`, currently `test-patterns\`), press Refresh in Ledset to
     rebuild thumbnails.
   - Set the geometry to `8x8_4P`, 10 cols, 5 rows -- via the mapper page
     (UI or the now-authorised XML control path) or confirm it is already
     set from `docs/RUNSHEET-10x5-4P.md`'s own session.
   - Start a capture (`python -m tools.oracle.harness run --live --interface
     8 --seconds 8`, or the manual `dumpcap` command in S3), then play the
     gradient24 clip in Ledset for the capture window.
   - Diff: `python -m mapper verify <capture> --type 8x8_4P --cols 10 --rows 5
     --pattern gradient24`, or add the capture path to
     `configs.acceptance.json`'s first entry and re-run
     `python -m tools.oracle.harness run --configs
     tools/oracle/configs.acceptance.json`. A pass here is the first
     evidence, of any kind, that `tile_col -> (controller, port)` is
     correct above one controller's worth of columns.
   - **Then re-measure `max_tolerated` against the real capture and write the
     measurement into `notes`.** The 9 in both config lists today is *derived*
     from the clip length, Ledset's ~9.2 fps and the observed 2-3 blanks per
     loop boundary (the arithmetic is in `configs.acceptance.json`'s
     `_max_tolerated_derivation`), not measured -- no capture exists at this
     geometry. A budget carried over from a different capture is exactly the
     unbounded tolerance S8 exists to remove.
   - **Read the `recur` column, not just PASS/FAIL.** On this capture it is the
     whole point: ~0-2 % is Ledset's send thread, ~100 % is a port reading the
     wrong tile column, and the row names the port. S8 has the injected-fault
     numbers this reading was calibrated against.
2. **Live-verify the XML control path's read side** (S2):
   `powershell -File tools\oracle\verify-xml-control-path.ps1 -CandidateXml
   <path> -ExpectType 8x8_4P -ExpectWidthFeet 20 -ExpectHeightFeet 10
   -ExpectControllers 3`. Closes and relaunches Ledset -- attended, briefly
   takes the foreground, never opens the Player page. Cheap to run
   immediately before or after item 1's geometry-setting step.
3. **Capture the remaining `configs.acceptance.json` rows** -- a plain
   white frame at the acceptance geometry (coarse sanity check), and the
   arrangement-#2 (`rotate180`) row once the physical move in
   `docs/RUNSHEET-10x5-4P.md` S9 happens.
4. **The Player-page probe itself**, if still wanted as a distinct
   checkpoint beyond items 1-3: load one AVI, play a few seconds, confirm
   every step is scriptable end to end. Items 1-3 above already exercise
   "load geometry, play a clip, capture packets" in substance; this item is
   only the incremental step of *automating* that sequence (vs. the human
   doing it by hand as items 1-3 assume) -- lower priority than actually
   getting the gradient24 oracle capture, per the critic's finding.

## 7. What was needed from `mapper/` and not changed

- `mapper.patterns.PATTERNS` has no `"halves"` entry (the left-white/right-black
  spatial check `captures/06-halves.pcapng` uses) -- it exists only as an
  ad hoc framebuffer built inline in `mapper/tests/test_oracle_capture.py`.
  Reproduced the same construction locally in
  `tools/oracle/decode_diff.py::_halves` rather than adding it to
  `mapper/patterns.py`, which is another pair's file. If `mapper/` ever
  wants `"halves"` as a first-class pattern, this harness's copy should be
  deleted in favour of it.
- `mapper.verify.compare_frame`'s `FrameDiff.first_bad_byte` is only set
  when a **body** mismatch exists; a pure header-only mismatch leaves it
  `None`. `tools/oracle/decode_diff.py::_divergence_for` special-cases this
  (falls back to the first header-mismatched packet and locates the first
  differing header byte directly) rather than changing `compare_frame`'s
  contract. No change requested -- this was a five-line workaround, not
  friction worth asking another pair to absorb.
- Nothing else. `mapper/floors.py`, `mapper/plan.py`, `mapper/frame.py`,
  `mapper/orientation.py`, `mapper/patterns.py`, `mapper/pcapng.py`,
  `mapper/verify.py` are all used exactly as exported, unmodified, and this
  session never edited a file under `mapper/`. The fault-injection work in S8
  patched `mapper/plan.py` **in a throwaway copy under the scratch directory
  only**; the repo's copy was never touched.

## 8. The pass criterion, and what it was proved against

### 8.1 Why this section exists

Round 1 stated the bar as "**zero *unexplained* rows**, not zero diffs" -- here
and in `decode_diff.py`'s docstring -- and implemented `_classify` as a
*per-frame* predicate whose torn-frame arm was:

```python
if 0 < len(bad) < len(observed):
    return "torn-frame"
```

No bound on how many packets, no bound on bytes within them, no contiguity
requirement, no relation to neighbouring frames. The complement was the whole
story: the only frame that could ever reach `unexplained` was one with a header
mismatch, or one where *every* packet's body was wrong and not all-zero. **A
mapping fault that spares even one packet was, by construction, indistinguishable
from a documented vendor defect.**

Injecting a real fault -- swap the tile column that ports 3 and 4 read, headers
left correct, exactly the fault class S6 item 1 says the acceptance capture
exists to catch -- produced this:

```
06-halves    FAIL   16    46     0    46      0  frame 0 [torn-frame] ctrl0/port3/pkt0 ...
```

46 of 46 frames classified `torn-frame`; `unexp` = 0. Implementing the
documented criterion literally would have printed `PASS ... 0 matched, 46
tolerated`. The only thing that stopped it was an undocumented, untested
`and matched > 0` in the source -- and that guard held only because a systematic
fault corrupts *every* frame, which was only true because the acceptance media
is 60 identical frames. One invariant frame flips it to PASS.

Worse, the FAIL misdiagnosed. `tol 46, unexp 0, [torn-frame]` reads as "Ledset
tore 46 frames"; the rational operator response is *re-capture*, and every
re-capture reproduces it identically. That is a fifth self-consistent-but-wrong
conclusion, staged for the acceptance session, on the one capture that settles
port assignment.

### 8.2 The criterion, in full

A config passes when **all five** hold. They are checked in
`decode_diff.analyse_frames` and each one is killed by at least one test in
`tools/oracle/tests/test_decode_diff.py` (verified by mutation -- S8.5):

1. **Zero unexplained frames.** Including the two cross-frame promotions:
   `systematic-mismatch` (8.3) and `sustained-blank` (8.4). The promotions are
   the point -- without them this clause alone passed a misassigned port.
2. **Tolerated frames within `max_tolerated`**, a per-config field of the config
   list, *measured against that capture and justified in its `notes`*. It
   defaults to **0**: a config that has not written the number down gets no
   allowance. Before this, `tol` was an unbounded output counter -- 46/46
   tolerated still printed and still passed.
3. **Partial frames only at the capture-window edges.** A group whose packet
   count is not the plan's is legitimate as the first or last group (the window
   opened or closed mid-frame); anywhere else it is a controller dropout. They
   are counted and printed either way. Before this they were dropped silently
   and the table's denominator was chosen by the code without saying so.
4. **At least one frame matched exactly.** Round 1's accidental guard, now a
   stated criterion with a test. It is *not* redundant with (2): (2) implies
   `matched >= frames_total - max_tolerated`, which is positive only when the
   capture is longer than its own tolerance budget. This clause is the floor for
   a capture that is not -- precisely the case where every other check has too
   little data to mean anything. A capture whose every frame is written off has
   proved nothing, whatever its budget.
5. **No error.** A missing capture is an `ERROR` row and a non-zero exit, never
   a skipped one.

### 8.3 The recurrence threshold, and how it was derived

The discriminating axis is **cross-frame recurrence**, which a per-frame
classifier structurally cannot see. A vendor tear is a timing accident in an
unlocked send thread and lands somewhere new each time; a mapping fault is a
property of the packet plan and lands on the same packet every frame.

`decode_diff.MAX_RECURRENCE = 0.25`. Measured, not chosen. Numerator: frames
whose observed bodies were **not** all zero -- an all-zero frame carries no
information about port assignment (every port carried the same value), so
counting it would let a capture's loop-boundary count set the noise floor of the
check that has to catch mapping faults. Denominator: every complete frame.

Worst-recurring packet ordinal, every real capture in `captures/`:

| capture | frames | worst packet recurs |
|---|---|---|
| `01-black` | 46 | 0/46 = 0.0 % |
| `02-white` | 46 | 1/46 = 2.2 % |
| `03-red` | 44 | 1/44 = 2.3 % |
| `06-halves` | 46 | 1/46 = 2.2 % |
| `20-ours-white` | 50 | 0/50 = 0.0 % |

**Ceiling 2.3 %,** across 232 complete frames and two independent senders
(Ledset for `01`/`02`/`03`/`06`, our own Python sender for `20`). In no real
capture does any packet ordinal tear in more than **one** frame.

Against that, injected mapping faults (S8.5) recur in **93-100 %** of frames.

25 % sits ~11x above the worst real reading and ~4x below the fault signal. The
width is what absorbs a capture much shorter or much tear-ier than the ones
measured: it still permits 11 independent tears on the same packet in a 44-frame
capture, roughly an order of magnitude more vendor misbehaviour than has ever
been observed. A second guard, `MIN_RECURRENT_FRAMES = 2`, stops a three-frame
capture with a single tear from reading as 33 %: one occurrence is not a pattern.

This is the same discipline as `mapper/tests/test_oracle_capture.py`'s
`FRAMES_PER_POSITION = range(16, 22)` -- a measured band whose width is
justified against the failures it must catch, in both directions.

**`test_measured_ceiling_is_far_below_the_threshold` re-measures all five
captures on every run** and fails if the 2.3 % ceiling stops being true, so the
number in the source cannot quietly stop being derived from anything.

#### The residual gap, stated

Criteria (1) and (2) compose but do not close completely. A fault must recur in
**≤ 25 %** of frames to dodge the recurrence check, and in **≤ `max_tolerated`**
frames to dodge the tolerance bound. For `06-halves` (46 frames, budget 5) the
uncovered band is a fault that shows on 1-5 frames and no more. That requires
source content under which the fault is invisible in the other 41 -- which is
possible for a moving clip and **impossible for the acceptance media**, which is
60 identical frames: a fault there is visible in all of them or in none. This is
one more reason the acceptance capture must be the gradient24 clip and not
something with motion in it.

### 8.4 The two secondary defects, also fixed

- **`loop-boundary-blank` never checked for a loop boundary.** It tested
  `len(bad) == len(observed)`, which is neither necessary nor sufficient. Not
  sufficient: any all-black capture -- media that failed to load, a clip not
  playing, an idle floor -- was tolerated wholesale. Not necessary: on
  `06-halves`, whose source is already half black, a genuine loop-boundary blank
  differs in only 8 of 16 packets, so all three of that capture's real blanks
  (frames 31-33) were mislabelled `torn-frame`. Now the blank test looks at the
  observed bytes (`_is_blank`), and a run longer than `MAX_BLANK_RUN = 6`
  consecutive blanks is `sustained-blank`, not a loop boundary. Measured runs in
  the real captures: 2, 3, 3 -- the bound is 2x the longest. `max_tolerated`
  bounds the same failure independently; the run check exists so the *diagnosis*
  is right, not only the verdict.
- **Partial frames were dropped and counted nowhere.** Criterion (3) above.
  Measured: each Ledset capture ends with exactly one trailing group of one
  datagram; `20-ours-white` ends on a frame boundary with none. Both a leading
  and a trailing partial group are allowed, since a capture window can open as
  well as close mid-frame.

### 8.5 Proof: injected faults, before and after

Faults were injected into `mapper/plan.py::build_plan` **in a throwaway copy of
the repo under the scratch directory**, never in the working tree, by remapping
which global tile column a port reads -- headers, packet counts and lengths all
left correct. This is the exact fault class the acceptance capture exists to
catch.

- **F1** -- tile columns 3 and 4 swapped (at `8x8_8P` this is ports 3 and 4 of
  the only controller; at the acceptance geometry it is a *cross-controller*
  swap, ctrl0/port3 <-> ctrl1/port0).
- **F1b** -- tile columns 0 and 5 swapped.
- **F2** -- tile column 7 reads column 6.

`90-synth-acceptance` is a **synthetic** capture at the acceptance geometry
(`8x8_4P` 10x5, gradient24, 74 frames + the trailing partial, with a 3-frame
blank run and 2 torn frames injected as vendor defects), generated from the
clean mapper. It is an **instrument test, not evidence about Ledset**: it proves
what the harness does with a capture of this shape, not that Ledset agrees with
us. Only the attended capture can do the latter.

It is produced by `tools/oracle/make_synth_capture.py`, and every row of the
table below is reproducible in one command each:

```bash
python -m tools.oracle.make_synth_capture --check                # the `none` row
python -m tools.oracle.make_synth_capture --fault f1  --check    # F1
python -m tools.oracle.make_synth_capture --fault f1b --check    # F1b
python -m tools.oracle.make_synth_capture --fault f2  --check    # F2
```

`--check` runs `decode_diff.verify_config` over the file it just wrote and
prints the `report.to_table` row, so the numbers come out of the harness rather
than out of the generator's own claims about itself. The capture lands in
`tools/oracle/out/` and is **not** committed -- it is a build product of a
committed generator, which is the reproducible half. Faults are injected on the
*observed* side, the same equivalence `InjectedMappingFaults` relies on (below).
`tools/oracle/tests/test_make_synth_capture.py` pins the four verdicts so the
table cannot drift away from the code.

| fault | capture | round 1 | now |
|---|---|---|---|
| none | `06-halves` | PASS 41 matched, 5 tol | PASS 41 matched, 5/5 tol, recur 2 % |
| none | `90-synth-acceptance` | -- | PASS 69 matched, 5/9 tol, recur 1 % |
| F1 | `06-halves` | FAIL, `tol 46, unexp 0, [torn-frame]` | FAIL, `tol 0/5, unexp 46, recur 93 %`, **`systematic-mismatch: ctrl0/port3/pkt0 differs in 43/46 frames (93%), limit 25%; 4 packets over the limit on ctrl0/port3, ctrl0/port4`** |
| F1 | `90-synth-acceptance` | -- | FAIL, recur 96 %, located **ctrl0/port3, ctrl1/port0** |
| F1b | `06-halves` | FAIL, `tol 46, unexp 0, [torn-frame]` | FAIL, recur 93 %, located **ctrl0/port0, ctrl0/port5** |
| F1b | `90-synth-acceptance` | -- | FAIL, recur 96 %, located **ctrl0/port0, ctrl1/port1** |
| F2 | `06-halves` | PASS (table byte-identical to clean) | PASS -- **and this is correct**, see below |
| F2 | `90-synth-acceptance` | -- | FAIL, recur 96 %, located **ctrl1/port3** (= tile column 7) |

Every real capture still passes unfaulted, which is the other half of the
result: a recurrence threshold that fails `06-halves` would be useless.

**F2 cannot be caught on the existing captures, and no change to
`tools/oracle/**` could ever catch it there.** Injecting it changes not one byte
of the expected frame for any of the five (SHA-256 of the concatenated frame
identical to the clean mapper's in all five cases; `06-halves` differs only for
F1 and F1b). Tile columns 6 and 7 carry identical content in every capture the
repo has, so the fault leaves no signature to detect. It is caught at the
acceptance geometry with per-pixel-unique content, which is precisely the gap S5
and S6 item 1 already describe -- this session measured its size rather than
narrowing it.

The corresponding unit tests -- `InjectedMappingFaults` in
`tools/oracle/tests/test_decode_diff.py` -- reproduce all three faults on the
*observed* side rather than by patching `mapper/`, which belongs to another
pair. The two are equivalent: `datagrams_from_buffer` slices each packet at
`tile_col * port_data_size`, so changing which tile column a port reads produces
byte-for-byte the same diff as changing which bytes arrive on it.

Each of the five criteria was then **mutation-tested**: disabling it in a
scratch copy must turn the suite red. It does -- recurrence off kills 6 tests,
the blank fix 13, and the tolerance bound, blank-run bound, interior-partial
check and exact-match floor 1 each. A criterion no test defends is a criterion a
cold builder deletes as redundant.
