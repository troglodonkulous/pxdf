"""Render `ConfigResult`s as the two things the task needs: a table for a
terminal, and JSON for the orchestrator's progress page.

Both carry the cross-frame recurrence reading on **every** row, passing or
failing. That is deliberate: this project's recurring failure mode is a
measurement that agrees with itself, and a number that is always printed
(2 % on a clean capture, 100 % on a misassigned port) shows a regression as a
value moving, where a boolean would only show it as a verdict flipping.
"""

from __future__ import annotations

import json

from .decode_diff import ConfigResult

SCHEMA = "pxdf-oracle-report/2"


def _divergence_row(d) -> dict | None:
    if d is None:
        return None
    return {
        "frameIndex": d.frame_index,
        "classification": d.classification,
        "controller": d.controller,
        "port": d.port,
        "packetIndex": d.packet_index,
        "byte4": f"0x{d.byte4:02X}" if d.byte4 >= 0 else None,
        "field": d.field,
        "byteOffset": d.byte_offset,
        "expectedByte": d.expected_byte,
        "observedByte": d.observed_byte,
    }


def _recurrence_row(r) -> dict | None:
    if r is None:
        return None
    return {
        "packetOrdinal": r.packet_ordinal,
        "controller": r.controller,
        "port": r.port,
        "packetIndex": r.packet_index,
        "byte4": f"0x{r.byte4:02X}" if r.byte4 >= 0 else None,
        "frames": r.frames,
        "framesTotal": r.frames_total,
        "fraction": round(r.fraction, 4),
        "systematic": r.systematic,
    }


def to_row(r: ConfigResult) -> dict:
    return {
        "name": r.name,
        "config": r.config_desc,
        "capture": r.capture,
        "packetsExpected": r.packets_expected,
        "framesTotal": r.frames_total,
        "framesMatched": r.frames_matched,
        "framesTolerated": r.frames_tolerated,
        "maxTolerated": r.max_tolerated,
        "framesUnexplained": r.frames_unexplained,
        "partialFrames": [{"groupIndex": i, "packets": n} for i, n in r.partial_frames],
        "worstRecurrence": _recurrence_row(r.worst_recurrence),
        "systematicMismatches": [_recurrence_row(x) for x in r.systematic],
        "passed": r.passed,
        "failures": r.failures,
        "error": r.error,
        "firstDivergence": _divergence_row(r.first_divergence),
    }


def to_json(results: list[ConfigResult]) -> str:
    payload = {
        "schema": SCHEMA,
        "configs": [to_row(r) for r in results],
        "summary": {
            "total": len(results),
            "passed": sum(1 for r in results if r.passed),
            "failed": sum(1 for r in results if not r.passed),
        },
    }
    return json.dumps(payload, indent=2) + "\n"


def _divergence_text(d) -> str:
    if d is None:
        return "-"
    return (
        f"frame {d.frame_index} [{d.classification}] "
        f"ctrl{d.controller}/port{d.port}/pkt{d.packet_index} "
        f"byte4=0x{d.byte4:02X} {d.field} offset {d.byte_offset}: "
        f"expected {d.expected_byte} got {d.observed_byte}"
    )


def _recurrence_text(r) -> str:
    if r is None:
        return "0%"
    return f"{r.fraction * 100:.0f}%"


def _detail_text(r: ConfigResult) -> str:
    """What failed, located -- falling back to the first divergence when nothing did."""
    if r.failures:
        return "; ".join(r.failures)
    return _divergence_text(r.first_divergence)


def to_table(results: list[ConfigResult]) -> str:
    header = (
        f"{'name':<28} {'status':<6} {'pkts':>5} {'frames':>7} "
        f"{'match':>6} {'tol':>7} {'unexp':>6} {'part':>5} {'recur':>6}  detail"
    )
    lines = [header, "-" * len(header)]
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        if r.error:
            lines.append(
                f"{r.name:<28} {'ERROR':<6} {'-':>5} {'-':>7} {'-':>6} {'-':>7} "
                f"{'-':>6} {'-':>5} {'-':>6}  {r.error}"
            )
            continue
        lines.append(
            f"{r.name:<28} {status:<6} {r.packets_expected:>5} {r.frames_total:>7} "
            f"{r.frames_matched:>6} {f'{r.frames_tolerated}/{r.max_tolerated}':>7} "
            f"{r.frames_unexplained:>6} {len(r.partial_frames):>5} "
            f"{_recurrence_text(r.worst_recurrence):>6}  {_detail_text(r)}"
        )
    passed = sum(1 for r in results if r.passed)
    lines += [
        "",
        f"{passed}/{len(results)} configs passed",
        "",
        "tol = tolerated/budget (vendor defects, bounded per config by max_tolerated)",
        "part = partial frames at the capture-window edges (counted, never dropped silently)",
        "recur = worst packet ordinal's mismatch rate across frames; a vendor tear is "
        "transient (~2%), a mapping fault is systematic (~100%)",
    ]
    return "\n".join(lines)
