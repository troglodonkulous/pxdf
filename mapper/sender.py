"""UDP sender. The Python side of the floor-test path.

`tools/Send-FloorTest.ps1` remains the fallback and is deliberately left dumb —
raw protocol, no orientation transform, known byte-identical to Ledset at 8x5
`8x8_8P`. Two implementations of the orientation transform is how you get a
discrepancy you cannot diagnose. If this sender and that one disagree at the
floor, the fault is in the orientation layer, and that is the point.
"""

from __future__ import annotations

import socket
import time
from typing import Callable, Iterator

from .floors import DEST_ADDRESS, DEST_PORT, FloorConfig
from .frame import build_frame
from .orientation import IDENTITY, Orientation

#: What the vendor uses, and what the user has confirmed as optimal.
DEFAULT_FPS = 10


def open_socket(local_ip: str | None = None) -> socket.socket:
    """A broadcast UDP socket, set up the way the vendor's `screenSend.dll` does."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1_228_800)
    if local_ip:
        # A machine with both Wi-Fi and Ethernet will otherwise broadcast out
        # whichever the routing table prefers, which is rarely the floor.
        sock.bind((local_ip, 0))
    return sock


def send_frame(sock: socket.socket, datagrams: list[bytes], address: str, port: int) -> int:
    """Blast one frame. No inter-packet delay, as the vendor does."""
    destination = (address, port)
    for datagram in datagrams:
        sock.sendto(datagram, destination)
    return len(datagrams)


def run(
    config: FloorConfig,
    frame_source: Callable[[int], bytes | bytearray],
    duration: float,
    orientation: Orientation = IDENTITY,
    fps: int = DEFAULT_FPS,
    eof: bool = True,
    color_order: str = "BGR",
    address: str = DEST_ADDRESS,
    port: int = DEST_PORT,
    local_ip: str | None = None,
    on_frame: Callable[[int, float], None] | None = None,
) -> int:
    """Send `frame_source(n)` at `fps` for `duration` seconds.

    Frames are built ahead of the send and the loop is gapless — no blank frames
    at a loop boundary, which is the vendor defect this replaces.
    """
    total_frames = max(1, int(round(duration * fps)))
    interval = 1.0 / fps
    sock = open_socket(local_ip)
    sent = 0
    start = time.perf_counter()
    try:
        for n in range(total_frames):
            datagrams = build_frame(
                config, frame_source(n), orientation, eof=eof, color_order=color_order
            )
            sent += send_frame(sock, datagrams, address, port)
            if on_frame:
                on_frame(n, time.perf_counter() - start)
            remaining = start + (n + 1) * interval - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
    finally:
        sock.close()
    return sent


def dry_run(
    config: FloorConfig,
    frame_source: Callable[[int], bytes | bytearray],
    orientation: Orientation = IDENTITY,
    eof: bool = True,
) -> Iterator[bytes]:
    """The datagrams of frame 0, without touching the network."""
    yield from build_frame(config, frame_source(0), orientation, eof=eof)
