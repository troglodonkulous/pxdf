# Hardware Session Run-Sheet — 10×5 `8x8_4P`, Three Controllers

**Rig:** 10 tile columns × 5 tile rows, floor type `8x8_4P`, three controllers
daisy-chained `OUTPUT` → `INPUT`, Device Order set on each unit. This is the
acceptance geometry (decision 19) — three controllers and a partial last
controller in one layout, **neither ever exercised on hardware** before this
session.

**Session covers two arrangements, back to back:**

- **Arrangement #1** — the rig as currently cabled.
- **Arrangement #2** — the same floor, controllers moved to the opposite end,
  corner checks re-run (decision 20). §9 is the delta only; everything in
  §1–§8 applies to #1 and is repeated (not re-derived) for #2.

**Bar:** a predicted-vs-observed table with zero unexplained rows. Every step
below states what you expect to see *before* you run it. If the observation
doesn't match the prediction, the diagnosis branch tells you what to check
next — do not improvise a new hypothesis on the floor if one is already
written down here.

**Do not re-litigate:** frame rate (10 fps, decision 21) or the end-of-frame
flag requirement in general (Q2, closed — it is required). Both are settled.

**Estimated time:** 75–100 minutes for arrangement #1, 45–60 minutes for
arrangement #2's delta (mostly the physical move plus a full re-walk).

**Working directory for every command below:**

```powershell
cd C:\Users\USER\dev\ddf
```

---

## 0. Read this once — what is actually unverified

It is tempting to read this as a cabling/orientation test with the mapping
itself already settled by `mapper/`'s invariant suite and its byte-identical
match to `captures/02-white.pcapng`. **That reading is wrong, and this session
exists partly to correct it.**

A mutation check on the mapper found that **no existing test or capture can
detect a misplaced tile or a misassigned port.** `tile_col → (controller,
port)` is one line — `divmod(tile_col, ports_per_controller)` — and every
invariant, every fixture, and the single-controller oracle capture are
insensitive to it being wrong: the invariant suite only checks that pixels
land in *some* unique slot, not the *correct* one; the 8×5 single-controller
capture never had a controller boundary to get wrong in the first place. This
is the same arithmetic that decides **controller placement** once there are
more tile columns than one controller's port count — exactly this rig.

**This session is therefore the first test, of any kind, that can catch a
wrong `tile_col → (controller, port)` mapping.** Treat it as an unverified
hypothesis, on equal footing with the three things this document already
expected to test: broadcast propagation, Device Order, and orientation. All
four can produce the same surface symptom — *the right pixels, in the wrong
place* — and they need different fixes (escalate a hardware limitation,
correct a setting on a unit, edit `orientation.py`'s parameters, or send pair
A back to `plan.py`/`frame.py` with a specific failing column). Getting the
diagnosis wrong wastes the one hardware session that can resolve any of them.

A partial mitigation landed in parallel with this run-sheet: an assertion on
the `07-tilewalk` capture now pins tile columns 0–3 and their rows. **Columns
4–7 are still constrained only as a set (order unverified), and nothing
multi-controller — meaning columns 4–9, and every controller boundary — is
constrained at all.** Assume that state throughout.

### The two independent senders, and what their agreement actually proves

- **Python (`python -m mapper send ...`)** — primary. Implements the
  orientation transform.
- **`tools\Send-FloorTest.ps1`** — fallback, **unmodified**, no orientation
  transform of any kind. Its default `-PortsPerController` is **8**, wrong for
  this rig — **every invocation below passes `-PortsPerController 4`**
  explicitly. Forgetting that flag silently miscomputes every controller
  boundary in a way that looks exactly like the bug this session exists to
  catch, but isn't — watch for it.

Both independently compute the same conceptual `tile_col → (controller,
port)` mapping — Python via `divmod`, the PS1 via a nested loop that's the
forward direction of the same arithmetic. **When they agree, that is weaker
evidence than it sounds.** Both tools sending byte-for-byte the same
`(controller, port)` for a given tile column means the *same* physical unit
responds the *same* way regardless of which program sent it — so agreement
between the two is the **expected** outcome even under a broadcast failure or
a Device Order collision, neither of which has anything to do with either
sender's code. Agreement rules out exactly one thing: that the two
implementations disagree with each other. It does **not** by itself prove
either is correct against the real floor.

What agreement *is* good for: when Python and the PS1 **disagree** with each
other on which physical block a raw (`--orientation identity` vs. the PS1's
permanent identity) tile lands in, that is unambiguous and hardware-independent
— both were tested at the same moment, on the same hardware, so a
disagreement can only be a bug in one implementation or the other. That
cross-check is used directly in §4 (M1), specifically because it is the one
comparison this session can make that isolates a **sender-side mapping bug**
from every hardware-side explanation.

**Universal fallback diagnostic**, referenced by name throughout: if any
step's floor observation doesn't match its prediction, before assuming a
hardware or orientation fault, capture the packets this session's own sender
actually put on the wire and diff them against the plan:

```powershell
& "C:\Program Files\Wireshark\dumpcap.exe" -i <N> -f "udp port 60001" -w captures\session-<label>.pcapng
```

(run in a second window while the same `send` command is active — see PF3 for
`<N>`), then:

```powershell
python -m mapper verify captures\session-<label>.pcapng --type 8x8_4P --cols 10 --rows 5 --pattern tile --tile-col 0 --tile-row 0
```

Expected: `N/N complete frames byte-identical`. If this **fails**, the bytes
that left the machine were already wrong — that's a bug before the network
even enters the picture. If it **passes**, the correct bytes left the machine
and whatever went wrong is downstream of the wire: a controller's own
addressing/Device-Order behaviour, the daisy chain, or orientation. This
narrows the four-way ambiguity in §0 by one, cheaply, any time you need it.

---

## 1. Safety — read before touching any cable

> ⚠️ **Power down all three controllers before moving any data cable between
> ports.** The chain outputs are RS-485-style differential drivers.
> Hot-swapping data lines can damage the driver ICs on both the controller and
> the tile boards. This applies to the daisy-chain `OUTPUT`↔`INPUT` cabling and
> to any tile-chain connector — not just the Ethernet uplink.

> ⚠️ **Never run Ledset and either sender at the same time.** Two broadcasters
> on the same subnet produce interleaved nonsense on the floor that looks like
> a mapping bug but is two senders fighting. Confirm Ledset is fully closed
> (not minimised) before any transmit step below.

Full stop/abort criteria are in §7. If anything on the floor looks wrong in a
way not covered by a diagnosis branch below, stop and re-read §7 before trying
something improvised.

---

## 2. Pre-flight — nothing transmits in this section

### PF1 — Physical topology

Confirm and record (there is no command for this — trace the cables):

| Hop | From | To | Confirm |
|---|---|---|---|
| 0 | PC wired NIC | Chain position 1 (the controller that reaches the network directly, or a switch that does) | cable seated, link light on both ends |
| 1 | Chain position 1 `OUTPUT` | Chain position 2 `INPUT` | cable seated, link light on both ends |
| 2 | Chain position 2 `OUTPUT` | Chain position 3 `INPUT` | cable seated, link light on both ends |
| 3 | Chain position 3 `OUTPUT` | unused — end of chain | — |

**Chain position is not the same fact as Device Order.** Position determines
*whether* broadcast can physically reach a unit (it must be relayed through
every upstream hop); Device Order alone determines *which* content a unit
displays once a packet arrives, and doesn't care about position. Keep these
two tables separate — conflating them is exactly the trap §3 is designed to
pull apart, and now a third fact (which tile columns the sender's code
*intends* for that Device Order) has to stay separate from both of these too.

Also confirm, per unit, which physical connectors have a tile chain plugged in:

| Unit (by chain position) | Connectors populated | Tile columns expected |
|---|---|---|
| 1 | 1, 2, 3, 4 | 4 columns |
| 2 | 1, 2, 3, 4 | 4 columns |
| 3 | **1, 2 only** — 3 and 4 must be empty | 2 columns |

Connector `i` (1-based) on a `_4P` unit drives logical port `i-1` (one chain
per connector on this floor type — unlike `_8P`, where each connector drives
two). If chain-position-3's connectors 3/4 are populated instead of 1/2 (or
any other pair), later predictions about "controller 2's first port" will be
wrong for a reason that has nothing to do with Device Order, broadcast, or a
code bug — check this now, it's cheap and it's a pure hardware fact.

### PF2 — Device Order on each unit

Not queryable from software — the controller never answers a query (§2,
`PROTOCOL.md`: no ARP, no ping, no discovery, ever). Read it directly off each
physical unit's own display/menu before connecting anything. Record which
physical unit (by chain position from PF1) reports which order:

| Chain position | Device Order shown on unit | Expected |
|---|---|---|
| 1 | | `01` (Master) |
| 2 | | `02` (Slave) |
| 3 | | `03` (Slave) |

If any reading is wrong or duplicated, fix it now, on the unit, before any
transmit step. This table is the ground truth §3 relies on to tell a Device
Order problem apart from everything else — if it's wrong, every downstream
diagnosis in this document is unreliable.

### PF3 — Capture NIC

```powershell
& "C:\Program Files\Wireshark\dumpcap.exe" -D
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength
```

Find the wired adapter on the floor subnet (historically `10.200.50.0/8`,
alias `Ethernet`) and note dumpcap's interface number for it — **re-derive
this every session**, the number is not stable across reboots. Record both the
interface number and the IP — the IP is also what every send command below
needs for `--local-ip` / `-LocalIP`, since this machine has Wi-Fi and several
virtual adapters that could otherwise absorb the broadcast.

**Predicted:** one adapter named `Ethernet` (or similar), IPv4 in
`10.200.50.0/8`.

**If no such adapter exists, or it has no link:** stop here — nothing past
this point can work. Check the physical uplink cable from the PC before
anything else.

### PF4 — Mapper's predicted frame math matches the rig

```powershell
python -m mapper plan --type 8x8_4P --cols 10 --rows 5
```

**Predicted output** (first and last lines; the full 20-row table is in
`docs/PROTOCOL.md` §3.2 and matches exactly):

```
8x8_4P 10x5 tiles = 80x40 px, 3 controller(s), 20 packets/frame, 9700 bytes/frame
...
20 packets, 9700 bytes/frame, 3 end-of-frame flag(s)
```

Confirm: 20 packets, 9700 bytes, EOF flags (`byte4 = 0x81`) at packet indices
7, 15, 19 — controller 0 port 3, controller 1 port 3, **controller 2 port 1**
(not port 3 — it's the partial one). If any of these numbers differ from what
you see, **stop** — this is a software regression, not a floor problem, and no
hardware step below is meaningful until it's fixed.

**What this command does *not* confirm:** that packets claiming to be
"controller 1, port 0" actually correspond to logical tile column 4. The plan
printer reports the shape the code *believes* it is producing; whether that
belief is correct for columns above 3 is exactly what §3/§4 test. Do not read
a clean PF4 as evidence the mapping is right — it only confirms the counts
and header arithmetic, which is the part the invariant suite already covers.

### PF5 — Cross-check against the fallback sender's own plan (no transmission)

```powershell
.\tools\Send-FloorTest.ps1 -Cols 10 -Rows 5 -PortsPerController 4 -Pattern white -DryRun
```

**Predicted:** the same 20-row table, same byte4 values, same lengths, ending
`end-of-frame flags: 3 (expected 3)`. Same caveat as PF4 — this confirms the
*shape* (counts, header bytes, lengths) both tools agree on, not that either
one's `tile_col → controller/port` assignment is correct. If they disagree
even on shape, stop — that's a plainer bug than anything §3/§4 are looking
for.

### PF6 — (optional) invariant suite green

```powershell
python -m unittest discover -t . -s mapper/tests
python -m mapper matrix --supported-only
```

**Predicted:** `OK` (33 tests), then `1056 legal configurations checked...`.
Not required every session, but cheap (under a minute total) and rules out an
unrelated regression before you're standing on the floor. Per §0, a green run
here says nothing new about the controller-placement question — that's the
whole point of this session.

---

## 3. First verify step — broadcast, Device Order, or a swapped block

**This is the fastest test in the document and the first hard gate.** Handoff
1 §8 flags broadcast propagation through the daisy chain as unproven: pure
broadcast, no addressing beyond byte 1, so if `OUTPUT`→`INPUT` doesn't relay
it, controllers 2 and 3 never see a frame — a hardware limit, nothing to do
with our code. A mis-set Device Order can produce an equally silent, non-error
failure. And now — per §0 — a wrong `tile_col → (controller, port)` mapping
in the sender can *also* put a lit tile on the wrong physical block, with no
error either. All three need pulling apart, and the earlier that happens the
better, so this section runs before anything else touches the network.

(§4 goes further — every column, every port, both senders. This section is
the cheap first gate: three quick sends, one per controller's **first port
only**, to catch the coarse cases immediately. A subtler bug confined to a
non-zero port would pass here and get caught in §4 instead — that's a known,
accepted gap in this section by itself, not in the session as a whole.)

**Read the whole floor after each send below, not just the block you're
targeting**, and apply this once, to all three:

- **Exactly 1 tile lit, in the block PF1 says is wired to the unit PF2
  confirmed holds this test's target Device Order** → pass for this column.
- **Exactly 1 tile lit, but in a different block than PF1/PF2 predicts, and
  nothing else lit anywhere** → **not** a Device Order collision (a collision
  always produces two or more simultaneously lit tiles — see below). First
  re-check PF1 and PF2 in person; a stale or mis-transcribed reading there
  will look exactly like this. If both check out, this is a candidate
  **mapping bug**: the sender computed the wrong `(controller, port)` for this
  tile column. Do not conclude this from a single sender — run the same
  tile-col through both Python and the PS1 (§4, M1) before escalating. If both
  land on the same wrong block, the bug is conceptual/shared; if only one
  does, it's specific to that implementation.
- **Nothing lit anywhere** → PF2 already read Device Order directly off the
  physical unit, so this isn't an addressing mismatch for the unit that should
  be showing it. This points at broadcast not reaching that unit — see the
  abort condition in §7. (For controller 2 specifically, there is a second
  candidate — see V1c below.)
- **2 or more tiles lit simultaneously** → **duplicated content**, a genuine
  Device Order collision. Mechanism: every controller receives every packet
  every frame (pure broadcast, filtered locally by byte 1); if two physical
  units share a Device Order, both act on the same byte-1 value and each
  renders it onto its own local ports — so the same lit tile appears in both
  units' blocks, at the same relative position, at once. Unambiguous: re-read
  PF2 for every block that lit, find the collision, fix it on the unit, re-run
  PF2 and this test.

### V1a — controller 0

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 0 --duration 8
```

**Predicted:** one tile, chain-position-1's block, first column.

### V1b — controller 1

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 4 --tile-row 0 --duration 8
```

**Predicted:** one tile, chain-position-2's block, first column.

### V1c — controller 2 (partial — only 2 ports, EOF on port 1 not port 3)

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 8 --tile-row 0 --duration 8
```

**Predicted:** one tile, chain-position-3's block, first column.

This column carries one extra risk specific to being the *partial* one: its
end-of-frame flag lands on **port 1**, not port 3 like the other two (PF4 —
packet index 19). Every prior confirmation that the EOF flag latches a frame
(`CAPTURE_RESULTS.md` Q2) was on a controller with a full complement of ports,
where the flag always sits on the highest-numbered one. If chain-position-3's
firmware has any assumption that the frame-end flag arrives on a fixed
"last" port regardless of how many are actually active, it may never latch.

| If nothing lights, and V1a/V1b passed | Diagnosis | Next |
|---|---|---|
| Steady dark, no flicker | Same broadcast-relay hypothesis as the general case, one hop further — see §7. | Escalate; not fixable in software at this session. |
| Sporadic partial flicker, not a clean image | Matches the `CAPTURE_RESULTS.md` Q2 "unlatched" signature — packets arriving and being accepted, but the frame never completes from this unit's point of view. Plausibly the EOF-on-port-1 risk above. | Record precisely — this is a genuinely new finding, no partial controller existed before this rig. Do not attempt a fix on the floor; write down the exact observation for pair A. Continue testing controllers 0 and 1, which are unaffected. |

---

## 4. Full mapping walk — every column, every port, both senders

§3 only exercises port 0 of each controller. This section is the one that
actually answers the question in §0: is `tile_col → (controller, port)`
correct everywhere, not just at the three points already checked. Nothing
before this session constrains tile columns 4–9 or any controller boundary —
this walk is the only evidence that will ever exist for them until it runs.

### M0 — PS1 full walk (primary; exhaustive; no orientation transform)

```powershell
.\tools\Send-FloorTest.ps1 -Cols 10 -Rows 5 -PortsPerController 4 -Pattern tilewalk -Hold 2 -LocalIP 10.200.50.78
```

Walks all 50 tiles, one at a time, 2 s each (~100 s total), column-major:
tile-col 0 rows 0→4, then tile-col 1 rows 0→4, … through tile-col 9. It
prints `tile (col=N, row=M)` to the console as it steps — **film the floor**
so the video and the console log together give the complete map in one pass.

**Predicted:**

- Exactly one new tile lights every 2 s, advancing in a fixed physical
  direction, no skips, no repeats, no two lit at once.
- Each physical block (as identified by PF1's cable trace) shows **exactly**
  4, 4, then 2 distinct tile positions before the walk visibly moves to the
  next block — matching `PORT_COUNT_A_CONTROLLER=4` and the partial third
  controller.
- Within one tile-col's 5-step run, the row direction is consistent with
  every other tile-col's 5-step run (checked properly in §5).
- The four points needed for orientation are specific steps in this same walk
  — no extra transmission needed (see §5): step 0 = `(0,0)`, step 1 = `(0,1)`,
  step 5 = `(1,0)`, step 49 = `(9,4)`. Note the physical tile at each,
  ideally with a timestamped photo.

| Observed | Diagnosis | Next |
|---|---|---|
| Clean walk, exactly {4, 4, 2} per block, in order | **Pass.** Mapping confirmed for all 10 columns via one sender. Continue to M1 for the cross-implementation check. | |
| A block shows more or fewer than its expected column count before the walk visibly jumps to a different physical block | **Controller-boundary bug** — this is precisely the "controller placement above 8 columns" risk flagged in §0. Record which block, and the count actually observed. | Escalate to pair A with the exact step numbers where the boundary landed wrong. Do not attempt to patch this by adjusting orientation flags — it is not an orientation problem. |
| One 2 s interval is dark, walk resumes correctly after | Possible dropped frame/packet, or an EOF/latch hiccup at that specific boundary. Note the exact `col=/row=` printed at that moment. | Re-run the walk once. Reproducible at the same column → treat as a real per-column defect, not noise; investigate that column specifically. One-off, non-reproducible → note it, don't over-conclude from a single miss. |
| Two tiles lit simultaneously at some step | Device Order collision, surfaced independently of §3 (a second chance to catch it, or evidence it's intermittent). | Note which two blocks; re-check PF2 on both. |
| Row order inconsistent within one tile-col's run relative to others | See §5 — this is the `reverseColumnsPerController`-adjacent risk, not a column-boundary bug. | Continue to §5's explicit check. |

### M1 — Python cross-check, all 10 columns at row 0

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 1 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 2 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 3 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 4 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 5 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 6 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 7 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 8 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 9 --tile-row 0 --duration 6
```

**Predicted:** for each `N`, the *same* physical tile M0's `tile-col=N,
row=0` step showed (step `5N` of the M0 walk).

This is the comparison described in §0: neither sender applies an
orientation transform here, both were run on the same hardware in the same
session, so any per-column disagreement between the two is a real
implementation bug, isolated to whichever one doesn't match the M0
observation (which itself should match PF1's physical trace).

| Observed | Diagnosis | Next |
|---|---|---|
| All 10 match M0 | **Pass.** Both independent implementations of `tile_col → (controller, port)` agree with each other and with the physical floor, for every column. This is the strongest evidence this session can produce that the mapping is correct. | Continue to §5. |
| One or more columns disagree between Python and the PS1 | Confirmed sender-side bug, not hardware — pinpointed to whichever tool doesn't match the M0/PF1 physical fact for that column. | Stop treating the mapping as verified for that column (and be suspicious of neighbouring ones). Escalate to pair A with the specific `tile-col` values and both observed blocks. |
| Both agree with each other but *neither* matches M0's own earlier observation for that column | Possible transient (loose connector, one dropped frame) rather than a mapping bug — a real bug would reproduce identically since nothing in the code differs between sends. | Re-run just that one column on both senders; if it now matches M0, treat the first M0 reading as noise and note it; if it still disagrees, treat as a live mapping bug per the row above. |

---

## 5. Orientation and the reverse-columns risk — derived from the walk

**No new transmission needed if M0 (§4) was filmed/logged.** Read the
physical tile observed at M0's steps 0, 1, 5, and 49 (`(0,0)`, `(0,1)`,
`(1,0)`, `(9,4)`) — these are the four corner observations from
`CAPTURE_RESULTS.md` Q1's method, adapted to this rig's actual extent (max
tile-col **9**, max tile-row **4**, not 7/4 — this floor is wider than the
historical one).

**These four fully determine the transform.** Only `rotate180` and `mirrorX`
are possible (`PROTOCOL.md` §4.4 — 90°/270° are physically excluded because
`port = tileCol % PORT_COUNT` binds tile columns to the port axis):

Pick whichever physical corner you want to call logical `(0,0)` — there is no
requirement on *which* corner, only that it's documented. Compare the
observed direction of travel for `(1,0)` and `(0,1)` against "+x moves right,
+y moves down" from that corner:

| Both axes inverted | Only the long axis inverted | Neither inverted |
|---|---|---|
| `rotate180` | `mirrorX` | `identity` |

`(9,4)` must land diagonally opposite `(0,0)`; if it doesn't, see the M1
table above — that's more likely a per-column mapping issue on column 9
(controller 2's *second* port, otherwise only touched by M0 itself) than an
orientation error, since orientation is a single floor-wide transform and
wouldn't put just one corner out of place while the rest of the walk was
clean.

**If M0/M1 weren't filmed clearly enough to read these four points**, fall
back to four dedicated sends:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 0 --duration 8
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 1 --tile-row 0 --duration 8
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 1 --duration 8
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 9 --tile-row 4 --duration 8
```

### The reverse-columns risk

`orientation.py`'s `reverseColumnsPerController` flag is **global** — if set,
it reverses port order inside *every* controller's group simultaneously.
There is no way, in the current code, to reverse only one controller's
internal cabling while leaving the other two alone. Check M0's column
direction *within each block separately* (tile-col 0→1 vs. 4→5 vs. 8→9 — all
already part of the same walk, no extra commands needed):

| Observed | Diagnosis | Next |
|---|---|---|
| All three controllers' column direction agrees | **Pass** — a single `reverseColumnsPerController` value (true or false) correctly describes this whole rig. | Continue to §6. |
| One controller's column direction is opposite the other two | **The current orientation model cannot represent this rig.** Applying the flag would fix the odd one out and break the other two, or vice versa. | Record exactly which controller (by chain position). Not fixable at the floor — needs either a recable of that one controller's chain (§1 power-down procedure) or a code change to make the flag per-controller (escalate to pair A). Do not proceed to declare orientation "determined" for this rig until one of those happens. |

---

## 6. Confirm the derived orientation, then run the full pattern

### V3 — confirmation

Re-send `(0,0)` with the orientation flag derived in §5 applied and confirm
it now lands at whatever corner you decided is the documented origin:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --orientation <derived> --pattern tile --tile-col 0 --tile-row 0 --duration 8
```

(`<derived>` is one of `identity`, `rotate180`, `mirrorX`, or a `+`-joined
combination — per `mapper --help`.)

| Observed | Diagnosis | Next |
|---|---|---|
| Correct corner | **Pass — orientation determined for arrangement #1.** | Record it (§10), continue to V4. |
| Still wrong | The transform derived from §5 doesn't reproduce §5's own observations — arithmetic error in deriving `<derived>`, not a new hardware fact. Re-derive, don't guess. | Fix and re-run V3 before continuing. |

### V4 — full pattern at 10 fps

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --orientation <derived> --pattern gradient24 --fps 10 --duration 30
```

**Predicted:** a smooth, spatially coherent 80×40 image across the whole
floor for the full 30 s — no missing region, no visibly duplicated block, no
seam at any controller boundary. By this point every column has already been
individually confirmed (§4), so this step is a holistic sanity check, not a
first look — a mismatch here after a clean §3–§5 would itself be an
unexplained row, worth stopping on rather than shrugging off.

**Scope note on the two vendor defects:** this command sends one **static**
framebuffer repeatedly — there is no video clip and therefore no loop
boundary for the "two black frames per loop" defect to occur at. This step
does **not** exercise that specific defect; it is not testable with the
current CLI (no media playback yet), and that gap should stay recorded as
such, not silently claimed as covered. The torn-frame defect (`SendData`'s
missing locking) is excluded by construction here — the whole buffer is built
in Python before any packet is sent, so there is no concurrent writer to race
against — but that's a code-level argument, not an empirical one; for direct
evidence, capture this run (§0's universal diagnostic) and confirm every
frame is `packets_per_frame`-complete with no header gaps.

| Observed | Diagnosis | Next |
|---|---|---|
| Coherent image, stable for 30 s | **Pass.** Session core is done for arrangement #1. | |
| A whole controller's block is missing/dark | One of §3/§4's controllers has stopped responding, or a duplicate Device Order re-appeared under sustained load (thermal/power issue). | Re-run V1a–V1c to re-localise. |
| A block shows a shifted/duplicated version of another block's content | Same duplicated-content signature as §3 — Device Order conflict, possibly intermittent. | Re-check PF2 for a loose/marginal setting; re-run §3. |
| Periodic black flash | Shouldn't be possible given this command sends a static frame — points at the send loop's own pacing, not the vendor's loop-boundary defect. | Capture and inspect frame timing; escalate to pair A, this is a new and unexpected finding. |
| Visible tear line, unstable over time | Contradicts the double-buffer-by-construction argument above. | Capture and run `mapper verify`; if verify passes (bytes were correct) the defect is on the controller/floor side, not the sender. |

---

## 7. Abort and safety criteria

**Stop and do not continue** if any of the following occur:

- Any observation in §3/§4 points at broadcast not reaching a controller
  **after** PF2 has independently confirmed Device Order is correct on that
  unit's own display, **and** M1's cross-implementation check rules out a
  sender-side mapping bug for that column. This is a hardware/topology
  limitation outside our code — acceptance for the multi-controller geometry
  cannot be claimed with it unresolved. Escalate; do not attempt a software
  workaround (per decision 18, nothing added to the PS1; per §5, the current
  orientation model has no per-controller fix either).
- M1 finds a Python/PS1 disagreement on any column. Both are wrong-or-right
  together on raw mapping; a disagreement means neither can be trusted until
  resolved, and nothing built on top of that column (orientation, full
  pattern) can be trusted either.
- M0 finds a controller-boundary count that doesn't match {4, 4, 2}. Same
  reasoning — this is a code bug, not a floor problem, and everything past
  that boundary is suspect until fixed.
- §5 finds one controller's column direction inconsistent with the other two.
  Orientation cannot be correctly declared for this rig until it's either
  recabled or the model is extended.
- Any smoke, unusual heat, or unusual sound from a controller or power supply
  — immediate hard stop, power off at the wall, unrelated to anything in this
  document.
- You need to move any data cable. **Power down first** (§1). Never hot-swap.

**To leave the rig in a safe state** at the end of a session, or before any
abort that leaves things mid-test:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
```

Then Ctrl+C any still-running sender (both the Python and PS1 senders close
their socket in a `finally` block, so Ctrl+C mid-send is safe). If cabling is
about to be touched, power down all three controllers before doing so.

---

## 8. Session-level result

Fill in once §3–§6 are done for arrangement #1 (and again after §9 for
arrangement #2):

- Mapping (`tile_col → (controller, port)`) confirmed for all 10 columns via
  M0 alone, and cross-confirmed via M1 against the PS1: **yes / no**
- Broadcast reaches all three controllers, disambiguated from Device Order
  and from a mapping bug: **yes / no**
- Device Order collision-free across all three units, at the time of testing:
  **yes / no**
- `reverseColumnsPerController` consistent across all three controllers (not
  needed per-unit): **yes / no**
- Orientation determined and confirmed by V3: **value: _______**

If any line is "no," the acceptance bar in decision 19 is not met yet — do
not report the session as a pass with an asterisk; report exactly which line
failed and what §3–§7's diagnosis branch said to do about it.

---

## 9. Arrangement #2 — delta only

Same floor, controllers relocated to the opposite end. Everything above
applies; this section lists only what changes.

**Before moving anything:** power down all three controllers (§1). Physically
relocate the controllers (power + Ethernet daisy chain + all tile-chain
connectors) to the opposite end of the 10-tile axis. This is a full recable,
not a cosmetic move — treat it with the same care as first-time setup.

**Skip on re-run** (unchanged by the move):

- PF3 (capture NIC) — only re-check if the PC itself was also moved or
  rebooted.
- PF4/PF5 (mapper math / PS1 plan cross-check) — geometry is unchanged
  (still 10×5 `8x8_4P`); the packet plan does not depend on cabling.
- PF6 (invariant suite) — software hasn't changed between arrangements.

**Mandatory in full, exactly as arrangement #1** — recabling is exactly the
kind of change that can silently introduce a fresh Device Order conflict or
expose a broadcast-relay problem that wasn't present before. **M0/M1 (the
mapping walk) are not being re-run because the mapping might have changed —
the code doesn't know or care which physical end the controllers sit at, so a
column-boundary bug found (or ruled out) in arrangement #1 applies unchanged
to arrangement #2.** They're re-run because they are also the vehicle for
re-confirming broadcast/Device Order under the new cabling and for
re-deriving orientation from scratch — both of which genuinely can change:

- PF1, PF2 — topology and Device Order **will** be different; re-trace and
  re-read, don't assume they carried over.
- §3 (V1a–c) — the broadcast/Device-Order gate, full sequence.
- §4 (M0, M1) — full walk, both senders. If M0/M1 already found and fixed a
  mapping bug in arrangement #1, expect it to be *absent* here too (same
  code); if it's still present, that's consistent and expected, not a new
  finding — but still confirm, don't assume.
- §5, §6 (V3) — column direction, orientation. **Do not assume the
  arrangement #1 orientation value carries over, and do not assume it will be
  the simple mirror of it.** Moving the controllers to the opposite end
  plausibly changes column direction (`mirrorX`) without necessarily changing
  row direction (`rotate180` needs both axes inverted) — but this is exactly
  the kind of assumption decision 20 exists to test empirically rather than
  infer. Re-derive from scratch using §5's method.

**Optional, time permitting:**

- §6 V4 (full pattern) — worth a shorter run (10–15 s) as a final sanity
  check, not required to meet the acceptance bar.

**Record separately** in §10's blank table under the `A2-` step IDs — do not
overwrite arrangement #1's row, the point of decision 19/20 is having *both*
on record.

---

## 10. Recording format

Fill on the floor. One row per step; `Predicted` is pre-filled from above,
`Observed`/`Pass`/`Notes` are for you. Photograph the floor at every tile/corner
step regardless of what you write here — a photo answers questions this table
can't.

### Blank copy — arrangement #1

| Step | Command (key args) | Predicted | Observed | Pass? | Notes / diagnosis if not |
|---|---|---|---|---|---|
| PF1 | (physical trace) | 3 hops, link lights all present | | | |
| PF2 | (unit displays) | `01`/`02`/`03` in chain order | | | |
| PF3 | `dumpcap -D` | Ethernet, `10.200.50.0/8` | | | |
| PF4 | `mapper plan` | 20 pkt, 9700 B, 3 EOF | | | |
| PF5 | `Send-FloorTest.ps1 -DryRun` | matches PF4 | | | |
| PF6 | `unittest` / `matrix` | OK / 1056 checked | | | |
| V1a | `send --tile-col 0` | 1 tile, ctrl0 block, port 0 | | | |
| V1b | `send --tile-col 4` | 1 tile, ctrl1 block, port 0 | | | |
| V1c | `send --tile-col 8` | 1 tile, ctrl2 block, port 0 | | | |
| M0 | PS1 `-Pattern tilewalk` | 50 steps, {4,4,2} per block, no dup/dark | | | |
| M1-0..9 | `send --tile-col 0..9` | matches M0 at each column | | | |
| S-col | column direction, all 3 ctrls | consistent | | | |
| S-row | `(0,0)`→`(0,1)` | one-tile move | | | |
| Orient | derived from M0 steps 0/1/5/49 | `rotate180`/`mirrorX`/`identity` | | | |
| V3 | `send --orientation <x> --tile-col 0` | lands at chosen origin corner | | | |
| V4 | `send --pattern gradient24 --duration 30` | coherent, stable, no flash/tear | | | |

**Derived orientation, arrangement #1:** `rotate180 = ___`  `mirrorX = ___`
`reverseColumnsPerController = ___`

### Blank copy — arrangement #2 delta

| Step | Command (key args) | Predicted | Observed | Pass? | Notes / diagnosis if not |
|---|---|---|---|---|---|
| A2-PF1 | (physical trace, post-move) | 3 hops, link lights all present | | | |
| A2-PF2 | (unit displays, post-move) | `01`/`02`/`03` in chain order | | | |
| A2-V1a | `send --tile-col 0` | 1 tile, ctrl0 block, port 0 | | | |
| A2-V1b | `send --tile-col 4` | 1 tile, ctrl1 block, port 0 | | | |
| A2-V1c | `send --tile-col 8` | 1 tile, ctrl2 block, port 0 | | | |
| A2-M0 | PS1 `-Pattern tilewalk` | 50 steps, {4,4,2} per block, no dup/dark | | | |
| A2-M1-0..9 | `send --tile-col 0..9` | matches A2-M0 at each column | | | |
| A2-Orient | derived from A2-M0 steps 0/1/5/49 | `rotate180`/`mirrorX`/`identity` | | | |
| A2-V3 | orientation confirm | lands at chosen origin | | | |
| A2-V4 | (optional) full pattern | coherent, stable | | | |

**Derived orientation, arrangement #2:** `rotate180 = ___`  `mirrorX = ___`
`reverseColumnsPerController = ___`

**Session-level result:** orientation was verified in ______ (1 / 2) cabling
arrangements, and the mapping was independently confirmed in ______ (1 / 2)
arrangements. Acceptance decision 19's "more than one cabling arrangement"
clause is met only if both blocks above are filled in and both passed.

---

## Appendix — brightness/gamma (low priority, Q6)

Not blocking, not part of the acceptance bar. `PROTOCOL.md` Q6 is open:
nothing in the send path touches pixel values, so any brightness/gamma
control is controller-side or absent. If there is floor time left at the very
end of arrangement #2:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --orientation <derived> --pattern white --duration 10
```

Look at the white field and note, qualitatively, whether it looks
gamma-corrected or linear, and whether the three controllers' blocks look
uniform in brightness next to each other (a brightness mismatch between
controllers would be a controller-side setting, not a protocol issue). Record
an impression, not a measurement — no photometer is assumed. This is
explicitly not worth spending time on if the session is running long; the
acceptance bar does not depend on it.
