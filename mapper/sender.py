"""UDP sender. The Python side of the floor-test path.

`tools/Send-FloorTest.ps1` remains the fallback and is deliberately left dumb —
raw protocol, no orientation transform, known byte-identical to Ledset at 8x5
`8x8_8P`. Two implementations of the orientation transform is how you get a
discrepancy you cannot diagnose. If this sender and that one disagree at the
floor, the fault is in the orientation layer, and that is the point.
"""

from __future__ import annotations

import itertools
import socket
import time
from typing import Callable, Iterable, Iterator

from .floors import DEST_ADDRESS, DEST_PORT, FloorConfig
from .frame import build_frame
from .orientation import IDENTITY, Orientation

#: MEASURED at the floor, 2026-08-08, attended. The vendor uses 10 and Phase 3
#: inherited it; a rate ceiling probe at 10/15/24/30/60 fps showed the floor
#: drops **no** frames at any of them, so 10 was never the ceiling — only the
#: vendor's habit. Real content is dramatically better above 10 and essentially
#: identical across 15–30. 60 renders faithfully but judders on fast hard-edged
#: motion, with no smoothness gain over 30. 30 is the top of the useful range.
DEFAULT_FPS = 30

#: The most `play` will adopt from a clip's own authored rate. A 60 fps source
#: is legal, plays every frame, and looks worse than the same content at 30 —
#: see `DEFAULT_FPS`. An explicit `--fps` is not capped: the cap protects the
#: automatic path, it does not overrule the operator.
MAX_ADOPTED_FPS = 30


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


def frame_numbers(duration: float | None, fps: int, total_frames: int | None) -> Iterable[int]:
    """The frame ordinals one `run` will send.

    Three ways to say how long, in precedence order:

    * `total_frames` wins outright. A loop count is an exact whole number of
      frames, and routing it through seconds and back would make it depend on
      float rounding at every `fps` that does not divide evenly.
    * `duration` in seconds, as before.
    * neither, meaning **forever** — the caller stops it with Ctrl-C.
    """
    if total_frames is not None:
        if total_frames < 1:
            raise ValueError(f"total_frames must be at least 1, got {total_frames}")
        return range(total_frames)
    if duration is None:
        return itertools.count()
    return range(max(1, int(round(duration * fps))))


def run(
    config: FloorConfig,
    frame_source: Callable[[int], bytes | bytearray],
    duration: float | None,
    orientation: Orientation = IDENTITY,
    fps: int = DEFAULT_FPS,
    eof: bool = True,
    color_order: str = "BGR",
    address: str = DEST_ADDRESS,
    port: int = DEST_PORT,
    local_ip: str | None = None,
    on_frame: Callable[[int, float], None] | None = None,
    total_frames: int | None = None,
) -> int:
    """Send `frame_source(n)` at `fps`, for a duration, a frame count, or forever.

    Frames are built ahead of the send and the loop is gapless — no blank frames
    at a loop boundary, which is the vendor defect this replaces.

    `KeyboardInterrupt` is caught rather than propagated: the infinite mode has
    no other exit, and a traceback in place of a packet count is a poor way to
    end every single send at the floor. The socket closes either way.
    """
    interval = 1.0 / fps
    sock = open_socket(local_ip)
    sent = 0
    start = time.perf_counter()
    try:
        for n in frame_numbers(duration, fps, total_frames):
            datagrams = build_frame(
                config, frame_source(n), orientation, eof=eof, color_order=color_order
            )
            sent += send_frame(sock, datagrams, address, port)
            if on_frame:
                on_frame(n, time.perf_counter() - start)
            remaining = start + (n + 1) * interval - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
    except KeyboardInterrupt:
        pass
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
