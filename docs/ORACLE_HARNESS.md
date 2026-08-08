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
  tests/                     unit tests, stdlib unittest, 14 tests
```

Nothing here reimplements the protocol. `decode_diff.py` calls
`mapper.pcapng.read_udp` / `split_frames` to parse a capture, and
`mapper.verify.compare_frame` for the byte-level diff -- both used exactly as
`mapper/` exports them. What this package adds on top:

- maps a mismatch's packet ordinal back to `(controller, port, packetIndex,
  byte4)` via `build_plan()`, instead of leaving it as a bare index;
- classifies an unmatched frame against the two Ledset playback defects
  `docs/CAPTURE_RESULTS.md` documents (loop-boundary all-black frame; torn
  frame from the vendor's unlocked send thread) so the pass/fail line
  matches this project's actual bar -- **zero *unexplained* rows**, not zero
  diffs. A header mismatch is never classified as either defect, since a
  real mapping bug is free to break headers and neither vendor defect is;
- turns a list of configs into one table + one JSON file.

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
name                         status  pkts  frames  match  tol  unexp  first divergence
--------------------------------------------------------------------------------------
01-black                     PASS      16      46     46    0      0  -
02-white                     PASS      16      46     43    3      0  frame 4 [torn-frame] ctrl0/port0/pkt0 byte4=0x00 body offset 0: expected 255 got 0
03-red                       PASS      16      44     40    4      0  frame 11 [loop-boundary-blank] ctrl0/port0/pkt0 byte4=0x00 body offset 2: expected 255 got 0
06-halves                    PASS      16      46     41    5      0  frame 6 [torn-frame] ctrl0/port1/pkt1 byte4=0x01 body offset 69: expected 255 got 0
20-ours-white                PASS      16      50     50    0      0  -
8x8_4P_10x5-acceptance-gradient24 ERROR      -       -      -    -      -  no capture available for this config

5/6 configs passed
```

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
  session never edited a file under `mapper/`.
