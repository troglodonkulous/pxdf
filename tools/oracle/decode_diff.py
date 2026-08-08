"""Decode + diff, one config at a time.

Reuses `mapper.pcapng` and `mapper.verify` rather than reimplementing a
decoder: `read_udp` and `split_frames` do all the parsing, `compare_frame`
does the byte-level diff. What this module adds on top:

* maps a mismatch's packet ordinal back to protocol terms -- controller,
  port, packetIndex, byte4 -- via the same `build_plan()` the mismatch was
  computed against, instead of leaving it as a bare index;
* classifies an unmatched frame against the two Ledset playback defects
  `docs/CAPTURE_RESULTS.md` documents (a loop-boundary all-black frame, and
  a torn frame from the vendor's unlocked send thread), so the report can
  separate "our mapping disagrees with Ledset" from "Ledset did the thing
  it always does at a loop boundary" -- without inventing a third source of
  truth for either defect;
* **checks each of those defect labels against the one axis a per-frame
  predicate structurally cannot see: recurrence across frames.** A vendor
  tear is a timing accident and lands somewhere new each time; a mapping
  fault is a property of the plan and lands on the same packet every frame.
  A packet ordinal that differs in more than `MAX_RECURRENCE` of the
  capture's frames is not a tear, whatever a single frame looks like in
  isolation, and its frames are promoted out of "tolerated" into
  `systematic-mismatch` -- located at the offending (controller, port,
  packetIndex), which is the thing an operator needs in order to act. See
  `docs/ORACLE_HARNESS.md` S8 for how the threshold was measured.

A config passes when all five of these hold (`docs/ORACLE_HARNESS.md` S8):

1. zero unexplained frames -- including the `systematic-mismatch` and
   `sustained-blank` promotions above, which is what stops a defect label
   from absorbing a real fault;
2. tolerated frames within the config's own measured `max_tolerated` budget;
3. every partial frame sits at a capture-window boundary, never inside;
4. at least one frame matched exactly;
5. no error (a missing capture is a reported row, not a skipped one).
"""

from __future__ import annotations

import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mapper.floors import FloorConfig
from mapper.frame import build_frame
from mapper.orientation import Orientation
from mapper.patterns import PATTERNS, tile
from mapper.pcapng import read_udp, split_frames
from mapper.plan import PacketSpec, build_plan
from mapper.verify import FrameDiff, compare_frame

from .config_list import OracleConfig

DEST_PORT = 60001

#: Fraction of a capture's complete frames one packet ordinal may differ in
#: before it stops being a vendor tear and becomes a mapping fault.
#:
#: **Measured, not chosen.** Across every real capture in `captures/`
#: (232 complete frames over five captures, two vendors -- Ledset for
#: `01`/`02`/`03`/`06`, our own sender for `20`), no packet ordinal ever
#: differs in more than **one** non-blank frame:
#:
#:     01-black       0/46 = 0.0 %        06-halves      1/46 = 2.2 %
#:     02-white       1/46 = 2.2 %        20-ours-white  0/50 = 0.0 %
#:     03-red         1/44 = 2.3 %
#:
#: Against that, an injected misassigned port -- the exact fault class the
#: acceptance capture exists to catch -- recurs in **100 %** of frames, because
#: the packet plan is the same every frame:
#:
#:     swap tile columns 3 <-> 4   46/46 = 100 %   (06-halves, gradient24)
#:     swap tile columns 0 <-> 5   46/46 = 100 %   (06-halves, gradient24)
#:     tile column 7 reads 6       60/60 = 100 %   (gradient24 only -- see S8)
#:
#: 25 % sits ~11x above the worst real reading and 4x below the fault signal.
#: The width is what absorbs a capture much shorter or much tear-ier than the
#: ones measured: it still permits 11 independent tears on the same packet in a
#: 44-frame capture, roughly an order of magnitude more vendor misbehaviour than
#: has ever been observed. It must stay far below 100 % because that is what it
#: has to catch, and far above ~2 % because that is what it must not.
MAX_RECURRENCE = 0.25

#: A packet must differ in at least this many frames to be called recurrent at
#: all. One occurrence is by definition not a pattern, and without this floor a
#: capture of three frames with a single tear would read as 33 % and fail.
MIN_RECURRENT_FRAMES = 2

#: Consecutive all-black frames that can still be a video loop boundary.
#:
#: Ledset emits two (`docs/CAPTURE_RESULTS.md`); the real captures show runs of
#: 2, 3 and 3. Six is 2x the longest measured. Beyond it the frames are not a
#: loop boundary but sustained blackness -- media that failed to load, a clip
#: that is not playing, an idle floor -- and are reported as such rather than
#: tolerated. `max_tolerated` bounds the same failure independently; this exists
#: so the *diagnosis* is right, not only the verdict.
MAX_BLANK_RUN = 6

#: "halves" (left half white, right half black) is a real capture
#: (`captures/06-halves.pcapng`) but is not one of `mapper.patterns.PATTERNS`
#: -- it was built ad hoc in `mapper/tests/test_oracle_capture.py` because it
#: is a spatial check, not a named source pattern. Reproduced here the same
#: way, rather than adding it to `mapper/patterns.py`, which is another
#: pair's file.
def _halves(config: FloorConfig) -> bytearray:
    from mapper.patterns import black

    fb = black(config)
    width = config.width_px
    for y in range(config.height_px):
        for x in range(width // 2):
            i = (y * width + x) * 3
            fb[i : i + 3] = b"\xff\xff\xff"
    return fb


_EXTRA_PATTERNS = {"halves": _halves}


def framebuffer_for(oc: OracleConfig, config: FloorConfig) -> bytearray:
    if oc.pattern == "tile":
        return tile(config, oc.tile_col, oc.tile_row)
    if oc.pattern in _EXTRA_PATTERNS:
        return _EXTRA_PATTERNS[oc.pattern](config)
    if oc.pattern not in PATTERNS:
        raise ValueError(
            f"unknown pattern {oc.pattern!r} (known: {sorted(set(PATTERNS) | set(_EXTRA_PATTERNS) | {'tile'})})"
        )
    return PATTERNS[oc.pattern](config)


@dataclass(frozen=True)
class Divergence:
    """Where a mismatch is, in protocol terms -- not a raw packet ordinal."""

    frame_index: int
    classification: str  # "unexplained" | "loop-boundary-blank" | "torn-frame" | ...
    packet_ordinal: int
    controller: int
    port: int
    packet_index: int
    byte4: int
    field: str  # "header" | "body"
    byte_offset: int  # within the 5-byte header, or within the body
    expected_byte: int | None
    observed_byte: int | None


@dataclass(frozen=True)
class Recurrence:
    """One packet ordinal, and how many frames it differed in.

    This is the cross-frame statistic the per-frame classifier cannot compute.
    It is reported for every config, passing or failing, so the reading is
    visible as a number rather than only as a verdict -- a regression shows up
    as `recur` moving from 2 % to 100 %, not as a boolean quietly flipping.
    """

    packet_ordinal: int
    controller: int
    port: int
    packet_index: int
    byte4: int
    frames: int
    frames_total: int

    @property
    def fraction(self) -> float:
        return self.frames / self.frames_total if self.frames_total else 0.0

    @property
    def systematic(self) -> bool:
        return (
            self.frames >= MIN_RECURRENT_FRAMES
            and self.fraction > MAX_RECURRENCE
        )

    def describe(self) -> str:
        return (
            f"ctrl{self.controller}/port{self.port}/pkt{self.packet_index} "
            f"(byte4=0x{self.byte4:02X}) differs in {self.frames}/{self.frames_total} "
            f"frames ({self.fraction * 100:.0f}%)"
        )


@dataclass(frozen=True)
class FrameVerdict:
    frame_index: int
    ok: bool
    classification: str


#: Classifications that are a known vendor defect and do not fail a config.
TOLERATED = frozenset({"loop-boundary-blank", "torn-frame"})


@dataclass(frozen=True)
class ConfigResult:
    name: str
    config_desc: str
    capture: str | None
    packets_expected: int
    frames_total: int
    frames_matched: int
    frames_tolerated: int  # loop-boundary-blank + torn-frame, within budget
    frames_unexplained: int
    passed: bool
    first_divergence: Divergence | None
    #: Every partial frame group in the capture, as `(group index, packet count)`.
    #: Counted and reported rather than silently dropped: the table's denominator
    #: must not be something the code chose without saying so.
    partial_frames: list[tuple[int, int]] = field(default_factory=list)
    #: The budget from the config list, and what was measured against it.
    max_tolerated: int = 0
    #: Worst-recurring packet ordinal, always reported.
    worst_recurrence: Recurrence | None = None
    #: Every ordinal over `MAX_RECURRENCE`, worst first.
    systematic: list[Recurrence] = field(default_factory=list)
    #: Why it failed, one located string per broken criterion.
    failures: list[str] = field(default_factory=list)
    verdicts: list[FrameVerdict] = field(default_factory=list)
    error: str | None = None


def _is_blank(observed: list[bytes]) -> bool:
    """Every packet body in this frame is all zero.

    A raw property of the captured bytes, deliberately *not* a classification:
    it is used both to label loop-boundary blanks and to exclude frames from the
    recurrence statistic, and the second use must not depend on the first being
    right. An all-zero frame carries no evidence about port assignment either
    way -- every port carried the same value -- so dropping it from the
    numerator loses nothing and stops a capture's loop-boundary count from
    setting the noise floor of the check that has to catch mapping faults.
    """
    return all(all(b == 0 for b in packet[5:]) for packet in observed)


def _classify(observed: list[bytes], diff: FrameDiff) -> str:
    """Which of the two documented Ledset defects, if either, this looks like.

    Provisional: `_apply_cross_frame_checks` overrides it where the rest of the
    capture says otherwise. On its own this is a per-frame predicate and a
    per-frame predicate cannot tell a transient from a systematic fault.

    `docs/CAPTURE_RESULTS.md`: Ledset emits two fully-black frames at every
    video loop boundary (sender-side, not ours), and its unlocked send
    thread occasionally ships a frame torn mid-write. Both are body-only --
    a genuine mapping bug is under no such constraint and is free to also
    break headers, packet counts, or anything else, so a header mismatch is
    never classified as either defect.
    """
    if diff.ok:
        return "matched"
    if diff.header_mismatches:
        return "unexplained"
    if _is_blank(observed):
        # Not `len(bad) == len(observed)`: on a capture whose source frame is
        # partly black already (`06-halves`), a loop-boundary blank differs in
        # only the packets that were carrying light -- 8 of 16 -- and the old
        # count-based test mislabelled every one of them "torn-frame".
        return "loop-boundary-blank"
    if 0 < len(diff.body_mismatches) < len(observed):
        return "torn-frame"
    return "unexplained"


def _header_first_diff_offset(want5: bytes, got5: bytes) -> int:
    for i in range(5):
        if i >= len(got5) or want5[i] != got5[i]:
            return i
    return 0


def _spec_fields(plan: tuple[PacketSpec, ...], ordinal: int) -> tuple[int, int, int, int]:
    spec = plan[ordinal] if ordinal < len(plan) else None
    if spec is None:
        return -1, -1, -1, -1
    return spec.controller, spec.port, spec.packet_index, spec.byte4


def _divergence_for(
    frame_index: int,
    classification: str,
    plan: tuple[PacketSpec, ...],
    expected: list[bytes],
    observed: list[bytes],
    diff: FrameDiff,
) -> Divergence:
    if diff.header_mismatches:
        ordinal = diff.header_mismatches[0]
        want5, got5 = expected[ordinal][:5], observed[ordinal][:5] if ordinal < len(observed) else b""
        offset = _header_first_diff_offset(want5, got5)
        exp_b = want5[offset]
        obs_b = got5[offset] if offset < len(got5) else None
        field_name = "header"
    else:
        ordinal, offset = diff.first_bad_byte  # body mismatch guarantees this is set
        want, got = expected[ordinal], observed[ordinal]
        exp_b = want[5 + offset] if 5 + offset < len(want) else None
        obs_b = got[5 + offset] if 5 + offset < len(got) else None
        field_name = "body"

    controller, port, packet_index, byte4 = _spec_fields(plan, ordinal)
    return Divergence(
        frame_index=frame_index,
        classification=classification,
        packet_ordinal=ordinal,
        controller=controller,
        port=port,
        packet_index=packet_index,
        byte4=byte4,
        field=field_name,
        byte_offset=offset,
        expected_byte=exp_b,
        observed_byte=obs_b,
    )


def _error_result(oc: OracleConfig, config_desc: str, capture: str | None, message: str) -> ConfigResult:
    return ConfigResult(
        name=oc.name,
        config_desc=config_desc,
        capture=capture,
        packets_expected=0,
        frames_total=0,
        frames_matched=0,
        frames_tolerated=0,
        frames_unexplained=0,
        passed=False,
        first_divergence=None,
        max_tolerated=oc.max_tolerated,
        failures=[message],
        verdicts=[],
        error=message,
    )


def recurrence_of(
    plan: tuple[PacketSpec, ...],
    diffs: list[FrameDiff],
    observed_frames: list[list[bytes]],
) -> list[Recurrence]:
    """Per-packet-ordinal mismatch counts across a whole capture, worst first.

    Numerator: frames whose observed bodies were not all zero (see `_is_blank`).
    Denominator: every complete frame, so a capture with many loop-boundary
    blanks dilutes rather than inflates the fraction -- blanks are bounded
    separately by `max_tolerated`.
    """
    total = len(observed_frames)
    counts: Counter[int] = Counter()
    for diff, observed in zip(diffs, observed_frames):
        if diff.ok or _is_blank(observed):
            continue
        counts.update(diff.body_mismatches)

    out = []
    for ordinal, frames in counts.items():
        controller, port, packet_index, byte4 = _spec_fields(plan, ordinal)
        out.append(
            Recurrence(
                packet_ordinal=ordinal,
                controller=controller,
                port=port,
                packet_index=packet_index,
                byte4=byte4,
                frames=frames,
                frames_total=total,
            )
        )
    out.sort(key=lambda r: (-r.frames, r.packet_ordinal))
    return out


def _blank_runs(classifications: list[str]) -> list[list[int]]:
    """Maximal runs of consecutive `loop-boundary-blank` frame indices."""
    runs: list[list[int]] = []
    for i, c in enumerate(classifications):
        if c != "loop-boundary-blank":
            continue
        if runs and runs[-1][-1] == i - 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


def analyse_frames(
    oc: OracleConfig,
    plan: tuple[PacketSpec, ...],
    expected: list[bytes],
    complete: list[list[bytes]],
    partial_frames: list[tuple[int, int]],
    capture: str | None,
) -> ConfigResult:
    """The whole verdict, given already-decoded frames.

    Split out from `verify_config` so the cross-frame logic can be driven from
    synthetic frames in a test without writing a pcapng -- the recurrence check
    is the part that has to be proved against injected faults, and it must be
    provable at geometries no capture exists for.
    """
    config = oc.floor_config
    diffs = [compare_frame(expected, observed, i) for i, observed in enumerate(complete)]
    classifications = [_classify(observed, diff) for observed, diff in zip(complete, diffs)]

    recurrences = recurrence_of(plan, diffs, complete)
    systematic = [r for r in recurrences if r.systematic]
    systematic_ordinals = {r.packet_ordinal for r in systematic}

    failures: list[str] = []

    # --- cross-frame override 1: a packet that misses every frame is not a tear.
    if systematic:
        for i, (diff, cls) in enumerate(zip(diffs, classifications)):
            if cls in TOLERATED and systematic_ordinals.intersection(diff.body_mismatches):
                classifications[i] = "systematic-mismatch"
        ports = sorted({(r.controller, r.port) for r in systematic})
        failures.append(
            f"systematic-mismatch: {systematic[0].describe()}, limit "
            f"{MAX_RECURRENCE * 100:.0f}%; {len(systematic)} packet(s) over the limit on "
            + ", ".join(f"ctrl{c}/port{p}" for c, p in ports)
        )

    # --- cross-frame override 2: a long run of black is not a loop boundary.
    for run in _blank_runs(classifications):
        if len(run) > MAX_BLANK_RUN:
            for i in run:
                classifications[i] = "sustained-blank"
            failures.append(
                f"sustained-blank: {len(run)} consecutive all-black frames from frame "
                f"{run[0]} (a loop boundary is at most {MAX_BLANK_RUN}) -- media not "
                f"loaded, clip not playing, or floor idle"
            )

    verdicts = [
        FrameVerdict(i, diff.ok, cls) for i, (diff, cls) in enumerate(zip(diffs, classifications))
    ]
    matched = sum(1 for c in classifications if c == "matched")
    tolerated = sum(1 for c in classifications if c in TOLERATED)
    unexplained = len(classifications) - matched - tolerated

    first_divergence: Divergence | None = None
    for i, (diff, cls) in enumerate(zip(diffs, classifications)):
        if cls == "matched":
            continue
        first_divergence = _divergence_for(i, cls, plan, expected, complete[i], diff)
        break

    if unexplained:
        failures.append(f"{unexplained} unexplained frame(s) of {len(complete)}")
    if tolerated > oc.max_tolerated:
        failures.append(
            f"{tolerated} tolerated frame(s), budget {oc.max_tolerated} "
            f"(set max_tolerated in the config list, measured, if this is genuinely expected)"
        )
    interior = [(i, n) for i, n in partial_frames if i not in (0, _last_group_index(complete, partial_frames))]
    if interior:
        failures.append(
            "partial frame(s) inside the capture at group index "
            + ", ".join(f"{i} ({n} packets, expected {len(plan)})" for i, n in interior)
            + " -- only the first and last group may be truncated by the capture window"
        )
    if matched == 0:
        failures.append(
            "no frame matched exactly -- a config whose every frame is explained "
            "away has proved nothing"
        )

    return ConfigResult(
        name=oc.name,
        config_desc=config.describe(),
        capture=capture,
        packets_expected=len(plan),
        frames_total=len(complete),
        frames_matched=matched,
        frames_tolerated=tolerated,
        frames_unexplained=unexplained,
        passed=not failures,
        first_divergence=first_divergence,
        partial_frames=list(partial_frames),
        max_tolerated=oc.max_tolerated,
        worst_recurrence=recurrences[0] if recurrences else None,
        systematic=systematic,
        failures=failures,
        verdicts=verdicts,
        error=None,
    )


def _last_group_index(complete: list[list[bytes]], partial: list[tuple[int, int]]) -> int:
    """Index of the final group in the original `split_frames` output."""
    return len(complete) + len(partial) - 1


def verify_config(oc: OracleConfig, capture_path: str | Path | None) -> ConfigResult:
    """Decode one capture and diff it against what `oc` predicts.

    `capture_path=None` is a config with no capture -- reported as a row with
    `error` set, not silently dropped, so a geometry with no oracle shows up
    as one in the table rather than vanishing from it.
    """
    config = oc.floor_config
    plan = build_plan(config, eof=oc.eof)

    if capture_path is None:
        return _error_result(oc, config.describe(), None, "no capture available for this config")

    capture_path = Path(capture_path)
    if not capture_path.exists():
        return _error_result(oc, config.describe(), str(capture_path), f"capture not found: {capture_path}")

    orientation = oc.orientation_obj
    framebuffer = framebuffer_for(oc, config)
    expected = build_frame(config, framebuffer, orientation, eof=oc.eof)

    datagrams = read_udp(capture_path, DEST_PORT)
    groups = [[d.payload for d in f] for f in split_frames(datagrams)]
    complete = [g for g in groups if len(g) == len(plan)]
    partial = [(i, len(g)) for i, g in enumerate(groups) if len(g) != len(plan)]

    if not complete:
        return _error_result(
            oc, config.describe(), str(capture_path),
            f"no complete frames in capture ({len(groups)} incomplete frame(s) found, "
            f"none with the expected {len(plan)} packets)",
        )

    return analyse_frames(oc, plan, expected, complete, partial, str(capture_path))
