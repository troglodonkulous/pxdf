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

#: The longest `on_arrival` pacing goes without sending. A HYPOTHESIS, not a
#: measurement: nothing yet picks the value. It exists because controller 1 in
#: Master/IR mode reverts to the vendor's local content ~5 s after packets
#: stop, so a writer that goes quiet must not take the wire quiet with it. It
#: is well under that timeout and nowhere near one tick -- a max silence of
#: ~33 ms would be the metronome again, phase relation and all.
MAX_SILENCE = 1.0

#: What `run` calls between frames in place of its own sleep:
#: `pace(n, start, sent)`, with frame n's ordinal, the loop's start and the
#: moment frame n finished going out, all on `time.perf_counter`.
Pace = Callable[[int, float, float], None]


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
    address: str = DEST_ADDRESS,
    port: int = DEST_PORT,
    local_ip: str | None = None,
    on_frame: Callable[[int, float], None] | None = None,
    total_frames: int | None = None,
    pace: Pace | None = None,
) -> int:
    """Send `frame_source(n)` at `fps`, for a duration, a frame count, or forever.

    Frames are built ahead of the send and the loop is gapless — no blank frames
    at a loop boundary, which is the vendor defect this replaces.

    `pace`, when given, decides when the next frame goes, in place of the one
    `time.sleep` per tick below. Only `mapper stream` passes one, and only when
    asked (docs/DECISIONS.md D-02); `play` and `send` never do, so their timing
    is the loop below, unchanged. No pace changes a byte: it only moves when
    `frame_source` is next asked.

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
            datagrams = build_frame(config, frame_source(n), orientation, eof=eof)
            sent += send_frame(sock, datagrams, address, port)
            sent_at = time.perf_counter()
            if on_frame:
                on_frame(n, sent_at - start)
            if pace is not None:
                pace(n, start, sent_at)
                continue
            remaining = start + (n + 1) * interval - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
    return sent


def sleep_until(deadline: float) -> None:
    """Sleep to `deadline` on `perf_counter`, in slices of at most 1 ms.

    MEASURED 2026-09-28 on the dev Mac: one `time.sleep` of ~33 ms wakes 7-15 ms
    late (p50 6.7, max 15.5), because macOS grants timer leeway in proportion
    to the interval requested; in 1 ms slices the same loop lands p99 0.56 ms
    late (`tools/probe_stream_cadence.py`, whose writer uses the same loop).
    Never returns before `deadline`.
    """
    while (remaining := deadline - time.perf_counter()) > 0:
        time.sleep(min(remaining, 0.001))


def precise_clock(fps: int) -> Pace:
    """`run`'s own metronome grid, slept to in 1 ms slices rather than one sleep.

    Candidate (a) for the stream judder: the same tick schedule as the default,
    `start + (n + 1) / fps`, woken on time. It narrows the band of writer
    phases that collide with a tick; it cannot remove it, because a writer and
    a metronome on different clocks still drift through whatever band is left.
    """
    interval = 1.0 / fps

    def pace(n: int, start: float, sent: float) -> None:
        sleep_until(start + (n + 1) * interval)

    return pace


def on_arrival(
    fps: int,
    wait_for_new: Callable[[float], bool],
    max_silence: float = MAX_SILENCE,
) -> Pace:
    """Send when a new frame arrives, no faster than `fps`, never silent for long.

    Candidate (b) for the stream judder: there is no tick for a write to
    collide with, so no phase relation to drift through. The costs are the
    writer's own jitter, which now reaches the wire, and a hard dependence on
    the ceiling and the repeat being right:

    * **Ceiling.** The next send is allowed exactly `1/fps` after the
      previous one was *allowed* -- not after it actually went out -- so no
      `fps + 1` sends ever fit in `fps` intervals. No early tolerance: the
      renderer's 4 ms pacing tolerance (`framePacing.ts`) is the renderer's,
      and the sender borrowing it would sustain more than `fps`. A frame that
      arrives inside the ceiling is not queued: the send that follows reads
      whatever is newest by then.

      Why "allowed", MEASURED 2026-09-29 on the first loopback smoke: counted
      from the actual send, a 30 Hz writer has zero slack against a 30 fps
      ceiling, so each send's own ~2 ms (build, send, wake overshoot) carried
      into every later ceiling. Lateness climbed 2 -> 35 ms over ~15 frames,
      then a frame was skipped and it began again -- a 2 Hz judder, the defect
      this mode exists to remove. Anchored to the schedule, one gap can be
      short by the previous send's lateness; the lateness cannot accumulate.

      But a schedule left in the past must not be chased. After a multi-tick
      stall every ceiling up to "now" is already open, and a writer faster
      than `fps` would get frames out back to back until the schedule caught
      up (found by review; `test_a_stalled_send_does_not_burst_to_catch_up`).
      So the ceiling is also never earlier than half a tick after the last
      actual send: a late send of up to half a tick is absorbed by the
      schedule -- the measured cost of a send is 1.8 ms p50 at 10 x 5 and
      4.1 ms p50 / 10.7 ms max at 10 x 12 -- and a later one restarts the
      schedule from itself. No two sends are ever closer than half a tick.

      That one half-tick gap after a stall is a choice, made by the owner
      2026-09-29 over a strict "no gap under 1/fps": strict is the ratchet
      above, so this mode would lose its comparison by construction. Across
      simulated random stalls with writers at 30-120 Hz the worst rate is 38
      fps over 2 gaps, 31.4 over 10 and 30.4 over 30 -- never sustained above
      `fps`. The default `clock` is looser still: after a stall its overdue
      ticks go back to back.
    * **Maximum silence.** With nothing new, the newest frame goes again
      `max_silence` after the last send (see `MAX_SILENCE`).

    `wait_for_new(timeout)` blocks until a frame not yet handed out arrives,
    the input ends, or `timeout` passes. It needs no atomic hand-off with the
    deadline: whichever wakes it, `run` then asks the slot for the newest frame,
    so an arrival that lands just after the timeout is still the one sent, and
    reading it is what marks it sent.

    The first frame -- the slot's opening black -- goes before any pace is
    consulted, so a stream with no input yet still holds the floor dark at once.
    """
    interval = 1.0 / fps
    #: When the ceiling let the last send go. Frame 0 was allowed at the start.
    allowed: float | None = None

    def pace(n: int, start: float, sent: float) -> None:
        nonlocal allowed
        ceiling = max(
            (start if allowed is None else allowed) + interval,
            sent + interval / 2,
        )
        sleep_until(ceiling)
        if wait_for_new(0):
            # Already waiting when the ceiling opened: the ceiling released it.
            allowed = ceiling
        else:
            # The writer is the late one; this send is allowed when it wakes
            # us, or when the silence runs out.
            wait_for_new(sent + max_silence - time.perf_counter())
            allowed = max(ceiling, time.perf_counter())

    return pace


def dry_run(
    config: FloorConfig,
    frame_source: Callable[[int], bytes | bytearray],
    orientation: Orientation = IDENTITY,
    eof: bool = True,
) -> Iterator[bytes]:
    """The datagrams of frame 0, without touching the network."""
    yield from build_frame(config, frame_source(0), orientation, eof=eof)
