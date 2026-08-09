"""Generate `90-synth-acceptance` — the harness's instrument test.

`docs/ORACLE_HARNESS.md` S8.5 reports what the pass criterion does at the
acceptance geometry (`8x8_4P`, 10x5, three controllers with a partial last one)
under three injected mapping faults. No capture exists at that geometry, so the
capture those rows were measured against is **synthetic**: frames built from the
clean mapper, with the two documented vendor defects planted deliberately and
the fault applied to the *observed* side.

This module exists so those rows are reproducible. Without it the S8.5 table was
prose — a measurement nobody else could repeat, which is precisely the failure
mode this project keeps hitting.

**It is an instrument test, not evidence about Ledset.** It proves what the
harness does with a capture of this shape. Only the attended gradient24 capture
can prove that Ledset agrees with our mapping.

Faults are injected exactly as `tools/oracle/tests/test_decode_diff.py`'s
`InjectedMappingFaults` does it — by changing which global tile column a port's
bytes are sliced from, leaving headers, packet counts and lengths correct. That
is byte-for-byte equivalent to patching `mapper.plan.build_plan`, because
`datagrams_from_buffer` slices each packet at `tile_col * port_data_size`.

Usage:

    python -m tools.oracle.make_synth_capture                  # clean capture
    python -m tools.oracle.make_synth_capture --fault f1 --check

`--check` runs the harness's own verdict over the file it just wrote and prints
the report row, so the S8.5 numbers come out of `decode_diff`/`report` rather
than from anything this module claims about itself.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mapper.floors import FloorConfig
from mapper.frame import pack_send_buffer
from mapper.patterns import gradient24
from mapper.plan import PacketSpec, build_plan

from .config_list import OracleConfig

# --- the shape of the capture -------------------------------------------------
# Chosen to match an 8 s window at the acceptance geometry, the same derivation
# `configs.acceptance.json`'s `_max_tolerated_derivation` spells out: a 6.0 s
# gradient24 loop sent at Ledset's measured ~9.2 fps is ~74 frames spanning one
# loop boundary, and a capture window opens and closes without regard for frame
# boundaries so the last group is short.

FRAME_COUNT = 74

#: A loop-boundary blank run. Three is the longest run measured in any real
#: capture, and `MAX_BLANK_RUN` (6) tolerates it.
BLANK_FRAMES = (30, 31, 32)

#: Two torn frames, on **disjoint** packet ordinals. Disjointness is the point:
#: a vendor tear is a timing accident that lands somewhere new each time, so no
#: single ordinal may recur. Overlapping them here would manufacture the very
#: signal the recurrence check exists to detect.
TORN_FRAMES = {10: (2, 3), 50: (14, 15)}

#: Packets in the trailing group, which the capture window cut short.
TRAILING_PARTIAL_PACKETS = 1

ACCEPTANCE = OracleConfig(
    name="90-synth-acceptance",
    type="8x8_4P",
    cols=10,
    rows=5,
    pattern="gradient24",
    orientation="identity",
    max_tolerated=9,
    notes="Synthetic instrument test — see docs/ORACLE_HARNESS.md S8.5.",
)

#: `tile_col -> tile_col` remappings, applied to the observed side.
FAULTS: dict[str, dict[int, int]] = {
    "none": {},
    # F1 — tile columns 3 and 4 swapped. At this geometry that is a
    # *cross-controller* swap: ctrl0/port3 <-> ctrl1/port0.
    "f1": {3: 4, 4: 3},
    # F1b — tile columns 0 and 5 swapped: ctrl0/port0 <-> ctrl1/port1.
    "f1b": {0: 5, 5: 0},
    # F2 — tile column 7 reads column 6. Invisible in every capture the repo
    # has, because 6 and 7 carry identical content in all of them.
    "f2": {7: 6},
}

DEST_PORT = 60001
SRC_IP = "192.168.1.50"
DST_IP = "255.255.255.255"
SRC_MAC = b"\x00\x11\x22\x33\x44\x55"
DST_MAC = b"\xff\xff\xff\xff\xff\xff"

#: Ledset's measured inter-frame gap, so timestamps are plausible. Nothing in
#: the harness reads them; a capture with nonsense timing would still pass, and
#: writing real ones costs nothing.
FRAME_INTERVAL_US = 109_000


# --- datagram construction ----------------------------------------------------


def observed_datagrams(
    config: FloorConfig,
    buffer: bytes | bytearray,
    plan: tuple[PacketSpec, ...],
    fault: dict[int, int],
) -> list[bytes]:
    """Slice the send buffer, optionally reading the wrong tile column.

    `fault` maps a port's own tile column to the column it wrongly reads. An
    empty map reproduces `mapper.frame.datagrams_from_buffer` exactly.
    """
    port_data_size = config.port_data_size
    out: list[bytes] = []
    for packet in plan:
        source_col = fault.get(packet.tile_col, packet.tile_col)
        start = source_col * port_data_size + packet.port_offset
        out.append(packet.header + bytes(buffer[start : start + packet.body_len]))
    return out


def _blank(datagrams: list[bytes]) -> list[bytes]:
    """Headers intact, bodies all zero — what a loop boundary looks like."""
    return [d[:5] + bytes(len(d) - 5) for d in datagrams]


def _torn(datagrams: list[bytes], ordinals: tuple[int, ...]) -> list[bytes]:
    """Corrupt the named packets' bodies only.

    A real tear ships bytes from an adjacent frame; gradient24 is a still, so
    there is no adjacent frame to differ from and the tear has to be written in
    directly. The classifier only sees "these bodies differ and the headers do
    not", which is the same thing either way.
    """
    out = list(datagrams)
    for ordinal in ordinals:
        body = bytearray(out[ordinal][5:])
        for i in range(len(body)):
            body[i] ^= 0xA5
        out[ordinal] = out[ordinal][:5] + bytes(body)
    return out


def build_capture_frames(fault_name: str) -> list[list[bytes]]:
    """Every group the capture holds, in order — including the trailing partial."""
    if fault_name not in FAULTS:
        raise ValueError(f"unknown fault {fault_name!r} (known: {sorted(FAULTS)})")

    config = ACCEPTANCE.floor_config
    plan = build_plan(config, eof=ACCEPTANCE.eof)
    buffer = pack_send_buffer(config, gradient24(config), ACCEPTANCE.orientation_obj)
    clean = observed_datagrams(config, buffer, plan, FAULTS[fault_name])

    groups: list[list[bytes]] = []
    for index in range(FRAME_COUNT):
        if index in BLANK_FRAMES:
            groups.append(_blank(clean))
        elif index in TORN_FRAMES:
            groups.append(_torn(clean, TORN_FRAMES[index]))
        else:
            groups.append(list(clean))
    groups.append(clean[:TRAILING_PARTIAL_PACKETS])
    return groups


# --- pcapng emission ----------------------------------------------------------
# `mapper/pcapng.py` is a reader only. This writes the narrowest file that
# reader accepts — one Ethernet IDB and one EPB per datagram — which is also
# what dumpcap produces for this traffic.


def _ipv4_checksum(header: bytes) -> int:
    total = 0
    for i in range(0, len(header), 2):
        total += struct.unpack_from(">H", header, i)[0]
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def _ethernet_udp(payload: bytes, ident: int) -> bytes:
    udp = struct.pack(">HHHH", 60000, DEST_PORT, 8 + len(payload), 0) + payload
    ip_header = struct.pack(
        ">BBHHHBBH4s4s",
        0x45,
        0,
        20 + len(udp),
        ident & 0xFFFF,
        0,
        64,
        17,
        0,
        bytes(int(o) for o in SRC_IP.split(".")),
        bytes(int(o) for o in DST_IP.split(".")),
    )
    ip_header = ip_header[:10] + struct.pack(">H", _ipv4_checksum(ip_header)) + ip_header[12:]
    return DST_MAC + SRC_MAC + b"\x08\x00" + ip_header + udp


def _block(block_type: int, body: bytes) -> bytes:
    padding = (-len(body)) % 4
    length = 12 + len(body) + padding
    return (
        struct.pack("<II", block_type, length)
        + body
        + bytes(padding)
        + struct.pack("<I", length)
    )


def write_pcapng(groups: list[list[bytes]], path: Path) -> int:
    """Write every datagram of every group as one Ethernet-framed EPB."""
    out = bytearray()
    out += _block(0x0A0D0D0A, struct.pack("<IHHq", 0x1A2B3C4D, 1, 0, -1))
    out += _block(0x00000001, struct.pack("<HHI", 1, 0, 0xFFFF))

    count = 0
    timestamp = 0
    for group in groups:
        for datagram in group:
            frame = _ethernet_udp(datagram, count)
            out += _block(
                0x00000006,
                struct.pack("<IIIII", 0, timestamp >> 32, timestamp & 0xFFFFFFFF, len(frame), len(frame))
                + frame
                + bytes((-len(frame)) % 4),
            )
            count += 1
        timestamp += FRAME_INTERVAL_US

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(out))
    return count


def default_output(fault_name: str) -> Path:
    suffix = "" if fault_name == "none" else f"-{fault_name}"
    return ROOT / "tools" / "oracle" / "out" / f"90-synth-acceptance{suffix}.pcapng"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fault", default="none", choices=sorted(FAULTS))
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--check",
        action="store_true",
        help="run the harness's verdict over the written file and print the report row",
    )
    args = parser.parse_args(argv)

    path = args.out or default_output(args.fault)
    groups = build_capture_frames(args.fault)
    datagrams = write_pcapng(groups, path)
    print(
        f"{path}: {len(groups) - 1} complete frames + 1 partial "
        f"({datagrams} datagrams), fault={args.fault}"
    )

    if args.check:
        from .decode_diff import verify_config
        from .report import to_table

        result = verify_config(ACCEPTANCE, path)
        print()
        print(to_table([result]))
        return 0 if result.passed else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
