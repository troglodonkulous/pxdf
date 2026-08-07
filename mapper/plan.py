"""The packet plan: every datagram of one frame, headers and lengths, no payload.

This is the piece that generalises. The vendor's send loop is reproduced exactly
as decompiled, including the partial last controller, so a plan can be checked
against a capture without generating a single pixel.
"""

from __future__ import annotations

from dataclasses import dataclass

from .floors import BODY_MAX, CONST_BYTE2, EOF_FLAG, HEADER_LEN, MAGIC, FloorConfig


@dataclass(frozen=True)
class PacketSpec:
    """One datagram's addressing, without its body."""

    ordinal: int
    controller: int
    port: int
    packet_index: int
    byte4: int
    body_len: int
    #: Byte offset of this packet's body within its port's payload.
    port_offset: int
    #: Global tile column this port carries, = ports_per_controller * c + port.
    tile_col: int

    @property
    def datagram_len(self) -> int:
        return self.body_len + HEADER_LEN

    @property
    def is_eof(self) -> bool:
        return bool(self.byte4 & EOF_FLAG)

    @property
    def header(self) -> bytes:
        return bytes((MAGIC, self.controller, CONST_BYTE2, self.port, self.byte4))

    def as_row(self) -> tuple[int, int, int, int, int]:
        """The manifest form: `(controller, port, packetIndex, byte4, length)`."""
        return (self.controller, self.port, self.packet_index, self.byte4, self.datagram_len)


def build_plan(config: FloorConfig, eof: bool = True) -> tuple[PacketSpec, ...]:
    """Every packet of one frame, in the order the vendor emits them.

    `eof=False` suppresses the 0x80 end-of-frame flag. The floor never latches
    without it — that is the point of being able to turn it off.
    """
    ports_per_controller = config.type.ports_per_controller
    port_data_size = config.port_data_size
    packets_per_port = config.packets_per_port

    packets: list[PacketSpec] = []
    for controller in range(config.controller_count):
        ports_here = config.ports_on(controller)
        for port in range(ports_here):
            for packet_index in range(packets_per_port):
                port_offset = packet_index * BODY_MAX
                body_len = BODY_MAX
                byte4 = packet_index
                if packet_index == packets_per_port - 1:
                    body_len = port_data_size - port_offset
                    if port == ports_here - 1 and eof:
                        byte4 = packet_index | EOF_FLAG
                packets.append(
                    PacketSpec(
                        ordinal=len(packets),
                        controller=controller,
                        port=port,
                        packet_index=packet_index,
                        byte4=byte4,
                        body_len=body_len,
                        port_offset=port_offset,
                        tile_col=ports_per_controller * controller + port,
                    )
                )
    return tuple(packets)


def format_plan(config: FloorConfig, plan: tuple[PacketSpec, ...]) -> str:
    """The `-DryRun` table, for eyeballing a plan next to Ledset."""
    lines = [
        config.describe(),
        "",
        f"{'idx':>4} {'ctrl':>4} {'port':>4} {'pkt':>4} {'byte4':>6} {'len':>5} {'portOff':>8}",
    ]
    for p in plan:
        lines.append(
            f"{p.ordinal:>4} {p.controller:>4} {p.port:>4} {p.packet_index:>4} "
            f"  0x{p.byte4:02X} {p.datagram_len:>5} {p.port_offset:>8}"
        )
    eof_count = sum(1 for p in plan if p.is_eof)
    lines += [
        "",
        f"{len(plan)} packets, {sum(p.datagram_len for p in plan)} bytes/frame, "
        f"{eof_count} end-of-frame flag(s)",
    ]
    return "\n".join(lines)
