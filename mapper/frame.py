"""Logical framebuffer -> send buffer -> datagrams.

The framebuffer is plain RGB, 3 bytes per pixel, top-left origin, row-major.
Colour order conversion to the wire's BGR happens once, here, at pack time.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from .floors import BODY_MAX, FloorConfig
from .orientation import IDENTITY, Orientation
from .plan import PacketSpec, build_plan


@dataclass(frozen=True)
class Address:
    """Where one logical pixel lands on the wire."""

    controller: int
    port: int
    packet_index: int
    body_offset: int

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.controller, self.port, self.packet_index, self.body_offset)


def pixel_address(
    config: FloorConfig, x: int, y: int, orientation: Orientation = IDENTITY
) -> Address:
    """Resolve logical pixel `(x, y)` to `(controller, port, packet, offset)`."""
    if not (0 <= x < config.width_px and 0 <= y < config.height_px):
        raise IndexError(f"pixel ({x}, {y}) outside {config.width_px}x{config.height_px}")
    offset_in_port, tile_col = _port_offset(config, orientation, x, y)
    controller, port = divmod(tile_col, config.type.ports_per_controller)
    packet_index, body_offset = divmod(offset_in_port, BODY_MAX)
    return Address(controller, port, packet_index, body_offset)


def _port_offset(
    config: FloorConfig, orientation: Orientation, x: int, y: int
) -> tuple[int, int]:
    """`(offset within the port payload, global tile column)`."""
    tile_px = config.type.tile_px
    x, y = orientation.to_wire(config, x, y)
    tile_col, x_in = divmod(x, tile_px)
    tile_row, y_in = divmod(y, tile_px)
    slot = config.type.slot_of_source[y_in * tile_px + x_in]
    return tile_row * config.type.bytes_per_tile + slot * 3, tile_col


@lru_cache(maxsize=8)
def send_buffer_sources(
    config: FloorConfig, orientation: Orientation = IDENTITY
) -> tuple[int, ...]:
    """Send-buffer pixel slot -> source framebuffer pixel index.

    Slot `i` occupies send-buffer bytes `3i .. 3i+2`. Building this array *is*
    the bijection proof: it starts unfilled, every logical pixel writes exactly
    one entry, and a collision or a hole raises.
    """
    total = config.pixel_count
    sources = [-1] * total
    width = config.width_px
    bytes_per_tile = config.type.bytes_per_tile
    port_data_size = config.port_data_size

    for y in range(config.height_px):
        row_base = y * width
        for x in range(width):
            offset_in_port, tile_col = _port_offset(config, orientation, x, y)
            slot = (tile_col * port_data_size + offset_in_port) // 3
            if sources[slot] != -1:
                raise AssertionError(
                    f"send-buffer slot {slot} claimed twice: by pixel "
                    f"{divmod(sources[slot], width)[::-1]} and ({x}, {y}) on {config.describe()}"
                )
            sources[slot] = row_base + x

    if -1 in sources:
        raise AssertionError(
            f"send buffer has {sources.count(-1)} unfilled slot(s) on {config.describe()}"
        )
    return tuple(sources)


def pack_send_buffer(
    config: FloorConfig,
    framebuffer: bytes | bytearray,
    orientation: Orientation = IDENTITY,
    color_order: str = "BGR",
) -> bytearray:
    """RGB framebuffer -> the contiguous buffer the packets are sliced from."""
    expected = config.pixel_count * 3
    if len(framebuffer) != expected:
        raise ValueError(f"framebuffer is {len(framebuffer)} bytes, expected {expected}")
    if color_order not in ("BGR", "RGB"):
        raise ValueError(f"unknown colour order {color_order!r}")

    sources = send_buffer_sources(config, orientation)
    buffer = bytearray(expected)
    if color_order == "BGR":
        for slot, source in enumerate(sources):
            s = source * 3
            d = slot * 3
            buffer[d] = framebuffer[s + 2]
            buffer[d + 1] = framebuffer[s + 1]
            buffer[d + 2] = framebuffer[s]
    else:
        for slot, source in enumerate(sources):
            s = source * 3
            buffer[slot * 3 : slot * 3 + 3] = framebuffer[s : s + 3]
    return buffer


def build_frame(
    config: FloorConfig,
    framebuffer: bytes | bytearray,
    orientation: Orientation = IDENTITY,
    eof: bool = True,
    color_order: str = "BGR",
) -> list[bytes]:
    """One frame as an ordered list of datagrams, ready for `sendto`."""
    buffer = pack_send_buffer(config, framebuffer, orientation, color_order)
    return datagrams_from_buffer(config, buffer, build_plan(config, eof=eof))


def unpack_send_buffer(
    config: FloorConfig,
    buffer: bytes | bytearray,
    orientation: Orientation = IDENTITY,
    color_order: str = "BGR",
) -> bytearray:
    """Send buffer -> RGB framebuffer. The inverse of `pack_send_buffer`.

    Used to read a capture back into an image, so a Ledset frame can be checked
    against what the source video actually showed rather than against our own
    guess at its bytes.
    """
    expected = config.pixel_count * 3
    if len(buffer) != expected:
        raise ValueError(f"send buffer is {len(buffer)} bytes, expected {expected}")

    sources = send_buffer_sources(config, orientation)
    framebuffer = bytearray(expected)
    for slot, source in enumerate(sources):
        s = slot * 3
        d = source * 3
        if color_order == "BGR":
            framebuffer[d] = buffer[s + 2]
            framebuffer[d + 1] = buffer[s + 1]
            framebuffer[d + 2] = buffer[s]
        else:
            framebuffer[d : d + 3] = buffer[s : s + 3]
    return framebuffer


def buffer_from_datagrams(config: FloorConfig, datagrams: list[bytes]) -> bytearray:
    """Reassemble a send buffer from one frame's datagrams, by their headers.

    Ignores the order they arrived in and trusts the headers, so a capture that
    interleaves or reorders still reassembles.
    """
    buffer = bytearray(config.pixel_count * 3)
    filled = bytearray(len(buffer))
    ports_per_controller = config.type.ports_per_controller
    for datagram in datagrams:
        controller, port, byte4 = datagram[1], datagram[3], datagram[4]
        tile_col = ports_per_controller * controller + port
        start = tile_col * config.port_data_size + (byte4 & 0x7F) * BODY_MAX
        body = datagram[5:]
        buffer[start : start + len(body)] = body
        for i in range(start, start + len(body)):
            filled[i] = 1
    missing = len(filled) - sum(filled)
    if missing:
        raise ValueError(f"frame is incomplete: {missing} unfilled bytes")
    return buffer


def datagrams_from_buffer(
    config: FloorConfig, buffer: bytes | bytearray, plan: tuple[PacketSpec, ...]
) -> list[bytes]:
    """Slice an already-packed send buffer according to a packet plan."""
    port_data_size = config.port_data_size
    out: list[bytes] = []
    for packet in plan:
        start = packet.tile_col * port_data_size + packet.port_offset
        out.append(packet.header + bytes(buffer[start : start + packet.body_len]))
    return out
