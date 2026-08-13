# The wiring diagram, as Ledset draws it

**What this is.** A written specification of how the vendor's mapper window
renders its controller/power/floor diagram, recovered from
`decompiled/LedSet.decompiled.cs` on 2026-08-12. It exists so PR 3 can build the
same diagram without reinventing its layout, and without anyone re-reading the
decompiler output.

**The rule this file obeys.** `decompiled/README.md` says decompiler output is
reference only and that nothing may be pasted from it into a deliverable —
describe behaviour instead, which is what `docs/DECOMP_FINDINGS.md` does for the
wire protocol. This file does the same for the diagram. Every number below is a
measurement of observed behaviour, written down; none of it is transliterated
source.

**What it is not.** It is not a source of truth about topology. How many
controllers there are, which ports they use and which packets go where comes
from `python -m mapper plan`, which is hardware-graded. The vendor's own
controller count is rederived below only because it agrees, and the agreement is
worth recording.

---

## 1. The one idea worth copying

Everything else in the vendor's mapper is unremarkable. This is not.

Between the controller row and the floor there are up to four wires per
controller running in parallel, and drawn naively they overlap into a hairball
exactly where the operator needs to read them. The vendor solves it by giving
each wire a **drop height indexed by its port number within the controller**: a
wire leaves its source, drops a distance that depends only on `port index mod
4`, runs horizontally at that height, then drops into its destination. Four
ports therefore travel at four different heights and cross nothing.

The same index also picks the wire's colour, from a fixed four-colour cycle. So
port 0 of every controller is the same colour at the same height, port 1 is the
next, and so on — which makes the diagram readable *across* controllers as well
as within one.

Two runs are drawn per port, each with its own stagger:

| Run | Drop height by port index `i` |
|---|---|
| Power supply → controller | `60 − 10i` — so 60, 50, 40, 30 |
| Controller → floor edge | `70 + 10i` — so 70, 80, 90, 100 |

The two staggers run in **opposite directions**, which is the detail that makes
it work: the upper bundle fans one way and the lower bundle fans the other, so
the two never share a horizontal line even where a controller sits directly
above its edge.

**Unused ports are simply not wired.** The wire loop runs once per *floor edge*,
not once per port, so a controller whose ports are only partly used draws its
full set of four port circles and receives fewer wires. On our rig that is
literally controller 3, which uses two of its four ports — the diagram shows the
two spare sockets, unwired, which is exactly what an operator sees when they
look at the physical box.

## 2. The layout model

All distances are diagram pixels, and the model is built from the floor
description alone: tile type, tile columns, tile rows.

**A tile is a 45 × 45 square.** That is the diagram's unit and everything else
is expressed in it.

| Quantity | How it is derived |
|---|---|
| Ports per controller | 4 for a `_4P` type, 8 for an `_8P` type |
| Controller count | `ceil(tileColumns / portsPerController)` |
| Controller band width | `170 × controllerCount` — each unit is a 90-wide power supply plus an 80-wide controller |
| Floor band width | `45 × tileColumns` |
| Canvas width | `max(controllerBand, floorBand) + 50` |
| Content height | `162 + 45 × tileRows` |
| Canvas height | `contentHeight + 50` |

Three anchor points follow:

- **Controller row** sits at `x = (canvasWidth − controllerBand) / (controllerCount + 1)`,
  vertically centred in the leftover height. Dividing by `controllerCount + 1`
  rather than `controllerCount` is deliberate — it makes the left margin equal to
  the gutter between controller groups, so the row reads as evenly spaced rather
  than as a block shoved left.
- **Edge strip** sits 150 below the controller row, horizontally centred on the
  floor band.
- **Floor grid** starts 12 below the edge strip — the height of one edge
  element — and shares its x.

Within the controller row, each group is laid out power-then-controller, and the
advance after each group re-adds the initial gutter, which is what keeps the
spacing uniform.

The canvas background is a dark neutral grey. We will not copy the colour; the
design system has its own.

## 3. The elements

| Element | Size | What it carries |
|---|---|---|
| Power supply | 70 × 40 | The word `Power`, and four sockets |
| Controller | 80 × 50 | A `Controller N` label across the top, and four sockets |
| Floor edge, small | 45 × 12 | One tile column's feed |
| Floor edge, large | 90 × 12 | Two tile columns' feed |
| Tile | 45 × 45 | One tile |

Sockets are 10-wide circles on a 15 pitch: the power supply's four start at
`(7.5, 24)` from its own corner, the controller's four at `(12, 30)`. **A wire
attaches to the centre of a socket**, and a floor edge attaches at its
**top-centre** — an edge exposes one attachment point regardless of its width.

Controllers are numbered from a counter that is reset before each redraw, so
they are numbered left to right starting at 1. Ours must do the same: the
diagram's `Controller 1` has to be the operator's leftmost box, because
`CLAUDE.md` records that controller 1 is the Master/IR unit and the one that
reverts to vendor content when packets stop.

**How many edges there are depends on the type.** For a `_4P` type it is one
small edge per tile column — one connector feeds one column. For `_8P` the edges
are wide and cover two columns each, with the odd column out taking a small edge.
Our rig is `8x8_4P` and takes the first path; the `_8P` path is described here
for completeness and is **not** something PR 3 needs to get right.

## 4. Where the tile-to-pixel mapping lives

Each tile in the grid carries its own origin in **floor pixels**, accumulated as
the grid is laid out: advancing one tile to the right adds the type's pixel width,
finishing a row adds the type's pixel height. Clicking a tile in the vendor's
mapper reports that origin and the tile's pixel size to the rest of its
application.

That is the mechanism our derived readout wants, and it is worth taking: the
diagram should know, per tile, which floor pixels it is. It is also the check on
our own arithmetic, since the same numbers must fall out of `mapper plan`.

## 5. What our version keeps, and what it does not

**Keep**

- The staggered drop heights and the port-indexed colour cycle. This is the whole
  reason to read the vendor at all.
- The derivation chain: type and tile counts in, controller count and layout out.
  Nothing else is an input.
- Controllers numbered left to right from 1, and unused ports drawn but unwired.
- Per-tile floor-pixel origins.

**Change**

- **Colours come from the design system**, not from the vendor's red / green /
  light blue / yellow. The four-way cycle is the idea; those four values are not.
- **Sizes become tokens.** The 45-pixel tile and the 170-pixel controller pitch
  are a starting ratio, not a spec. Mockup 1a's proportions win where they
  disagree.
- **Layout is a computed model, rendered declaratively**, rather than absolute
  margins assigned during a draw call. The vendor's draw method mutates a
  position as it walks; ours should produce a plain description — controllers,
  edges, tiles and wires with their coordinates — that a component renders and a
  test can assert against without a DOM.

**Add, because the vendor has none of it**

- **Hover highlighting.** Mockup 1a lights a connector's two tile columns when
  the connector is hovered. The vendor has no hover behaviour at all — it has a
  click that reports a tile's pixel rectangle, and nothing else. This is our
  design, and the mockup is its only specification.
- **The derived readout.** Metres, feet, tile count, packets and bytes per frame.

**Drop**

- The power supply row, unless it earns its place. The vendor draws power
  supplies because its mapper configures them. Ours describes a floor whose
  power is not our problem, and half the wires in the diagram exist only to reach
  those boxes. Mockup 1a shows controllers and tile columns, with no power row —
  **follow the mockup**, and note that dropping it also removes the upper of the
  two staggered bundles. The stagger still matters for the bundle that remains.

## 6. What the vendor does not answer

- **Cabling order.** The diagram assumes controllers run left to right in
  ascending order, and so does our rig — `CLAUDE.md` records it as cabled that
  way and settles `mapper/orientation.py` at `identity` permanently. Neither the
  vendor nor this repo predicts the order at a new load-in, which is why a white
  frame and a per-column walk come before content.
- **Anything about the 10 × 12 rig.** The layout model is arithmetic and will
  produce a twelve-row diagram happily. That is not evidence it is right.
- **Whether a controller can render a short port payload**, which is the question
  custom layouts turn on. The vendor's mapper is rectangle-only too.
