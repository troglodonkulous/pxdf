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
  truth for either defect. Anything that is not one of those two known
  shapes is `"unexplained"`, and an unexplained frame is what fails a
  config: the project's own bar is zero unexplained rows, not zero diffs.
"""

from __future__ import annotations

import sys
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
    classification: str  # "unexplained" | "loop-boundary-blank" | "torn-frame"
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
class FrameVerdict:
    frame_index: int
    ok: bool
    classification: str


@dataclass(frozen=True)
class ConfigResult:
    name: str
    config_desc: str
    capture: str | None
    packets_expected: int
    frames_total: int
    frames_matched: int
    frames_tolerated: int  # loop-boundary-blank + torn-frame: explained, not held against pass/fail
    frames_unexplained: int
    passed: bool
    first_divergence: Divergence | None
    verdicts: list[FrameVerdict] = field(default_factory=list)
    error: str | None = None


def _classify(observed: list[bytes], diff: FrameDiff) -> str:
    """Which of the two documented Ledset defects, if either, this looks like.

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
    bad = diff.body_mismatches
    if bad and len(bad) == len(observed) and all(
        all(b == 0 for b in observed[i][5:]) for i in bad
    ):
        return "loop-boundary-blank"
    if 0 < len(bad) < len(observed):
        return "torn-frame"
    return "unexplained"


def _header_first_diff_offset(want5: bytes, got5: bytes) -> int:
    for i in range(5):
        if i >= len(got5) or want5[i] != got5[i]:
            return i
    return 0


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

    spec = plan[ordinal] if ordinal < len(plan) else None
    return Divergence(
        frame_index=frame_index,
        classification=classification,
        packet_ordinal=ordinal,
        controller=spec.controller if spec else -1,
        port=spec.port if spec else -1,
        packet_index=spec.packet_index if spec else -1,
        byte4=spec.byte4 if spec else -1,
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
        verdicts=[],
        error=message,
    )


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
    frames = [[d.payload for d in f] for f in split_frames(datagrams)]
    complete = [f for f in frames if len(f) == len(plan)]

    if not complete:
        result = _error_result(
            oc, config.describe(), str(capture_path),
            f"no complete frames in capture ({len(frames)} incomplete frame(s) found, "
            f"none with the expected {len(plan)} packets)",
        )
        return result

    verdicts: list[FrameVerdict] = []
    first_divergence: Divergence | None = None
    matched = tolerated = unexplained = 0

    for i, observed in enumerate(complete):
        diff = compare_frame(expected, observed, i)
        classification = _classify(observed, diff)
        verdicts.append(FrameVerdict(i, diff.ok, classification))

        if classification == "matched":
            matched += 1
            continue
        if classification == "unexplained":
            unexplained += 1
        else:
            tolerated += 1
        if first_divergence is None:
            first_divergence = _divergence_for(i, classification, plan, expected, observed, diff)

    passed = unexplained == 0 and matched > 0

    return ConfigResult(
        name=oc.name,
        config_desc=config.describe(),
        capture=str(capture_path),
        packets_expected=len(plan),
        frames_total=len(complete),
        frames_matched=matched,
        frames_tolerated=tolerated,
        frames_unexplained=unexplained,
        passed=passed,
        first_divergence=first_divergence,
        verdicts=verdicts,
        error=None,
    )
