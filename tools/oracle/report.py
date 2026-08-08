"""Render `ConfigResult`s as the two things the task needs: a table for a
terminal, and JSON for the orchestrator's progress page.
"""

from __future__ import annotations

import json

from .decode_diff import ConfigResult

SCHEMA = "ddf-oracle-report/1"


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


def to_row(r: ConfigResult) -> dict:
    return {
        "name": r.name,
        "config": r.config_desc,
        "capture": r.capture,
        "packetsExpected": r.packets_expected,
        "framesTotal": r.frames_total,
        "framesMatched": r.frames_matched,
        "framesTolerated": r.frames_tolerated,
        "framesUnexplained": r.frames_unexplained,
        "passed": r.passed,
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


def to_table(results: list[ConfigResult]) -> str:
    header = (
        f"{'name':<28} {'status':<6} {'pkts':>5} {'frames':>7} "
        f"{'match':>6} {'tol':>4} {'unexp':>6}  first divergence"
    )
    lines = [header, "-" * len(header)]
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        if r.error:
            lines.append(f"{r.name:<28} {'ERROR':<6} {'-':>5} {'-':>7} {'-':>6} {'-':>4} {'-':>6}  {r.error}")
            continue
        lines.append(
            f"{r.name:<28} {status:<6} {r.packets_expected:>5} {r.frames_total:>7} "
            f"{r.frames_matched:>6} {r.frames_tolerated:>4} {r.frames_unexplained:>6}  "
            f"{_divergence_text(r.first_divergence)}"
        )
    passed = sum(1 for r in results if r.passed)
    lines += ["", f"{passed}/{len(results)} configs passed"]
    return "\n".join(lines)
