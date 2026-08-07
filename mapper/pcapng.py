"""Minimal pcapng reader — enough to pull our UDP payloads out of a capture.

Deliberately dependency-free and deliberately narrow: Ethernet + IPv4 + UDP,
which is all the floor ever carries. Anything else is skipped rather than
guessed at.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

SHB = 0x0A0D0D0A
IDB = 0x00000001
EPB = 0x00000006
SPB = 0x00000003

LINKTYPE_ETHERNET = 1


@dataclass(frozen=True)
class Datagram:
    """One captured UDP datagram."""

    ordinal: int
    src_ip: str
    src_port: int
    dst_ip: str
    dst_port: int
    payload: bytes


def _blocks(data: bytes) -> Iterator[tuple[int, bytes, str]]:
    """Yield `(block_type, body, endian_prefix)` in file order."""
    offset = 0
    endian = "<"
    while offset + 12 <= len(data):
        (block_type,) = struct.unpack_from("<I", data, offset)
        if block_type == SHB:
            (magic,) = struct.unpack_from("<I", data, offset + 8)
            endian = "<" if magic == 0x1A2B3C4D else ">"
        (length,) = struct.unpack_from(endian + "I", data, offset + 4)
        if length < 12 or offset + length > len(data):
            break
        yield block_type, data[offset + 8 : offset + length - 4], endian
        offset += length


def _parse_ethernet_udp(frame: bytes) -> tuple[str, int, str, int, bytes] | None:
    if len(frame) < 34 or struct.unpack_from(">H", frame, 12)[0] != 0x0800:
        return None
    ihl = (frame[14] & 0x0F) * 4
    if frame[14] >> 4 != 4 or frame[14 + 9] != 17:
        return None
    src_ip = ".".join(str(b) for b in frame[26:30])
    dst_ip = ".".join(str(b) for b in frame[30:34])
    udp = 14 + ihl
    if len(frame) < udp + 8:
        return None
    src_port, dst_port, udp_len = struct.unpack_from(">HHH", frame, udp)
    payload = frame[udp + 8 : udp + max(8, udp_len)]
    return src_ip, src_port, dst_ip, dst_port, payload


def read_udp(path: str | Path, dst_port: int | None = None) -> list[Datagram]:
    """Every UDP datagram in a pcapng, optionally filtered by destination port."""
    data = Path(path).read_bytes()
    link_types: list[int] = []
    out: list[Datagram] = []

    for block_type, body, endian in _blocks(data):
        if block_type == IDB:
            link_types.append(struct.unpack_from(endian + "H", body, 0)[0])
            continue
        if block_type == EPB:
            interface, _, _, captured = struct.unpack_from(endian + "IIII", body, 0)
            frame = body[20 : 20 + captured]
        elif block_type == SPB:
            interface = 0
            frame = body[4:]
        else:
            continue
        if interface < len(link_types) and link_types[interface] != LINKTYPE_ETHERNET:
            continue
        parsed = _parse_ethernet_udp(frame)
        if parsed is None:
            continue
        src_ip, src_port, dst_ip, port, payload = parsed
        if dst_port is not None and port != dst_port:
            continue
        out.append(Datagram(len(out), src_ip, src_port, dst_ip, port, payload))
    return out


def split_frames(datagrams: list[Datagram]) -> list[list[Datagram]]:
    """Group datagrams into frames.

    Cut on the first repeat of a `(controller, port, packetIndex)` triple. That
    triple is unique within a frame at every geometry, so this needs no prior
    knowledge of the layout — unlike counting the 0x80 flags, which requires
    knowing the controller count up front.
    """
    frames: list[list[Datagram]] = []
    current: list[Datagram] = []
    seen: set[tuple[int, int, int]] = set()
    for datagram in datagrams:
        payload = datagram.payload
        if len(payload) < 5 or payload[0] != 0xFF:
            continue
        key = (payload[1], payload[3], payload[4] & 0x7F)
        if key in seen:
            frames.append(current)
            current = []
            seen = set()
        seen.add(key)
        current.append(datagram)
    if current:
        frames.append(current)
    return frames
