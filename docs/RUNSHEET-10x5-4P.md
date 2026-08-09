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

**Estimated time:** 90–120 minutes for arrangement #1 (PF1b's block map adds
10–20 minutes and is not optional), 55–75 minutes for arrangement #2's delta
(the physical move, a fresh block map, and a full re-walk).

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
the `07-tilewalk` capture (`mapper/tests/test_oracle_capture.py`,
`EXPECTED_WALK`) now pins tile columns 0–3 at row 0 and tile column 0's rows
0–4 — eight positions, on a **single-controller** capture. That capture is
**truncated**, not a full walk: 238 complete frames over 25.9 s, stopping about
0.65 s into position 8, roughly 16.7 s into a 24 s video. The three positions
that would have resolved columns 7 and 4 individually — `(7,0)`, `(7,4)`,
`(4,2)` — were never captured. **Columns 4–7 are therefore still constrained
only as a set, by `06-halves`, and nothing multi-controller — meaning columns
4–9 and every controller boundary — is constrained at all.** Assume that state
throughout.

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
`<N>`), then verify **with the same pattern arguments the send under test
used**:

```powershell
python -m mapper verify captures\session-<label>.pcapng --type 8x8_4P --cols 10 --rows 5 --orientation <same as the send> --pattern <same as the send> [--tile-col N --tile-row M]
```

Concretely, for the three shapes this session actually sends:

| Step under test | Verify arguments |
|---|---|
| V1a / V1b / V1c, M1, V3 | `--pattern tile --tile-col N --tile-row M` — the *same* `N`/`M` |
| §6 V4 | `--pattern gradient24` |
| PF1b white, appendix white | `--pattern white` |

`--orientation` must also match: `identity` for §3–§5 and for anything the PS1
sent (it applies no transform at all), `<derived>` for V3/V4. A mismatched
`--pattern` or `--orientation` produces a body-bytes failure that has nothing
to do with the floor, and reads exactly like the bug you are hunting.

> **This diagnostic cannot be applied to M0.** `verify` compares every complete
> frame in the capture against **one** expected framebuffer, and there is no
> `tilewalk` pattern in the Python CLI at all (`--pattern` accepts
> `black|blue|gradient24|green|red|white|tile`). A multi-frame walk has a
> different framebuffer per position by construction, so nothing here can check
> it and a failure would carry no information. If you need wire-level evidence
> for a specific column of the walk, re-send that one column as a static
> `--pattern tile` from Python (that is M1) and verify *that*.

Expected: `N/N complete frames byte-identical`. **Read that line, not the exit
code** — `verify` exits 0 if *any* frame matched, so a partially-correct run
looks like a pass to a script. If this **fails**, the bytes that left the
machine were already wrong — that's a bug before the network even enters the
picture. If it **passes**, the correct bytes left the machine and whatever went
wrong is downstream of the wire: a controller's own addressing/Device-Order
behaviour, the daisy chain, or orientation. This narrows the four-way ambiguity
in §0 by one, cheaply, any time you need it.

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

## 2. Pre-flight

Nothing in this section transmits **except PF1b**, and PF1b is not optional.
Its step 0 sends `--pattern white` once and the floor will light; its fallback
(steps 1–2, only if the tile chains cannot be traced by eye) sends the same
command twice more between power states.

**Run order — changed in this revision.** PF2 (the Device Order menu read) now
runs **before** PF1b, and a new gate **PF2b** sits between them:

> **PF1 → PF2 → PF2b → PF1b → PF3 → PF4 → PF5 → PF6**

PF2 was previously placed after PF1b on the grounds that it is a menu read and
needs nothing disturbed. That is still true — but PF2b needs PF1's chain counts
**and** PF2's Device Orders together, and PF2b has to run before the first
transmit, because a rig that fails it produces a PF1b step 0 that matches none
of PF1b's own branches. PF2's one dependency on PF1b is the "physical columns"
column of its table; leave that column blank on the first pass and fill it in
when PF1b is done.

**On "ground truth".** The chain **trace** in PF1b step 2 is the only evidence
in this document that owes nothing to our sender's `tile_col → (controller,
port)` arithmetic. PF1b step 0's white field and PF1b step 4's power-down
fallback both go through that arithmetic and can therefore be misread by it —
step 4 in a particularly dangerous way, because it agrees with itself and lands
on the expected answer. See the warning in step 4. Everything in §3–§6 is
written against the map PF1b produces, so the map has to be right.

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

Also record, per unit, **which physical connectors have a tile chain plugged
in, and how many chains leave each one.** Record what you see. Do not correct
anything to match an expectation:

| Unit (by chain position) | Connectors populated | Chains leaving each | Tile columns driven |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |

**Total the "chains leaving each" column across all three units before you move
on.** It must come to **10** — one chain per physical tile column. If it comes
to more than 10, at least one logical port is driving two chains and some tile
column can never be reached (see PF2b); if it comes to fewer, a column is
unpowered. Also write down, explicitly, **which chain position is the short one
— the unit with fewer than 4 chains.** PF2b is entirely about that unit and it
is the one fact this table exists to produce.

Column counts of 4 / 4 / 2 are what `PORT_COUNT_A_CONTROLLER = 4` and
`lastControlPortCount = 2` predict, and PF4/PF5 confirm the sender believes
that. **Which unit gets the 2 is not a free choice** — PF2b. The **connector**
counts are not predicted by anything:

> ⚠️ **Which physical connectors carry a `_4P` floor's four logical ports is
> nowhere established.** `PROTOCOL.md` §1 records as ✅-verified *hardware* that
> this controller has **4 physical connectors, each driving 2 chains** — 8
> chains available per unit. That is a property of the box and does not change
> because a software floor type changed. So a `_4P` unit's four ports could
> plausibly sit on connectors 1–4 (one chain each, the second chain of each
> connector idle) **or** on connectors 1–2 (both chains of each). Nothing in
> the repo settles it, and an earlier draft of this run-sheet asserted the
> first and directed you to empty chain-position-3's connectors 3 and 4. That
> directive is withdrawn — **do not unplug anything to satisfy it.**

**The connector ↔ logical-port relationship is an output of this session, not
an input.** Record the populated connectors here, record where each chain lands
in PF1b, and let M0's walk say which logical port each one turned out to be.
Write the answer into §10 and into `PROTOCOL.md` §1 afterwards.

### PF2 — Device Order on each unit

**Moved: this now runs before PF1b** (see §2's run order). It is a menu read
and disturbs nothing, and PF2b needs it.

Not queryable from software — the controller never answers a query (§2,
`PROTOCOL.md`: no ARP, no ping, no discovery, ever). Read it directly off each
physical unit's own display/menu. Record which physical unit — by chain
position from PF1 — reports which order. Leave the "physical columns" column
blank for now and fill it in after PF1b:

| Chain position | Chains (PF1) | Device Order shown on unit | Work mode shown | Physical columns (fill after PF1b) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

**§3 requires that the three values are distinct and all lie in `01`–`03`.**
Whether they run `01`/`02`/`03` *in chain order* is a convenience, not a
requirement: nothing in `PROTOCOL.md` or the decompiled source says the Master
must sit at chain position 1, and byte 1 carries the order, not the position.
If they are distinct but out of chain order, record it and carry it forward
into §3's predictions.

> ⚠️ **One exception to "don't fix it to look tidy", and it is not cosmetic.**
> Which unit holds the **highest** order is *not* free — it is bound to that
> unit's chain count by PF2b below. An earlier draft of this section told you to
> carry any distinct-but-unordered arrangement forward untouched; that was wrong
> for exactly one of the six arrangements. Read PF2b before deciding this table
> is finished.

If any value is duplicated, or outside `01`–`03`, fix it now, on the unit,
before any transmit step. Also record each unit's **work mode**: a unit in
Sound/DMX/Auto rather than the mode the other two are in will not render our
frames at all, and reads as an absent unit in §3.

> Two things this table assumes and does not prove, both of which §3 and PF2b's
> D3 probe can turn into findings: that Device Order `0k` corresponds to byte 1
> = `k−1`, and that the daisy chain relays broadcast regardless of which unit is
> Master. Neither is established anywhere in this repo.

This table plus PF1b is the ground truth §3 relies on to tell a Device Order
problem apart from everything else — if either is wrong, every downstream
diagnosis in this document is unreliable.

### PF2b — Port coverage: does every populated chain have packets to render?

**No transmission. Paper only, from PF1's chain counts and PF2's Device Orders.
Five minutes. It must be done before the first send.**

This gate is new and nothing before it substitutes for it. It catches a rig
that is powered, cabled, relayed, holds three distinct in-range Device Orders,
passes §3 cleanly, passes PF1b's power-down fallback cleanly — and **still
cannot light more than 8 of its 10 columns, on any pattern, ever.** Every other
gate in this document silently assumes that the tile chains a unit physically
has and the logical ports its controller index actually receives are the same
set. They are not automatically the same set.

#### The mechanism

The last controller does not get a full set of ports. `mapper/floors.py`'s
`ports_on()` gives it `tile_cols % ports_per_controller` = `10 % 4` = **2**, and
`tools\Send-FloorTest.ps1` computes the identical thing (`$portsHere = $rem`).
`mapper plan` (PF4) shows it directly — controller 2 has four packets, not
eight, and they are ports 0 and 1:

```
 16    2    0    0   0x00   512        0
 17    2    0    1   0x01   458      507
 18    2    1    0   0x00   512        0
 19    2    1    1   0x81   458      507
```

**No packet is ever emitted for ports 2 or 3 of controller 2.** A chain plugged
into those ports on the unit holding that controller index is not dim, not
mis-mapped, and not late — it receives nothing, for the whole session.

So a unit lights exactly the columns in `S ∩ {0 … ports_on(c) − 1}`, where `S`
is the set of logical ports its populated chains sit on and `c` is the
controller index its Device Order selects. Nothing anywhere reports the
difference.

#### The rule, in general form

Let `P` = the floor type's ports per controller (**4** for `8x8_4P`), `C` = tile
columns (**10**), `N = ceil(C/P)` = controllers (**3**), and
`L = C mod P`, or `P` when that is zero (**2**). The sender emits ports
`0 … P−1` for controller index `i < N−1`, and ports `0 … L−1` for `i = N−1`.

> **The floor fills if and only if, for every unit, the set of logical ports its
> populated chains occupy is *exactly* the prefix `{0 … ports_on(c) − 1}` that
> its own controller index carries, and the `N` controller indices are
> distinct.**

For this rig that is three checkable facts:

1. **Chain counts are `{P, P, …, L}` = `{4, 4, 2}`** as a multiset, and total
   `C` = 10. Two units with 3 chains each is not a legal 10-column rig no matter
   what the menus say.
2. **The short unit — the one with `L` chains — holds the highest Device Order,
   `0N` = `03`.** The other `N−1` units hold `01` and `02`, in either order.
3. **The short unit's chains sit on the connectors that are logical ports
   `0 … L−1`** — here ports **0 and 1**, not any other pair. Which connector is
   which logical port is PF1's open question; if you cannot answer it yet, D3
   below answers it for the only unit that matters.

When `C mod P == 0` the rule is **vacuous** — every controller carries a full
set and any assignment works. That is why nothing before this rig could have
exposed it: the 8×5 oracle floor was a single controller, and the invariant
suite checks that pixels land at *unique* slots, never that every populated
chain is *covered*.

**Corollary — one chain per port.** Total chains must equal `C`. If a unit
drives two chains from one logical port (PF1's connector question, hypothesis
"2 connectors × 2 chains **mirrored**"), then the ports in use total fewer than
`C`, and some tile columns are unreachable by construction. On this rig,
mirroring and full coverage are mutually exclusive. Record it as a hardware
fact, and expect a dark run in M0.

#### The check

Compute, per unit, `min(chains, ports_on(order − 1))` with `ports_on = (4, 4,
2)` — assuming chains sit on the low connectors; if they don't, use the
intersection instead. Sum it. **The sum must be 10.**

| Chain position | Chains (PF1) | Device Order (PF2) | Controller index | Ports carried | **Columns it can light** |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| | **10** | distinct, `01`–`03` | | | **total must be 10** |

**If the total is less than 10, stop and fix it here.** The fix is at the menu
in almost every case: swap the Device Orders of the short unit and whichever
unit currently holds `03`. No cable moves, no power-down, 30 seconds. Only if
the short unit's chains are on the *wrong connectors* does a cable move
(§1 — power down first).

**Rigs that pass every other gate in this document and still cannot fill:**

| Chains 1/2/3 | Orders 1/2/3 | Lights | Why every other gate misses it |
|---|---|---|---|
| 2 / 4 / 4 | `01`/`02`/`03` | **8** | Tidiest possible rig: clean PF1, clean PF2, in chain order. `03` is on a 4-chain unit, so 2 of its chains never receive. |
| 4 / 4 / 2 | `03`/`01`/`02` | **8** | Distinct and in range, so old PF2 said "carry it forward". `03` is on a 4-chain unit again. |
| 4 / 4 / 2, short unit on ports **2,3** | `01`/`02`/`03` | **8** | Chain counts and orders both correct; the short unit's two chains and the two ports it receives **do not intersect**, so it renders nothing at all, ever, on any pattern — and that is indistinguishable at the floor from a relay failure. See §7. |

#### D3 — which Device Order actually selects the last controller index

Run this when PF2b's paper check cannot be completed — you don't yet know which
connector is which logical port, or you want the `0k ⇒ k−1` assumption tested
rather than assumed. Three menu changes, three sends, **no cable touched**.
Unlike PF1b's power-down fallback it cannot confirm its own expectation,
because what it reads is a *count of lit columns on one unit*, not a region of
floor whose extent you already believe you know.

Use **chain position 1** — reachable from the PC with no relay hop — and only
if PF1 says it has a full `P` = 4 chains (if it doesn't, use whichever unit
does; it must still be one you can watch). For each order `01`, `02`, `03`:

1. Set it to an order that carries a **full** port set (`01` or `02`) and send
   `--pattern black --duration 1`. **Do not skip this.** A chain that receives
   no data holds its last latched frame, and without the clear you will read a
   stale white column as a live one.
2. Set it to the value under test.
3. Send `--pattern white --duration 10` and count, **while the sender is still
   running**, how many of *that unit's own* columns are lit. Ignore the rest of
   the floor — the other units may be duplicating content and it does not
   matter here.

**Predicted, if `0k ⇒` controller index `k−1`:** `01` → 4 columns, `02` → 4,
`03` → **2**.

| Observed | What it establishes | Next |
|---|---|---|
| Exactly one order lights `L` = 2 columns, the other two light 4 | The port-coverage arithmetic is confirmed on real hardware, and **that order is the one selecting the last controller index**. The short unit must hold it. | If PF2 has it elsewhere, swap the two units' orders at the menu and redo PF2b. |
| …and that order is `03` | Additionally consistent with `0k ⇒` byte 1 = `k−1` — the convention PF2 flags as unestablished anywhere in the repo. This is the cheapest evidence for it the session can produce. | Record as a finding (§8). |
| …but that order is `01` or `02` | **The Device-Order ↔ controller-index convention is not `k−1`.** Major finding. | Photograph the menu; re-state every PF2/PF2b/§3 prediction against the observed correspondence before continuing. Nothing in §3–§6 is interpretable until you do. |
| All three orders light the same count, or two of them light 2 | The correspondence is not one-to-one over `01`–`03`, or the unit does not have the chain count PF1 recorded. | Re-check PF1's count for that unit first. If PF1 is right, record as a finding and escalate — do not proceed on an assumed correspondence. |

### PF1b — Reference frame and the physical block map

**Everything downstream depends on this step and nothing downstream can
substitute for it.** Chain position does *not* determine which tiles a unit
drives; the tile-chain cabling does, and that is a free choice made at load-in.
A floor cabled middle → left → right is perfectly healthy and would put
chain-position-1's block in the *middle* of the floor. Without this map, every
"the unit lit the wrong block" branch below is unusable: a benign cabling
choice and the exact code bug this session exists to find produce the identical
observation.

#### 1. Fix a reference frame, and photograph it

Pick one edge of the floor and name it. Suggested wording, adapt to the room:

> *Standing at the controller end, facing the floor: the leftmost tile column
> is **P1**, the rightmost is **P10**. The tile row nearest me is **R1**, the
> row furthest from me is **R5**.*

**Take the photograph from that standing position**, with something in shot
that fixes the viewpoint (the controllers, a doorway, a taped arrow on the
floor). Write the sentence you chose into §10.

From here on, every "left", "right", "up", "down", "near", "far", every corner
name and every predicted block in this document means a `P`/`R` coordinate
against that photo. There are 4 corners × 2 handednesses = 8 mutually
consistent ways to read "+x moves right, +y moves down" off an unlabelled
floor; the photo is what collapses them to one. §5 is not derivable without it.

**Also declare the intended origin now:** logical `(0, 0)` shall be the tile at
**(P1, R1)**, logical `+x` shall run P1 → P10, logical `+y` shall run R1 → R5.
That choice is free, but it must be made *before* §5 rather than fitted to the
result, or §5 has no answer to produce.

#### 2. Record the block map

Trace each tile chain from the connector it leaves to the physical column it
enters, and fill in all ten rows:

| Chain position | Connector | Chain (if the connector drives 2) | Physical column |
|---|---|---|---|
| 1 | | | P__ |
| 1 | | | P__ |
| 1 | | | P__ |
| 1 | | | P__ |
| 2 | | | P__ |
| 2 | | | P__ |
| 2 | | | P__ |
| 2 | | | P__ |
| 3 | | | P__ |
| 3 | | | P__ |

Then write down the three **blocks** as sets of physical columns, e.g.
"position 1 → {P5,P6,P7,P8}, position 2 → {P1,P2,P3,P4}, position 3 →
{P9,P10}". Every prediction in §3–§6 is stated against these sets.

A block whose columns are **not contiguous**, or a {4,4,2} split that does not
land on column boundaries, is a legitimate thing to find and is not by itself a
fault — record it and carry it forward. It does mean the walk in §4 will not
look like three tidy left-to-right runs, and §5's derivation needs care.

#### 3. Step 0 — the white baseline. Run this whether or not you traced the chains

**This is the first transmit of the session and the cheapest gate in the
document.** ~30 seconds. All three units powered, Ledset fully closed.

> ⚠️ **Black first, and read the floor while the sender is still running.** A
> controller holds its last latched frame, so whatever the floor was showing
> when you walked in is still there and a silently failed white send reads as a
> lit floor. And the third branch below is a **flicker** verdict — the one
> observation in this document that cannot be made after the sender exits,
> because what you are looking at then is a still frame by definition. Each
> command prints `sending to 255.255.255.255:60001 at 10 fps for 10.0s` and then
> exits; make the observation inside that window.

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
```

Confirm the floor is fully dark. If it is not, you are looking at a held frame
or a unit that ignores our packets — resolve that before the white send, or
every reading below is of something else.

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern white --duration 10
```

**Predicted:** all 50 tiles white — **provided PF2b's column total came to 10.**
If PF2b totalled less than 10, predict that number of lit columns instead, and
go fix PF2b rather than running this.

**Why white is a good reachability gate, stated precisely.** Every controller
index carries white, so a Device Order collision does not by itself darken
anything: two units sharing an order both render white, and the floor still
fills. But a collision *can* darken the floor indirectly, by moving a four-chain
unit onto the index that only carries two ports. The correct statement is:

> **A collision never darkens a column by itself. What darkens columns is a unit
> whose populated ports are not covered by the ports its controller index
> carries — PF2b.** White is immune to a collision **only while no four-chain
> unit holds `03`.**

| Chains 1/2/3 | Orders 1/2/3 | Columns lit |
|---|---|---|
| 4 / 4 / 2 | `01`/`01`/`03` — two collide | 4 + 4 + 2 = **10, fills** |
| 4 / 4 / 2 | `02`/`02`/`02` — three-way | 4 + 4 + 2 = **10, fills** |
| 4 / 4 / 2 | `03`/`02`/`03` | 2 + 4 + 2 = **8, does not fill** |
| 4 / 4 / 2 | `03`/`03`/`03` | 2 + 2 + 2 = **6, does not fill** |
| 2 / 4 / 4 | `01`/`02`/`03` — no collision at all | 2 + 4 + 2 = **8, does not fill** |

So a *full* white floor still answers the relay question on its own, and that
inference is sound. What is **not** sound is the converse: a floor that is not
full is not evidence of a relay or Device Order fault until PF2b is clean.
Therefore —

- **All 50 lit** → every unit is receiving frames *and* latching them *and*
  holds a Device Order in `01`–`03` *and* every populated chain is covered.
  **Broadcast relay through the daisy chain is proven for this cabling** — this
  is the finding `PROTOCOL.md` §1 and Handoff 1 §8 have both been waiting for.
  Record it; §3's dark branches can then stop considering relay at all, and
  §7's relay abort becomes unreachable.
- **Part of a block dark** — some columns of one unit lit, others dark, with
  the unit plainly powered and its neighbours fine; or **fewer than 10 columns
  lit with every unit showing something** → **this is the port-coverage
  signature, and it is not a code bug and not an abort.** Go back to **PF2b**
  now. Count the lit columns per unit and compare each against PF1's chain
  count for that unit: the unit lighting fewer columns than it has chains is the
  one whose Device Order is wrong. Check that the short unit holds `03`; if a
  four-chain unit holds `03`, swap the two orders at the menu (30 seconds, no
  cable) and re-send. If the counts still don't reconcile, run **D3** — the
  `0k ⇒ k−1` convention may be the thing that is wrong, not the cabling.
- **A whole block dark** → that unit is not receiving, is not powered, is not
  latching, holds a Device Order outside `01`–`03`, **or its populated chains
  and the ports its controller index carries do not intersect at all** (PF2b's
  third failing rig: two chains on connectors that are ports 2 and 3, holding
  `03`). That last case renders nothing on any pattern for the whole session and
  is indistinguishable here from a relay failure — **PF2b and D3 must both be
  clean for that unit before §7's relay abort is even reachable.** Otherwise
  resolve it via §3's decision procedure, D1/D2. The fallback below cannot run
  until the baseline is clean.
- **A block flickering rather than lit** → this is the `CAPTURE_RESULTS.md` Q2
  "unlatched" signature, and a full white field is the *only* pattern on which
  it is diagnosable, and only *live* — see the warning above. See V1c.

Leave the floor in a known state afterwards:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
```

#### 4. Empirical fallback, if the chains can't be traced by eye

~10 minutes, no cable is moved. It re-sends the same white command above
between power states.

> ⚠️ **This fallback is *not* independent of our sender's arithmetic, and an
> earlier draft claimed it was.** What goes dark when you cut a unit's power is
> not that unit's block — it is `block ∩ ports its controller index carries`.
> Under PF2b's first failing rig (chains 2/4/4, orders `01`/`02`/`03`), powering
> down position 3 darkens **2** columns and this step tells you to write "2
> columns, position 3" — the exact number it predicted — while position 3
> actually drives **4**. The recorded map is then `{2,4,4}` read as `{4,4,2}`,
> and every §3–§6 prediction downstream is stated against a map that is wrong in
> a way nothing later can detect. **The check in bold below is what stops it
> confirming its own expectation. Do not skip it.**

> **After every step below: compare the number of newly-dark columns against
> PF1's *chain count* for the unit you just powered down.** They must be equal.
> If the dark region is **smaller** than the chain count, some of that unit's
> chains were already dark before you cut the power — a port-coverage failure,
> go back to **PF2b** and **D3**. The fallback map is wrong; fix the coverage,
> re-run step 0, and start the fallback again. If coverage is confirmed clean
> and the counts still disagree, **only an eye trace (step 2 above) will do** —
> record the fallback map as unusable and trace the chains.

**Power only** — use each unit's own power switch or supply. **No data cable is
touched at any point in PF1b**, so §1's hot-swap rule is not in play.

**Step 1.** Power down chain position 3 only. Re-send. The region that goes
dark is position 3's block *as far as it is being driven*. Expect a number of
columns equal to **PF1's chain count for position 3** — 2 on a correctly bound
rig, and 4 if position 3 is the four-chain unit. Not "expect 2".

**Step 2.** Power position 3 back up, and power down chain position **2 only**.
Re-send. Predicted: positions 2 *and* 3 are both dark — position 3 is powered
but can only be reached through position 2. The region that is newly dark
relative to step 1 is position 2's block; expect **PF1's chain count for
position 2**. The region still lit is position 1's block; expect PF1's chain
count for position 1.

(Powering 2 and 3 down together gives the same block map, but step 2 as written
costs nothing extra and additionally confirms the daisy-chain topology PF1
traced. **If position 3's block stays lit with position 2 powered down**, the
chain is not the order PF1 recorded — the units may be on a switch rather than
daisy-chained, or the hops are in a different order. Re-trace PF1 before
continuing: §3's relay reasoning depends on that order being right.)

Fill in the block sets above from what you saw, then power everything back up
and re-run step 0 to confirm you are back to 50 lit.

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

**Predicted:** `OK`, **no failures and no errors** — do *not* pin the test
count; it grows as the suite does (36 on 2026-08-07, 33 when this sheet was
first drafted). A changed count is not a finding. Then, from `matrix`:

```
1056 legal configurations checked across supported floor types
10,779,648 pixels placed, every one at a unique wire slot
```

Not required every session, but cheap (about 20 s for the suite, a few seconds
for `matrix`) and rules out an unrelated regression before you're standing on
the floor. Per §0, a green run here says nothing new about the
controller-placement question — that's the whole point of this session.

---

## 3. First verify step — broadcast, Device Order, or a swapped block

**Prerequisite: PF1b.** Every prediction in this section is stated as a
physical column set from PF1b's block map, against PF1b's reference photo. If
PF1b is not filled in, stop and fill it in — without it, a benign cabling
choice and the exact code bug this session exists to find are the same
observation, and you will escalate the wrong one.

Handoff 1 §8 flags broadcast propagation through the daisy chain as unproven:
pure broadcast, no addressing beyond byte 1, so if `OUTPUT`→`INPUT` doesn't
relay it, controllers 2 and 3 never see a frame — a hardware limit, nothing to
do with our code. A mis-set Device Order can produce an equally silent,
non-error failure. And now — per §0 — a wrong `tile_col → (controller, port)`
mapping in the sender can *also* put a lit tile on the wrong physical block,
with no error either. All three need pulling apart.

Note that **PF1b step 0 has already answered the relay question** if it lit all
50 tiles: `--pattern white` fills the floor whatever the Device Orders are, so
a full white floor means every unit receives and latches. This section is
therefore mostly a Device-Order and first-port test, and its abort branch
should never fire on a rig whose PF1b baseline was clean.

(§4 goes further — every column, every port, both senders. This section is
the cheap first gate: three quick sends, one per controller's **first port
only**, to catch the coarse cases immediately. A subtler bug confined to a
non-zero port would pass here and get caught in §4 instead — that's a known,
accepted gap in this section by itself, not in the session as a whole.)

### How to read §3 — run all three sends first, diagnose once

**Do not diagnose after V1a.** No single send can identify the fault here, and
the previous draft of this document aborted the session on observations that
are a two-second menu fix. Run V1a, V1b and V1c, record the whole triple, then
apply the procedure below **once**.

**A controller holds its last latched frame.** Between the three sends the
floor keeps showing whatever the previous send lit, so a silently failed send
reads as a duplicate. Send black between them, and read the floor **while the
sender is still running** (each command prints `sending to
255.255.255.255:60001 at 10 fps for 8.0s` and then exits):

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
```

**Read the whole floor after each send, not just the block you're targeting.**
Record, in PF1b's `P`/`R` coordinates:

| Send | byte 1 | tiles lit | physical column(s) lit | block(s), per PF1b |
|---|---|---|---|---|
| V1a `--tile-col 0` | `0x00` | | | |
| V1b `--tile-col 4` | `0x01` | | | |
| V1c `--tile-col 8` | `0x02` | | | |

#### The mechanism, in full

Every controller receives every packet of every frame — pure broadcast, filtered
locally by byte 1 — and a unit holding Device Order `0k` acts on byte 1 = `k−1`
and ignores the rest. So for one send:

- Each participating unit renders **at most one tile** (one byte-1 value, one
  port index, one chain).
- If **two units share** a Device Order, both render the same content onto
  their own chains: the same lit tile in two different blocks, at the same
  relative position, simultaneously.
- Every collision therefore **orphans** a byte-1 value that no unit is
  configured for, and the send addressing an orphan **lights nothing.** With
  three units and three values, a two-way collision produces one dark send and
  a three-way collision produces two.

**Dark is not a synonym for "broadcast isn't reaching that unit".** It is the
normal signature of a Device Order fault, and the previous draft's routing of
every dark cell to §7 was wrong. The five patterns worth naming:

| Device Orders on positions 1/2/3 | V1a | V1b | V1c |
|---|---|---|---|
| `01`/`02`/`03` — healthy | 1 tile | 1 tile | 1 tile |
| `01`/`01`/`03` — two collide | **2 tiles** | **dark** | 1 tile |
| `02`/`02`/`02` — three-way | **dark** | **3 tiles** | **dark** |
| `01`/`02`/`04` — one out of range | 1 tile | 1 tile | **dark** |
| `01`/`02`/`03`, relay not forwarding past hop 1 | 1 tile | **dark** | **dark** |

Note the third row: a three-way collision makes **V1a itself dark**. That is
the first transmit step of the session, and it is a menu fix, not an abort.

#### Step 1 — count

Let **T** = the total number of tiles lit across all three sends, and let **r**
= the number of tiles one participating unit lights per send. **Determine `r`
before you count anything**: it is 1 under PF1's connector hypothesis A (four
connectors, one chain each) and also under hypothesis B read as four ports on
two connectors; it is **2** only if a connector's two chains *mirror* one
logical port, which shows up as two tiles lit at the same relative position
**inside one block**. Look for that first. Then:

> **U = T / r** is the number of units that are (i) receiving frames, (ii)
> latching them, (iii) holding a Device Order in `01`–`03`, **and (iv) have a
> populated chain on logical port 0 of the controller index that order
> selects.**

Condition (iv) is new and is not cosmetic. §3 sends tile-cols 0, 4 and 8 —
port 0 of each controller, and nothing else. A unit whose chains are on ports 1
and 2, or on ports 2 and 3, is fully live and lights columns under `white`, yet
contributes **nothing** to any of these three sends. Every "dark" cell below
therefore has one more explanation than the table used to admit, and **PF2b is
what excludes it.** (This also assumes each unit is in its expected work mode
and `Floor Mir64` profile — a unit in Sound/DMX/Auto will not render our frames
at all and counts as absent.)

If `r` = 2, note that on this rig it is *arithmetically impossible* for all ten
tile columns to be reachable — 10 chains driven by 5 logical ports means 5 tile
columns are never emitted anywhere. See PF2b's corollary; expect dark runs in
M0 and record it as a hardware finding.

If **PF1b step 0 lit all 50 tiles**, U must be 3 (so T = 3, or 6 if `r` = 2) and
**broadcast relay is already proven for this cabling** — §7's relay abort is
unreachable from §3 and every dark send below is a Device Order fault. That is
the expected case. Note the direction of that inference: all-50-lit ⇒ relay
proven is sound, but *not*-all-50-lit does **not** imply a relay or Device Order
fault until PF2b is clean.

**In the table below, read every count as units' worth: "1 tile" means `r`
tiles, "2 tiles" means `2r`, and the `T` column is `U`.**

#### Step 2 — route on the triple

| T | Shape | Verdict | Action |
|---|---|---|---|
| 3 | 1 / 1 / 1, three different blocks | All three orders distinct, all three units live. | Go to step 3 (the block check). |
| 3 | one send lights **2**, one lights 1, one dark | **Two-unit Device Order collision.** Relay is fine — all three units answered something. | On *one* of the two blocks that lit together, set the unit's Device Order to the orphaned value (the dark send's `0x0N` → order `0(N+1)`). Re-run PF2, re-run §3. **No abort.** |
| 3 | one send lights **3**, two dark | **Three-way collision.** Relay is fine. | Set two of the three units to the two orphaned values. Re-run PF2, re-run §3. **No abort.** |
| 2 | 1 / 1 / dark, two different blocks | One unit is not participating: order outside `01`–`03`, unpowered, not latching, wrong work mode, or not receiving. | **D1**, then **D2**. |
| 2 | one send lights **2**, two dark | A two-unit collision **and** a third unit not participating. | Fix the collision as above, then **D1**/**D2** for the remaining orphan. |
| 1 | 1 / dark / dark | Two units not participating. If PF1b step 0 was clean, they were live minutes ago — suspect Device Order or power, not relay. If PF1b step 0 also showed them dark, relay-at-hop-1 is the leading hypothesis. | **D1**, then **D2**. |
| 0 | all three dark | **Not a per-unit fault** — three independent units do not fail at once. | Check Ledset is fully closed; check `--local-ip` against PF3; confirm the command actually ran (read its console output, not the floor); re-run PF1b step 0. If `--pattern white` still lights all 50 but no `--pattern tile` send lights anything, the fault is in pattern generation, not addressing — run §0's diagnostic with `--pattern tile --tile-col 0 --tile-row 0`. |
| any | 2 or more tiles lit **inside one block** | Not a collision — a collision puts its duplicates in *different* blocks. One unit is driving two chains from one logical port, or two chains are cabled to the same column. | Record it against PF1b: this is the `_4P` connector question in PF1 (4 connectors × 1 chain vs. 2 connectors × 2 chains). It is a hardware/cabling fact to write down, not an abort. |

#### Step 3 — the block check (only meaningful once T = 3, 1/1/1)

For each send, was the lit tile in the block belonging to the unit whose PF2
Device Order matches that send's byte-1 value?

- **All three match** → **pass for §3.** Note carefully what this does and does
  not prove: it proves the three byte-1 values reach three *different* units,
  each at that unit's first active port. It does **not** prove
  `tile_col → (controller, port)` for any column other than 0, 4 and 8, and it
  does not check which physical column within a block is port 0 — that is M0's
  job, and PF1's connector↔port question is still open until then.
  **It also cannot see a port-coverage failure at all.** PF2b's first failing rig
  — chains 2/4/4, orders `01`/`02`/`03` — gives T = 3, shape 1/1/1, three
  different blocks, and a block check agreeing with PF2 on all three, while two
  of its ten columns are permanently dark. §3 only ever addresses port 0. **A
  clean §3 is not evidence that the floor can fill; PF1b step 0's lit-column
  count and PF2b are.**
- **Three different blocks, but not the ones PF2 predicts** (a permutation) →
  before reaching for a code bug, note that the convention **Device Order `0k`
  ⇒ byte 1 = `k−1`** is itself unverified anywhere in this repo; its only
  support is `PROTOCOL.md` §1's "`Device Order` 01/02/03…, first = Master". A
  clean permutation of three blocks is far better explained by that convention
  being different (e.g. 1-based, or Master not being order `01`) than by
  `divmod`. Re-read PF2 in person, photograph each unit's menu, and record the
  observed order↔byte-1 correspondence as a **finding**. Only if PF2 and the
  observed permutation are consistent with each other and still disagree with
  the code is this a mapping bug.
- **One block wrong, two right** → candidate mapping bug for that column. Do
  not conclude it from one sender: run the same `--tile-col` through both
  Python and the PS1 (§4, M1) first. Both landing on the same wrong block →
  shared/conceptual bug; only one → specific to that implementation.

#### D1 — the orphan probe (the cheap disambiguator; needs no relay)

Whenever a send is dark and step 2 sent you here, **do this before anything
else.** It costs one menu change and one send, and it separates a sender-side
fault from an addressing fault with no ambiguity.

Chain position 1 is reachable directly from the PC — no hop, no relay. So:

1. Write down chain position 1's current Device Order.
2. On its own menu, set it temporarily to the **orphaned** value — the Device
   Order corresponding to the dark send's byte 1 (`0x00`→`01`, `0x01`→`02`,
   `0x02`→`03`). No cable is touched, so no power-down is needed.
3. Re-send that same dark command (`--tile-col 0`, `4` or `8` respectively).

| Result | What it establishes | Next |
|---|---|---|
| **One tile lights, in position 1's block** | For that byte-1 value the sender emits correct, latchable packets, and a unit that receives them renders them. The orphan is **not** a sender bug, **not** an EOF/latch defect for that controller group, and **not** a relay failure at hop 0. What remains is: no *receiving* unit is configured to that value. | Restore position 1's Device Order, re-read PF2, go to **D2**. |
| **Still dark** | The fault is common to every unit for that byte-1 value: those bytes are wrong, never sent, or never latch. This is **not** Device Order and **not** relay. | Run §0's diagnostic against this exact command. If `verify` passes, the bytes were right and the fault is the controller's handling of that group — for byte 1 = `0x02`, that is precisely the EOF-on-port-1 risk in V1c, and D1 is the cleanest test of it there is, because it puts controller 2's packet group on a directly-reachable unit you can watch. Restore the Device Order and escalate to pair A with the failing controller index. |

#### D2 — which unit is missing

With position 1 restored, identify the block that never lit across all three
sends. Go to that physical unit and, in this order:

1. **Is it powered?** Is the link light on its `INPUT` lit, and on the upstream
   unit's `OUTPUT`?
2. **What Device Order does its own menu show?** Photograph it. Anything
   outside `01`–`03` — `04`, `00`, blank — is the orphan. **Fix it on the menu,
   re-run PF2 and re-run §3. No abort.**
3. **What work mode is it in?** Anything other than the mode the other two are
   in will not render our frames.

4. **Do its chains and its ports intersect?** Re-read **PF2b**. A unit whose two
   chains sit on the connectors that are logical ports 2 and 3, while its Device
   Order selects the last controller index, receives **no packet on any port it
   has a chain on** — the sender never emits ports 2 or 3 for controller 2 at
   all. It renders nothing, on any pattern, for the entire session. It is
   powered, linked, in the right work mode, holds a distinct in-range order, and
   D1 lights on position 1 — so it satisfies every other condition below and is
   *indistinguishable at the floor* from a relay failure. It is a five-minute
   recable (§1 — power down first), not an abort. **Run D3 if you cannot settle
   the connector↔port question on paper.**

Only if all three units are powered, linked, in the same work mode, and show
three *distinct* Device Orders in `01`–`03`, **and PF2b is clean for that unit
— its populated chains sit on ports its controller index actually carries**,
**and** D1 lit, **and** PF1b step 0 also shows that unit's block dark, is this a
genuine relay failure. That is the only route into §7's relay abort. Record
which hop: a missing position 3 with a live position 2 is hop 2; positions 2 and
3 both missing is hop 1.

### V1a — controller 0

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 0 --duration 8
```

**Predicted:** one tile, **in the block PF1b assigned to the unit PF2 records
as Device Order `01`**, at row R1 or R5 (row direction is §5's business, not
this section's). Write down the physical column, e.g. `P5`.

### V1b — controller 1

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 4 --tile-row 0 --duration 8
```

**Predicted:** one tile, in the block PF1b assigned to the unit holding Device
Order `02`. Write down the physical column.

### V1c — controller 2 (partial — only 2 ports, EOF on port 1 not port 3)

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 8 --tile-row 0 --duration 8
```

**Predicted:** one tile, in the two-column block PF1b assigned to the unit
holding Device Order `03`. Write down the physical column.

> Which of a block's columns is "first" is **not** predicted here. That depends
> on which physical connector carries logical port 0, which PF1 has now made an
> *output* of this session rather than an assumption. All §3 predicts is *which
> block*. M0 resolves within-block order.

This column carries one extra risk specific to being the *partial* one: its
end-of-frame flag lands on **port 1**, not port 3 like the other two (PF4 —
packet index 19). Every prior confirmation that the EOF flag latches a frame
(`CAPTURE_RESULTS.md` Q2) was on a controller with a full complement of ports,
where the flag always sits on the highest-numbered one. If chain-position-3's
firmware has any assumption that the frame-end flag arrives on a fixed
"last" port regardless of how many are actually active, it may never latch.

**The dark-versus-flicker discriminator is not observable with `--pattern
tile`.** The Q2 "unlatched" signature — illumination beginning at the far end
of each chain, dead pixels near its boundary, and 5–10 *coloured* pixels at
that boundary in an all-white frame — was recorded on a **full white** frame.
With one lit tile out of fifty there is nothing for a partial blit to reveal: a
controller that never latches and a controller that is dead look identical.
**So if V1c is dark, do not diagnose it from V1c.** Re-send white and read
*that*:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern white --duration 10
```

Watch only the block PF1b assigns to the unit that failed. (If PF1b step 0 was
run, you have this observation already — reuse it rather than re-sending.)

| White-field observation for that block | Diagnosis | Next |
|---|---|---|
| Block lights cleanly white | The unit receives and latches. V1c's darkness was **not** a latch or relay problem — it is Device Order (that unit is not on `03`) or a controller-2 content bug. Go to §3's D1/D2; do **not** escalate an EOF finding. | D1, then D2. |
| Block dark, steady, no flicker at all | Not latching *and* not blitting. Consistent with the unit never receiving a packet — but only after D1 and D2 have excluded Device Order, power, link and work mode. | §3 D1 → D2 → §7 relay abort, in that order. |
| Sporadic partial flicker, illumination starting at the far end of each chain, dead and **coloured** pixels at the boundary | The `CAPTURE_RESULTS.md` Q2 unlatched signature, on the one pattern that can show it. Packets are arriving and being accepted; the frame never completes from this unit's point of view. This is the EOF-on-port-1 risk. | Confirm with §3's **D1** — set chain position 1 to Device Order `03`, then send `--pattern white --duration 10`. As controller 2 it receives only ports 0–1, so expect **two** of its columns white and the other two dark; that is still enough white area to show or exclude the flicker signature, and `--pattern tile` is not. If position 1 also fails to latch, the EOF-on-port-1 defect is firmware-general and is a genuinely new finding (no partial controller has ever existed on this rig). If position 1 latches cleanly, the defect is specific to that one unit, which is a different and much cheaper finding. Record both units' behaviour, restore the Device Order, and hand it to pair A. Do not attempt a fix on the floor. Controllers 0 and 1 are unaffected — continue. |

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

Walks all 50 tiles, one at a time, 2 s each (~100 s nominal), column-major:
tile-col 0 rows 0→4, then tile-col 1 rows 0→4, … through tile-col 9. It
prints `tile (col=N, row=M)` to the console as it steps — **film the floor**
so the video and the console log together give the complete map in one pass.
Film the console in the same frame if you can, or clap once at the start so the
audio can be aligned afterwards; the log alone has no timestamps you can trust
to ±2 s.

(The PS1 paces to a 100 ms absolute target with catch-up. Measured on
`captures/20-ours-white.pcapng`, which is this same script, its actual frame
intervals ranged **34–126 ms** around a 97.6 ms mean. Over a 2 s hold that is
invisible, but do not treat the step boundaries as exactly 2.000 s apart when
scrubbing the video.)

**Predicted.** Split into two criteria, because they need different evidence
and fail for different reasons:

**(a) Trace-free — no cable trace needed, checkable from the video alone.**

1. Exactly one tile lit at any moment; exactly one *new* tile every ~2 s.
2. Over the whole walk, **all 50 physical tiles light exactly once** — no
   skips, no repeats, no dead tile, no dead column.
3. Each consecutive run of 5 steps lights **one complete physical column** —
   all five rows of a single column, and nothing outside it. (This is the
   strong one. It says the tile-row axis really is the port-payload axis, with
   no transposition and no interleaving between columns.)
4. The row direction inside a run is **the same for all ten runs** — all five
   steps ascending, or all five descending, never mixed.
5. The ten runs occupy **ten distinct physical columns**.

Any failure of 1–5 is a real defect and needs no interpretation against
anything physical. This is strictly stronger than "no skips, no repeats": it
also kills transposition, interleaving and any mapping that does not group the
floor into whole 5-tile columns.

**What (a) cannot catch:** a *permutation* of the ten columns. Every
permutation still lights 50 tiles once each in ten clean vertical runs. Only
PF1b can distinguish a permutation from cabling.

**(b) Trace-dependent — needs PF1b's block map.**

6. Runs 1–4 all land inside the block PF1b assigns to the unit holding Device
   Order `01`; runs 5–8 inside `02`'s block; runs 9–10 inside `03`'s. Block
   sizes {4, 4, 2}, matching `PORT_COUNT_A_CONTROLLER = 4` and the partial
   third controller.
7. Within each block, note the physical column each run landed on **in order**.
   That is the connector ↔ logical-port map PF1 left open — an **output** of
   this session. Write it into §10.

**The common case, and why it is not the criterion.** If PF1b shows the three
blocks in physical order along the long axis *and* each unit's connectors
cabled to its columns in port order, then (a)+(b) together produce the tidy
picture: ten runs advancing monotonically P1→P10 (or P10→P1 throughout), with
visible block joins after the 4th and 8th run. **Expect that, but do not
require it.** A rig cabled middle → left → right produces a non-monotone walk
on entirely healthy hardware and correct code, and PF1b is what tells the two
apart. See §7.

- The four points needed for orientation are specific steps in this same walk
  — no extra transmission needed (see §5): step 0 = `(0,0)`, step 1 = `(0,1)`,
  step 5 = `(1,0)`, step 49 = `(9,4)`. Note the physical tile at each in PF1b's
  `P`/`R` coordinates, ideally with a timestamped photo.

| Observed | Diagnosis | Next |
|---|---|---|
| (a) 1–5 all hold, and (b) 6 matches PF1b with {4, 4, 2} | **Pass.** Mapping confirmed for all 10 columns via one sender. Record the within-block column order from (b) 7 — that is the connector↔port finding. | Continue to M1 for the cross-implementation check. |
| **(a) 2 or (a) 5 fails: one or more whole 5-step runs is dark** (no tile lights at all for an entire ~10 s interval), and/or fewer than 10 distinct physical columns light across the whole walk | **Port-coverage failure — PF2b. Not a controller-boundary bug, not a code bug, and not an abort.** A dark 5-step run means the sender addressed a `(controller, port)` that no populated chain is listening on; a permanently dark physical column means a populated chain is on a port the sender never emits. On this rig the classic instance is chains 2/4/4 with orders `01`/`02`/`03`: tile-cols 2 and 3 give ten consecutive dark steps, and the `03` unit's third and fourth chains never receive, so 8 columns light and 40 tiles. | Go to **PF2b**, then **D3** if the paper check won't close. Fix at the menu (swap the short unit onto `03`) or by moving that unit's chains to the first connectors (§1 — power down first), then re-run PF1b step 0 and this walk. **Do not escalate to pair A** and do not read the {4,4,2} row below until every column lights. |
| (a) holds **with all 50 tiles lit and all 10 columns distinct**, but a block's run count is not 4 / 4 / 2 against PF1b's blocks | **Controller-boundary bug** — precisely the "controller placement above 8 columns" risk flagged in §0. Record which block and the count observed. **Check the dark-run row above first**: a coverage failure produces a wrong-looking run count too, and it is a menu fix rather than a code bug. | Escalate to pair A with the exact step numbers where the boundary landed wrong. Do not patch this with orientation flags — it is not an orientation problem. |
| (a) holds, blocks are {4, 4, 2}, but the blocks are visited in a different physical order than left-to-right | **Not a bug by itself.** Check PF1b: if the cabling groups the columns that way, this is a cabling fact — record it and carry on. Only if PF1b says the blocks should have been elsewhere is it a mapping bug. | §7, third bullet. |
| (a) 5 holds but the columns *within* one block are visited out of order — not reversed, scrambled (e.g. the block's columns come up 2nd, 4th, 1st, 3rd) | **A port permutation inside one controller.** `reverseColumnsPerController` cannot express this — it only reverses. Either that unit's connectors are cabled to its columns out of order (a cabling fact: record it in PF1b/§10, it is the answer to PF1's connector question), or `port = tileCol % ports` is wrong for that unit (a code bug). PF1b's trace is the only thing that decides which. | If PF1b traced the chains, compare directly and record the verdict. If PF1b used the empirical fallback (which resolves blocks, not columns within a block), you cannot decide it here — record the observed order as the connector↔port map and flag it as unverified against a trace. |
| (a) 3 fails — a 5-step run spans two physical columns, or lights fewer/more than 5 distinct tiles | Transposition or interleaving: the tile-row axis is not the port-payload axis on this rig. Nothing downstream is meaningful. | Stop and escalate to pair A. Do not attempt orientation flags — `mapper/orientation.py` offers no transpose, deliberately (`PROTOCOL.md` §4.4). |
| One 2 s interval is dark, walk resumes correctly after | Possible dropped frame/packet, or an EOF/latch hiccup at that specific boundary. Note the exact `col=/row=` printed at that moment. | Re-run the walk once. Reproducible at the same column → treat as a real per-column defect, not noise; investigate that column specifically. One-off, non-reproducible → note it, don't over-conclude from a single miss. |
| Two tiles lit simultaneously at some step, in **different** blocks | Device Order collision, surfaced independently of §3 (a second chance to catch it, or evidence it's intermittent). | Note which two blocks; re-check PF2 on both; re-run §3's decision procedure. |
| Two tiles lit simultaneously at some step, in the **same** block | Not a collision. One logical port is driving two chains, or two chains are cabled to the same column — the `_4P` connector question from PF1. | Record against PF1b. Cabling/hardware fact, not an abort. |
| Row order inconsistent within one tile-col's run relative to others ((a) 4 fails) | See §5 — this is the `reverseColumnsPerController`-adjacent risk, not a column-boundary bug. | Continue to §5's explicit check. |

### M1 — Python cross-check, all 10 columns at row 0

> ⚠️ **A controller holds its last latched frame.** Ten back-to-back sends with
> nothing between them means the floor is *never dark*, so a silently failed
> send leaves the previous column's tile lit and reads as a duplicate or as a
> mapping bug. **Every send below is preceded by a black frame**, and the
> observation must still be made **while the sender is running** — each command
> prints `sending to 255.255.255.255:60001 at 10 fps for 6.0s` and then exits,
> and what you see after it exits is a held frame, not a live one.

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 1 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 2 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 3 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 4 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 5 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 6 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 7 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 8 --tile-row 0 --duration 6
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 9 --tile-row 0 --duration 6
```

Equivalent compact form, if you would rather film one continuous 70 s run than
step through it — it prints the column label to the console before each send,
so the video and the log align the same way M0's do:

```powershell
foreach ($c in 0..9) {
    python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
    Write-Host "=== M1: tile-col $c ===" -ForegroundColor Cyan
    python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col $c --tile-row 0 --duration 6
}
```

**Predicted:** for each `N`, the *same* physical tile M0's `tile-col=N,
row=0` step showed (step `5N` of the M0 walk), and a fully dark floor for one
second between each pair.

This is the comparison described in §0: neither sender applies an
orientation transform here, both were run on the same hardware in the same
session, so any per-column disagreement between the two is a real
implementation bug, isolated to whichever one doesn't match the M0
observation (which itself should match PF1b's block map).

| Observed | Diagnosis | Next |
|---|---|---|
| All 10 match M0, and the floor goes fully dark between each | **Pass.** Both independent implementations of `tile_col → (controller, port)` agree with each other and with the physical floor, for every column. This is the strongest evidence this session can produce that the mapping is correct. | Continue to §5. |
| One or more columns disagree between Python and the PS1 | Confirmed sender-side bug, not hardware — pinpointed to whichever tool disagrees with M0 and PF1b's block map for that column. | Stop treating the mapping as verified for that column (and be suspicious of neighbouring ones). Escalate to pair A with the specific `tile-col` values and both observed physical columns. |
| Both agree with each other but *neither* matches M0's own earlier observation for that column | Possible transient (loose connector, one dropped frame) rather than a mapping bug — a real bug would reproduce identically since nothing in the code differs between sends. | Re-run just that one column on both senders; if it now matches M0, treat the first M0 reading as noise and note it; if it still disagrees, treat as a live mapping bug per the row above. |
| A black step does **not** darken the floor | The failure is in the *black* send, not the tile send — and it means every observation in this section was of a held frame. | Stop. Re-run PF1b step 0 and §3. Do not record any M1 row taken under this condition. |

---

## 5. Orientation and the reverse-columns risk — derived from the walk

**No new transmission needed if M0 (§4) was filmed/logged.** Read the
physical tile observed at M0's steps 0, 1, 5, and 49 (`(0,0)`, `(0,1)`,
`(1,0)`, `(9,4)`) — these are the four corner observations from
`CAPTURE_RESULTS.md` Q1's method, adapted to this rig's actual extent (max
tile-col **9**, max tile-row **4**, not 7/4 — this floor is wider than the
historical one).

**This derivation is only possible against PF1b's reference frame.** The origin
corner and the viewing direction between them admit 4 corners × 2 handednesses
= **8** mutually consistent readings of "+x moves right, +y moves down" off an
unlabelled floor, of which the previous draft of this table named 3. PF1b fixes
both: the photo fixes the viewpoint and the `P`/`R` labels, and PF1b §1 already
declared the intended origin as **(P1, R1)**, `+x` toward P10, `+y` toward R5.
With those declared, the answer is forced rather than chosen.

Only `identity`, `mirrorX`, `rotate180` and `rotate180+mirrorX` are reachable
(`PROTOCOL.md` §4.4 — 90°/270° are physically excluded because
`port = tileCol % PORT_COUNT` binds tile columns to the port axis). Note what
the fourth one is: in `orientation.py`, `rotate180` flips both axes and
`mirrorX` then flips x back, so **`rotate180+mirrorX` is a pure y-flip**. It is
the "y inverted, x not" case the previous table had no cell for.

M0 and M1 both send with **`--orientation identity`** (the PS1 has no transform
at all), so what you observed *is* the untransformed wire mapping. Read two
directions off it, in `P`/`R` coordinates:

- **`+x`**: from the tile at `(0,0)` to the tile at `(1,0)` — does the physical
  column index **P increase or decrease**?
- **`+y`**: from `(0,0)` to `(0,1)` — does the physical row index **R increase
  or decrease**?

| `+x` under identity | `+y` under identity | Identity puts logical (0,0) at | **Orientation value to use** |
|---|---|---|---|
| P increasing | R increasing | (P1, R1) | `identity` |
| P **decreasing** | R increasing | (P10, R1) | `mirrorX` |
| P increasing | R **decreasing** | (P1, R5) | `rotate180+mirrorX` |
| P **decreasing** | R **decreasing** | (P10, R5) | `rotate180` |

That value is a **session output**. Write it into §10 and into
`mapper/orientation.py`'s comment block afterwards — it is the answer decision
19 asks for, and there is no other step that produces it.

`(9,4)` must land diagonally opposite `(0,0)`; if it doesn't, see the M1
table above — that's more likely a per-column mapping issue on column 9
(controller 2's *second* port, otherwise only touched by M0 itself) than an
orientation error, since orientation is a single floor-wide transform and
wouldn't put just one corner out of place while the rest of the walk was
clean.

> **Two things whole-tile observations cannot decide.** (1) `mirrorX` reverses
> tile columns across the *whole floor* (0…9 → 9…0) while
> `reverseColumnsPerController` reverses them *within each group*
> (0–3→3–0, 4–7→7–4, 8–9→9–8). Those are different permutations, so M0's walk
> does distinguish them — but only if you check the block joins, not just the
> ends. (2) `mirrorX` also mirrors pixels *inside* each tile, and a lit whole
> tile cannot show that. Nothing in §3–§5 can. §6 V4's `gradient24` is the only
> step in this document that could, and only by eye.

**If M0/M1 weren't filmed clearly enough to read these four points**, fall
back to four dedicated sends. Black between them, for the reason in M1:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 0 --duration 8
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 1 --tile-row 0 --duration 8
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 0 --tile-row 1 --duration 8
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern tile --tile-col 9 --tile-row 4 --duration 8
```

### The reverse-columns risk

`orientation.py`'s `reverseColumnsPerController` flag is **global** — if set,
it reverses port order inside *every* controller's group simultaneously.
There is no way, in the current code, to reverse only one controller's
internal cabling while leaving the other two alone. Check M0's column
direction *within each block separately* — tile-col 0→1 vs. 4→5 vs. 8→9, in
`P` coordinates, all already part of the same walk, no extra commands needed.
"Direction" here means the sign of the change in physical column index within
that unit's block, which is only defined once PF1b says which columns the block
contains:

| Observed | Diagnosis | Next |
|---|---|---|
| All three controllers' column direction agrees | **Pass** — a single `reverseColumnsPerController` value (true or false) correctly describes this whole rig. | Continue to §6. |
| One controller's column direction is opposite the other two | **The current orientation model cannot represent this rig.** Applying the flag would fix the odd one out and break the other two, or vice versa. | Record exactly which controller (by chain position). Not fixable at the floor — needs either a recable of that one controller's chain (§1 power-down procedure) or a code change to make the flag per-controller (escalate to pair A). Do not proceed to declare orientation "determined" for this rig until one of those happens. |

---

## 6. Confirm the derived orientation, then run the full pattern

### V3 — confirmation

Re-send `(0,0)` with the orientation value derived in §5 applied, and confirm
it now lands on the tile PF1b declared as the origin — **(P1, R1)**:

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --pattern black --duration 1
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --orientation <derived> --pattern tile --tile-col 0 --tile-row 0 --duration 8
```

`<derived>` is a `+`-joined combination of the four tokens the CLI accepts —
`identity`, `rotate180`, `mirrorX`, **`reverseColumnsPerController`** — the
last of which is the one §5 spends a subsection deriving and which the previous
draft of this list omitted. Confirm the spelling against the CLI itself:

```powershell
python -m mapper send --help
```

(the top-level `python -m mapper --help` does *not* list the orientation
tokens; only the sub-command's help does). An unrecognised token raises
`unknown orientation token` and sends nothing, so a typo fails loudly rather
than transmitting the wrong transform.

| Observed | Diagnosis | Next |
|---|---|---|
| Lands on (P1, R1) | **Pass — orientation determined for arrangement #1.** | Record it (§10), continue to V4. |
| Still wrong | The transform derived from §5 doesn't reproduce §5's own observations — arithmetic error in deriving `<derived>`, not a new hardware fact. Re-derive, don't guess. | Fix and re-run V3 before continuing. |

### V4 — full pattern at a nominal 10 fps

```powershell
python -m mapper send --type 8x8_4P --cols 10 --rows 5 --local-ip 10.200.50.78 --orientation <derived> --pattern gradient24 --fps 10 --duration 30
```

**Predicted:** a smooth, spatially coherent 80×40 image across the whole
floor for the full 30 s — no missing region, no visibly duplicated block, no
seam at any controller boundary. By this point every column has already been
individually confirmed (§4), so this step is a holistic sanity check, not a
first look — a mismatch here after a clean §3–§5 would itself be an
unexplained row, worth stopping on rather than shrugging off.

> **`--fps 10` is a request, not a measured rate.** Do not predict clean 10.0
> fps pacing and do not read jitter as a finding. Measured 2026-08-07 on
> `captures/20-ours-white.pcapng` — which is `Send-FloorTest.ps1`, using the
> same absolute-target sleep loop as `mapper/sender.py` — frame intervals
> ranged **34 ms to 126 ms** around a 97.6 ms mean (**10.24 fps**), with a
> cluster at 91–97 ms and a tail past 110 ms. Ledset itself averages
> **9.15–9.20 fps** (mean interval 108.7–109.3 ms, whole distribution 101–116
> ms) and is the *steadier* of the two. The Python sender's own on-the-wire
> pacing has never been measured at all; if you want that number, this is the
> run to capture, and it is a free by-product of §0's diagnostic.

**Scope note on the two vendor defects:** this command sends one **static**
framebuffer repeatedly — there is no video clip and therefore no loop
boundary for the "two black frames per loop" defect to occur at. This step
does **not** exercise that specific defect; it is not testable with the
current CLI (no media playback yet), and that gap should stay recorded as
such, not silently claimed as covered. The torn-frame defect (`SendData`'s
missing locking) is excluded by construction here — the whole buffer is built
in Python before any packet is sent, so there is no concurrent writer to race
against — but that's a code-level argument, not an empirical one; for direct
evidence, capture this run (§0's universal diagnostic, **with `--pattern
gradient24`** — the framebuffer is static and identical every frame, so
`verify` applies cleanly here) and confirm every frame is
`packets_per_frame`-complete with no header gaps.

| Observed | Diagnosis | Next |
|---|---|---|
| Coherent image, stable for 30 s | **Pass.** Session core is done for arrangement #1. | |
| A whole controller's block is missing/dark | One of §3/§4's controllers has stopped responding, or a duplicate Device Order re-appeared under sustained load (thermal/power issue). | Re-run §3's V1a–V1c triple and its decision procedure to re-localise. |
| A block shows a shifted/duplicated version of another block's content | Same duplicated-content signature as §3 — Device Order collision, possibly intermittent. Under `gradient24` a collision is unmistakable: two blocks show *identical* colour, which the per-pixel-unique pattern otherwise never produces. | Re-check PF2 for a loose/marginal setting; re-run §3. |
| Periodic black flash | The frame is static, so this is not content. Two candidates: the send loop's pacing (see the jitter note above — a 126 ms interval is within measured normal and is *not* a finding), or a controller failing to latch some frames. | Capture and inspect frame intervals before concluding anything. A flash that recurs on a period unrelated to the send interval, or that is confined to one block, is the interesting one — escalate that. Ordinary jitter is not. |
| Visible tear line, unstable over time | Contradicts the double-buffer-by-construction argument above. | Capture and run `mapper verify --pattern gradient24 --orientation <derived>`; if verify passes (bytes were correct) the defect is on the controller/floor side, not the sender. |

---

## 7. Abort and safety criteria

> **What is *not* an abort.** A dark send is not, by itself, an abort — it is
> the ordinary signature of a Device Order fault and §3's decision procedure
> fixes three of its five named patterns on a controller menu in under a
> minute. A block lighting somewhere you didn't expect is not, by itself, an
> abort — PF1b decides that. An earlier draft routed both straight here, which
> would have ended the session on the first transmit step of a rig with a
> three-way Device Order collision. **Work the §3 procedure to the end, and
> PF1b's map, before reaching for anything below.**

**Stop and do not continue** if any of the following occur:

- **A genuine broadcast-relay failure.** All of the following must hold before
  this counts: §3's **D1** probe lit (so the sender's bytes for that byte-1
  value are correct and latchable); **D2** found the unit powered, linked, in
  the expected work mode, and showing a distinct Device Order in `01`–`03` on
  its own display; **PF2b is clean for that unit** — its populated chains sit on
  logical ports its controller index actually carries, confirmed by trace or by
  **D3**; and **PF1b step 0**'s white field also leaves that unit's block dark.
  Only then is broadcast genuinely not reaching it.
  **The PF2b condition is not a formality.** A two-chain unit cabled to the
  connectors that are logical ports 2 and 3, holding Device Order `03`, receives
  nothing on either chain — controller 2's packets exist only for ports 0 and 1
  — and it satisfies all four of the other conditions simultaneously. Aborting
  the session on it would end the run over two plugs moved one connector across. That is a
  hardware/topology limitation outside our code — acceptance for the
  multi-controller geometry cannot be claimed with it unresolved. Escalate; do
  not attempt a software workaround (per decision 18, nothing added to the PS1;
  per §5, the current orientation model has no per-controller fix either).
- M1 finds a Python/PS1 disagreement on any column. Both are wrong-or-right
  together on raw mapping; a disagreement means neither can be trusted until
  resolved, and nothing built on top of that column (orientation, full
  pattern) can be trusted either.
- M0 finds a controller-boundary count that doesn't match {4, 4, 2}, measured
  **against PF1b's block map**. This is a code bug, not a floor problem, and
  everything past that boundary is suspect until fixed.
  **A boundary in an unexpected *place* is not this.** If PF1b shows the
  cabling groups the columns that way — a floor cabled middle → left → right,
  say — then a walk that jumps blocks in that order is a **cabling fact to
  record in §10, not an abort**. The abort is for a boundary that falls where
  PF1b says it should not have, or for block sizes that are not {4, 4, 2}.
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

- PF1b's reference frame photographed, and the 10-row block map recorded (by
  trace / by the power-down fallback — circle one): **yes / no**
- **PF2b port coverage**: chain counts `{4, 4, 2}` totalling 10, the two-chain
  unit holding `03`, its chains on logical ports 0–1, and PF1b step 0 lighting
  all ten columns: **yes / no**. If "no", nothing below is interpretable —
  §3 passes, M0 reports a boundary bug, and both are artefacts.
- M0 pass criterion (a), **trace-free**: 50 tiles once each, ten 5-tile
  single-column runs, consistent row direction, ten distinct columns:
  **yes / no**
- M0 pass criterion (b), **trace-dependent**: block sizes {4, 4, 2} landing on
  PF1b's recorded blocks: **yes / no**
- Mapping (`tile_col → (controller, port)`) cross-confirmed via M1 against the
  PS1 on all 10 columns: **yes / no**
- Broadcast reaches all three controllers (PF1b step 0 lit all 50, or §3's
  D1/D2 resolved it), disambiguated from Device Order and from a mapping bug:
  **yes / no**
- Device Order collision-free across all three units, at the time of testing:
  **yes / no**
- `reverseColumnsPerController` consistent across all three controllers (not
  needed per-unit): **yes / no**
- Orientation determined and confirmed by V3: **value: _______**

**Outputs this session produces that nothing else can** — record these even if
every line above is "yes":

- The connector ↔ logical-port map for a `_4P` unit: connector ______ = port 0,
  ______ = port 1, ______ = port 2, ______ = port 3, and whether each populated
  connector carries **1 or 2** chains. `PROTOCOL.md` §1 records 4 connectors
  each physically driving 2 chains; which of them a `_4P` floor type uses has
  never been established.
- The observed Device Order ↔ byte-1 correspondence (is `01` really byte 1 =
  `0x00`?). Also never established.
- Whether the EOF flag latches when it lands on **port 1** of a partial
  controller. First rig that can answer it.

If any line is "no," the acceptance bar in decision 19 is not met yet — do
not report the session as a pass with an asterisk; report exactly which line
failed and what §3–§7's diagnosis branch said to do about it.

---

## 9. Arrangement #2 — attempted 2026-08-08, abandoned by explicit user override

**Do not run this section.** Decision 20 (requiring a second cabling
arrangement) is amended; decision 19's acceptance bar no longer needs it. The
floor is cabled left-to-right, monotonically, always — see §10's closing
note for what was found and why the user closed this off rather than fixing
it in code. The rest of this section is kept as a historical record of what
the attempt required and found; skip straight to §10 for arrangement #1's
completed findings.

---

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

- PF1, PF2, **PF2b**, **PF1b** — topology, chain counts, Device Order and port
  coverage **will** be different; re-trace and re-read, don't assume they carried
  over. **PF2b especially**: a full recable is the single most likely way to end
  up with the four-chain unit on `03`, and the resulting 8-lit-column floor
  looks like a mapping regression that arrangement #1 did not have. **PF1b is
  the one that matters most here**: moving the controllers to the opposite end
  changes which unit drives which physical columns, and every §3–§6 prediction
  is written against that map. Keep arrangement #1's reference frame and its
  `P1…P10` / `R1…R5` labels **unchanged** — the floor did not move, only the
  controllers did, and re-labelling the floor would make the two arrangements
  incomparable. Re-photograph anyway, from the same standing position.
- §3 (V1a–c) — the broadcast/Device-Order gate, full sequence, including the
  decision procedure over the whole triple.
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

**Every `Observed` cell below is a physical column `P1`…`P10` and row
`R1`…`R5`, against PF1b's reference photo.** "Left", "the ctrl0 block" and
"the first column" are not answers.

### Reference frame — arrangement #1

**Reference sentence:** standing at the controller end, facing the floor:
leftmost tile column = P1, rightmost = P10; nearest row = R1, farthest = R5.

**Declared origin:** (P1, R1). `+x` toward P10, `+y` toward R5.

**Block map** (PF1b §2, traced by cable, not the power-down fallback):

| Chain position | Device Order (PF2) | Connectors populated | Chains each | Physical columns |
|---|---|---|---|---|
| 1 (ctrl01) | `01` | 1, 2 | 2, 2 | P1–P4 |
| 2 (ctrl02) | `02` | 1, 2 | 2, 2 | P5–P8 |
| 3 (ctrl03) | `03` | 1 | 2 | P9–P10 |

**Connector ↔ logical port** (from M0's within-block order, strictly
ascending P1→P10 throughout): **connector 1 = ports 0, 1; connector 2 =
ports 2, 3** — established once, per-unit, applies to all three controllers.

### Arrangement #1 — filled

| Step | Command (key args) | Predicted | Observed | Pass? | Notes / diagnosis if not |
|---|---|---|---|---|---|
| PF1 | physical trace | 3 hops, link lights all present | 5 connectors populated ({2,2,1}), chain counts {4,4,2} total 10 | ✅ | |
| PF2 | unit displays | 3 distinct orders in `01`–`03` | `01`/`02`/`03`, distinct | ✅ | Ctrl1 found in **Auto** mode mid-session (user test) — reverted to **IR**, its working mode, before any transmit. Auto/Sound/DMX render nothing; not the same bug class as a Device Order fault. |
| PF2b | paper: PF1 chains × PF2 orders | short unit (`03`) on ports 0–1; column total = 10 | ctrl03/`03` has 2 chains, `min(2,2)`=2; ctrl01/02 `min(4,4)`=4 each; sum = 10 | ✅ | |
| PF1b-0 | black, then white 10s, read live | floor dark, then all 50 tiles lit | dark, then all 50 lit for the full 10 s | ✅ | **New hardware fact:** ctrl1 (Master/IR unit) times out ~5 s after packets stop and reverts to local content (black in IR mode, an SD-card preset in Auto); ctrl2/ctrl3 hold their last frame indefinitely. Read any post-send state within ~2 s or ctrl1 misreads as dark. |
| PF3 | `dumpcap -D` | Ethernet, `10.200.50.0/8` | Ethernet, `10.200.50.78/8`, interface 8 | ✅ | |
| PF4 | `mapper plan` | 20 pkt, 9700 B, 3 EOF at idx 7/15/19 | exact match | ✅ | |
| PF5 | `Send-FloorTest.ps1 -DryRun -PortsPerController 4` | matches PF4 | row-for-row identical | ✅ | |
| PF6 | `unittest` / `matrix` | `OK` / 1056 checked | `OK`, 38 tests; 1056 configs, 10,779,648 px | ✅ | |
| V1a | `send --tile-col 0` | 1 tile, in `01`'s block | P1, R1 | ✅ | |
| V1b | `send --tile-col 4` | 1 tile, in `02`'s block | P5, R1 | ✅ | |
| V1c | `send --tile-col 8` | 1 tile, in `03`'s block | P9, R1 | ✅ | |
| V1-T | total across the triple | 3 | 3, shape 1/1/1, all match PF2 | ✅ | Confirms `0k ⇒ byte1=k−1` directly on hardware. |
| M0-a | PS1 tilewalk, trace-free | 50 once each, ten 5-tile runs, one row direction, ten distinct columns | exact — strictly P1→P10, each R1→R5 ascending | ✅ | |
| M0-b | same run, against PF1b | blocks {4,4,2} on PF1b's columns | exact match | ✅ | |
| M1-0..9 | `send --tile-col 0..9`, black between | matches M0; dark between each | all 10 matched, dark between each (final tile held — no trailing black in the loop, expected) | ✅ | |
| S-col | column direction within each block | consistent across all 3 | ascending in all 3, no reversal at either block join | ✅ | |
| S-row | `(0,0)`→`(0,1)` | one tile, R changes by 1 | R1→R2 | ✅ | |
| Orient | §5 table, from M0 steps 0/1/5/49 | one of the four | `+x` increasing, `+y` increasing → `identity` | ✅ | |
| V3 | `send --orientation identity --tile-col 0` | lands on (P1, R1) | P1, R1 | ✅ | |
| V4 | `send --pattern gradient24 --duration 30` | coherent, stable, no flash/tear | coherent, stable 30 s; one apparent anomaly explained below | ✅ | A patch read as an odd blue block at R4/P8–P10. **Not a fault** — `gradient24`'s red channel is `(tile_row*10+tile_col)*7+1 mod 256`, which wraps exactly once across the floor, at tile index 37 = row R4, column P8 (253→4). Confirmed by location match. Pattern artifact, not a mapping defect; left as-is since the pattern's job is byte-uniqueness for verification, not visual smoothness. |

**Derived orientation, arrangement #1:** `rotate180 = false`  `mirrorX =
false`  `reverseColumnsPerController = false`  → `--orientation identity`

### Arrangement #2 — attempted, abandoned (see §9)

Physical relocation completed; PF1 (block map), PF2 (orders/modes
unchanged), PF2b (sum=10, passes), PF1b-0 (all 50 lit) and §3's V1a–c triple
(P9/R1, P5/R1, P1/R1 — all match PF2) **all passed** under the new cabling.
§4's M0 walk surfaced the reason the session stopped there:

**Block map, post-move:**

| Chain position | Device Order | Connectors populated | Chains each | Physical columns |
|---|---|---|---|---|
| 1 (ctrl01) | `01` | 1, 2 | 2, 2 | P7–P10 |
| 2 (ctrl02) | `02` | 1, 2 | 2, 2 | P3–P6 |
| 3 (ctrl03) | `03` | 1 | 2 | P1–P2 |

M0's within-block walk order: `P9,P10,P7,P8` (ctrl01), `P5,P6,P3,P4`
(ctrl02), `P1,P2` (ctrl03). Each connector's own pair is still ascending
(same per-unit hardware convention as arrangement #1 — connector 1 = ports
0,1, connector 2 = ports 2,3, reconfirmed), but **block-level, connector 1's
pair now sits above connector 2's pair** — inverted from arrangement #1,
where connector 1's pair sat below connector 2's. That is a pair-swap
(rotate-by-2), not a reversal, and it is consistent across both full
controllers (ctrl01 and ctrl02 agree; ctrl03 has only one pair and is
uninformative either way).

**Finding:** none of `identity` / `mirrorX` / `rotate180` /
`rotate180+mirrorX` / `reverseColumnsPerController` can express a
per-controller pair-swap — the flag only reverses a block's port order, it
cannot rotate it. §5's orientation derivation was not completed for
arrangement #2 for this reason, not because of a code bug: PF1b's trace
makes this unambiguously a cabling fact (connector 1's chain happened to
reach the nearer sub-pair to the controller's new position, which is the
*farther* pair from the origin corner after the move), matching the
"port permutation inside one controller" row of §4's M0 decision table and
the "current orientation model cannot represent this rig" row of §5's
reverse-columns-risk table.

**Resolution — explicit user override, 2026-08-08, on the floor:** rather
than either recable (swap connector 1↔2 on both full controllers) or extend
`orientation.py` to support an arbitrary per-controller port permutation,
the user closed the question directly: **the floor is always cabled
left-to-right, monotonically, matching arrangement #1's convention.** Any
future content-orientation need (a flipped video, a mirrored show) is
handled at the media-authoring step, not in the floor mapper. Arrangement #2
testing is abandoned; decisions 19 and 20 in `HANDOFF-ddf-geometry.md` are
amended accordingly. The floor was powered down and reconfigured back to
arrangement #1's layout before the session ended.

**Session-level result:** orientation was verified in **1** cabling
arrangement (the only one the amended decision 19 now requires), and the
mapping was independently confirmed in that same arrangement across every
column, both senders, zero unexplained rows. **Gate 4 is met.**

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
