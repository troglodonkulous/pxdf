"""Diff a capture against what we would have sent.

The output is deliberately a table rather than a boolean: at the floor the
useful question is never "did it match" but "which packets did not, and are
they all on one controller".
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .floors import FloorConfig
from .frame import build_frame
from .orientation import IDENTITY, Orientation
from .pcapng import read_udp, split_frames
from .plan import build_plan


@dataclass(frozen=True)
class FrameDiff:
    frame_index: int
    packet_count: int
    header_mismatches: list[int]
    body_mismatches: list[int]
    first_bad_byte: tuple[int, int] | None  # (packet ordinal, byte offset)

    @property
    def ok(self) -> bool:
        return not self.header_mismatches and not self.body_mismatches


def compare_frame(expected: list[bytes], observed: list[bytes], index: int) -> FrameDiff:
    header_bad: list[int] = []
    body_bad: list[int] = []
    first_bad: tuple[int, int] | None = None

    for ordinal, want in enumerate(expected):
        if ordinal >= len(observed):
            header_bad.append(ordinal)
            continue
        got = observed[ordinal]
        if got[:5] != want[:5]:
            header_bad.append(ordinal)
        if got[5:] != want[5:]:
            body_bad.append(ordinal)
            if first_bad is None:
                for offset, (a, b) in enumerate(zip(want[5:], got[5:])):
                    if a != b:
                        first_bad = (ordinal, offset)
                        break
                else:
                    first_bad = (ordinal, min(len(want), len(got)) - 5)
    return FrameDiff(index, len(observed), header_bad, body_bad, first_bad)


def verify_capture(
    path: str | Path,
    config: FloorConfig,
    framebuffer: bytes | bytearray,
    orientation: Orientation = IDENTITY,
    eof: bool = True,
    port: int = 60001,
) -> list[FrameDiff]:
    """Compare every complete frame in a capture against one expected frame."""
    expected = build_frame(config, framebuffer, orientation, eof=eof)
    frames = [
        [d.payload for d in frame]
        for frame in split_frames(read_udp(path, port))
    ]
    complete = [f for f in frames if len(f) == config.packets_per_frame]
    return [compare_frame(expected, frame, i) for i, frame in enumerate(complete)]


def format_diffs(config: FloorConfig, diffs: list[FrameDiff]) -> str:
    matched = sum(1 for d in diffs if d.ok)
    lines = [
        config.describe(),
        f"expected {config.packets_per_frame} packets/frame from a plan of "
        f"{len(build_plan(config))}",
        "",
        f"{'frame':>6} {'packets':>8} {'hdr bad':>8} {'body bad':>9}  first difference",
    ]
    for diff in diffs:
        if diff.ok:
            continue
        where = (
            f"packet {diff.first_bad_byte[0]} byte {diff.first_bad_byte[1]}"
            if diff.first_bad_byte
            else "-"
        )
        lines.append(
            f"{diff.frame_index:>6} {diff.packet_count:>8} "
            f"{len(diff.header_mismatches):>8} {len(diff.body_mismatches):>9}  {where}"
        )
    lines += ["", f"{matched}/{len(diffs)} complete frames byte-identical"]
    return "\n".join(lines)
