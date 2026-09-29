#!/usr/bin/env python3
"""Does `mapper stream` alone judder when fed a steady 30 fps, and at what phase?

**A measurement, not a gate.** Nothing runs it automatically, and nothing should.

    python3 tools/probe_stream_cadence.py                      # both geometries
    python3 tools/probe_stream_cadence.py --geometry 10x10 --repeats 1 --phases 4
    python3 tools/probe_stream_cadence.py --sender stock,sliced --phases 10   # the 2026-09-28 sweep

A full default run is 20 phases x 3 senders x 3 repeats x 2 geometries plus
controls -- about 80 minutes. Run nothing else on the machine meanwhile.

## The question

`app/test/e2e/probe-render-rate.mjs` found the app path juddering on the wire:
35-46 % of steps off-pattern at 30-on-30 with the renderer uncapped, and
0.2-36 % capped, bimodally (`captures/measurements/README.md`,
render-rate-2026-09-28). That probe sees only the end of the pipeline, so it
cannot say *which* handoff repeats or drops a frame:

    video frame -> compose -> writeFrame / pipe -> LatestFrame -> sender tick -> wire
    `------ handoff 1 ------'   `------------ handoff 2 -------------'

This is the first and cheapest arm of the attribution (docs/DECISIONS.md D-03,
reopened). It takes Chromium out entirely: a writer here feeds `mapper stream`
numbered frames on a steady `perf_counter` clock, and a UDP tap on 127.0.0.1
reads every wire frame's number back. If this alone reproduces the judder,
handoff 2 is sufficient to cause it; if it runs clean at every phase, the
judder is upstream of the pipe.

## Why phase is the independent variable

`sender.run()` schedules tick n at `start + (n + 1) / fps` on `perf_counter`.
A writer on the same clock at the same rate therefore holds **one fixed phase**
against the sender for a whole run. So the question is not "how often does it
judder" but "at which phases": the probe watches the sender's black lead-in
frames to find its tick grid, then starts the writer at a chosen offset into
the period, and sweeps that offset across the period. A 24 fps arm runs
alongside as the repeat detector's control.

In the app, the writer is `requestAnimationFrame` on the display clock, which
is not `perf_counter`, so the phase there drifts slowly through whatever this
map shows -- which is the shape a bimodal run-to-run spread would have.

## The senders (step 6, 2026-09-29)

`stock` is `mapper stream` as the app runs it (`--pacing clock`). `sliced` is
the runtime prototype of 2026-09-28, kept so that sweep stays re-runnable.
`precise` and `arrival` are the two candidate fixes, built into `mapper/`:
`precise` keeps the tick grid and wakes on it in 1 ms slices, and should be
clean except in a band narrower than the old 3.33 ms phase step -- hence 20
phases by default, 1.67 ms apart. `arrival` sends each frame as it lands,
so it has no tick grid and phase should not matter at all: its phase column
is measured against its own lead-in, and a result that varies with it would
itself be the finding. It sends black once at start and again every second
(`mapper.sender.MAX_SILENCE`), so its lead-in is two frames, not thirty.

## Graded, and declared before any data was taken (2026-09-29)

1. Off-pattern share by phase, per sender -- the judder itself.
2. **Wire-interval p99 and max, per run.** Index steps alone cannot see a
   sender that puts every frame out once but unevenly spaced, and `arrival`
   passes the writer's own jitter straight to the wire. Control 8 proves the
   tap can see that.
3. Write-end to first wire arrival (arrival-to-wire latency).

## Also reported: why each repeat happened

Every sender runs with `--emit-timing`, so for each frame it sent the probe
knows when the reader thread put it in the slot and when the sender woke and
read it. For each repeated index at 30 Hz, the frame that should have gone
was either still being written when the sender woke (**write after wake** --
the phase race, driven by when the sender wakes), or fully written but not
yet in the slot (**reader lag**). That settles the step-5 inference with a
measurement, rather than a monkeypatch that only showed sufficiency.

## What each wire frame carries

Frame k is a full framebuffer: bytes 0-1 are k, byte 2 is a marker, and every
other byte is `(i * 31 + k) & 0xFF`. A wire frame is reassembled by its
headers, un-mapped with `mapper`'s own `unpack_send_buffer`, and must match
that pattern **exactly** to decode. A torn, black, mis-mapped or partial frame
decodes to nothing, never to a plausible number.

## Positive controls -- a failure in any one means the instrument is broken

No table is printed, the reasons are, and the exit is 2.

 0. Before any run: frames built by `mapper`'s own `build_frame` decode to their
    index (including k > 255), and one flipped byte or a black frame decodes to
    nothing. (The decoder is not guessing at the mapping.)
 1. The sender exits 0, prints its packet count, and writes nothing to stderr.
 2. The sender's black lead-in was seen, so the tick grid was measured, not
    assumed.
 3. Inside each run's steady window, every wire frame is complete and >= 99 %
    decode.
 4. Wire rate within 29-31 fps for a metronome; at most 31 for `arrival`,
    whose rate falls when it skips -- the quantity under test, not a fault.
    **Changed after seeing data, 2026-09-29**, when the first smoke refused
    an `arrival` run for skipping 3.4 % under a well-timed writer.
 5. **Time axis**: frames advanced per wire second within +-2 % of the
    writer's rate (for a metronome, the same as mean step = `writer_hz / 30`).
    A decoder stuck on one index, or a lost run of frames, cannot satisfy it.
 6. **Repeat detector**, 24 fps arm: >= 15 % of steady steps are repeats.
    24-in-30 must repeat at least one step in five; a detector reading ~0 there
    is blind, and a clean 30 fps result from it would mean nothing.
 7. **Phase control**: writer jitter (actual write start minus target) p99
    under 2 ms. A writer that cannot hit its target cannot claim a phase.
    **Changed after seeing data, 2026-09-28**: a run refused by control 7 and
    nothing else is re-run once, and every re-run is printed with the refusal
    it replaced. A second control 7 failure, or any other control, still
    refuses the whole sweep. Why: two full sweeps each refused on one or two
    of ~130 runs, always in the OS wake from `time.sleep` -- the write before
    took under 0.2 ms, and a writer-only loop showed the same rare spikes --
    so a strict rule made a clean sweep a ~1-in-4 draw without making any run
    more trustworthy. The run it replaces is discarded, never averaged in.

 8. **Interval grade can see jitter**, once per geometry and repeat when
    `arrival` is swept: a 20 Hz writer given +-12 ms of deliberate jitter
    through `arrival` must show a wire-interval spread (p99 - p50) of at
    least 8 ms; clean runs show ~1-5 ms. A grade that reads that as even
    cannot certify anything as even. **Changed after seeing data,
    2026-09-29:** the first version put +-8 ms on a *30 Hz* writer, and
    `arrival` absorbed it -- p99 34.8 ms, refused. Its ceiling counts from
    when the last send was allowed, so the schedule settles one worst-case
    early frame behind the writer and every frame is then already waiting
    when the ceiling opens: bounded jitter on a same-rate writer becomes
    ~jitter of added latency, not uneven wire. A 20 Hz writer's gaps sit
    above the ceiling, so `arrival` must pass them through. The spread is
    graded rather than p99 so that a slower writer cannot pass for an
    uneven one.
 9. **Liveness in a writer pause**, on every 24 Hz control run: after the
    last write the writer holds its pipe open for 2.5 s. The wire must carry
    the last frame at least twice in that pause and never go quiet for more
    than 1.25 s (`arrival` declares a 1 s repeat). Controller 1 reverts to its own content ~5 s
    after packets stop; a sender that goes silent fails here, not at a show.
10. **Two instruments agree**: the sender's own `--emit-timing` record of
    what it sent, restricted to the steady window, is the same sequence of
    frames the tap decoded off the wire. A disagreement means one of them is
    lying, and the attribution built on the timing record would be too.

A 24 Hz run through `arrival` should show no repeats at all, so control 6 is
applied to the metronome senders only, and the sweep refuses to run without
one. `arrival`'s expected wire rate is the writer's, not 30.

A valid run exits 0 whatever the cadence numbers are. Cadence quality is the
quantity under test, so no control is written as a bound on it.

## What this does not establish

Loopback, one Mac, a Python writer. The writer shares `perf_counter` with the
sender, which the app's renderer does not, so a clean result here would not
clear handoff 2 for a writer on another clock -- it would say the mailbox is
safe at the phases measured. The tap timestamps packets in user space on a
thread of this process; `sys.setswitchinterval` is lowered to keep that
honest, and the wire-interval spread it reports bounds the error.
"""

from __future__ import annotations

import argparse
import os
import random
import socket
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from mapper.floors import FloorConfig  # noqa: E402
from mapper.frame import buffer_from_datagrams, build_frame, unpack_send_buffer  # noqa: E402

FLOOR_TYPE = "8x8_4P"
SENDER_FPS = 30
PERIOD = 1.0 / SENDER_FPS
#: Distinct from 60001-60004 and 60009, used by wire.mjs and the app probes.
PORT = 60_006
MARK = 0x5A
#: Seconds of the sender's black frames watched before writing, to fit its tick grid.
LEAD_IN = 1.0
#: Frames excluded at each end of a run's written range: start-up and drain.
EDGE = 15
WRITER_JITTER_P99_MAX = 0.002
#: Control 8: a writer rate whose gaps sit above the ceiling, deliberate jitter
#: on it (uniform +-), and the wire-interval spread (p99 - p50) that jitter
#: must produce through `arrival` for the interval grade to be trusted.
INJECTED_HZ = 20.0
INJECTED_JITTER = 0.012
INJECTED_SPREAD_MIN_MS = 8.0
#: Control 9: how long the writer pauses, and the longest wire silence allowed
#: in it -- `arrival`'s declared 1 s repeat plus margin. A literal, NOT imported
#: from `mapper.sender.MAX_SILENCE`: a bound that followed the sender would
#: pass a sender changed to go quiet for 5 s. Change it deliberately or not at all.
PAUSE = 2.5
SILENCE_BOUND = 1.25


@dataclass(frozen=True)
class Sender:
    argv: tuple[str, ...]  # before `stream`
    pacing: tuple[str, ...]  # after the geometry
    follows_writer: bool  # no tick grid: one wire frame per written frame


#: `sliced` is `stock` with one substitution made at runtime, not in `mapper/`:
#: `sender.run()`'s single `time.sleep` per tick becomes the 1 ms slices of
#: `sleep_until` below. It was the 2026-09-28 evidence that the sender's own
#: wake-up jitter is sufficient to cause the judder; `precise` is the same idea
#: built into `mapper/`.
SLICED_SENDER = """
import sys, time, types
import mapper.sender as sender

def sleep(seconds):
    end = time.perf_counter() + seconds
    while (remaining := end - time.perf_counter()) > 0:
        time.sleep(min(remaining, 0.001))

sender.time = types.SimpleNamespace(perf_counter=time.perf_counter, sleep=sleep)
from mapper.cli import main
sys.exit(main(sys.argv[1:]))
"""
SENDERS = {
    "stock": Sender(("-m", "mapper"), (), False),
    "sliced": Sender(("-c", SLICED_SENDER), (), False),
    "precise": Sender(("-m", "mapper"), ("--pacing", "precise"), False),
    "arrival": Sender(("-m", "mapper"), ("--pacing", "arrival"), True),
}


# --------------------------------------------------------------- the frames


class Frames:
    """Numbered framebuffers, and the exact inverse."""

    def __init__(self, frame_bytes: int) -> None:
        self._base = [bytes((i * 31 + k) & 0xFF for i in range(frame_bytes)) for k in range(256)]

    def frame(self, k: int) -> bytes:
        framebuffer = bytearray(self._base[k & 0xFF])
        framebuffer[0] = k & 0xFF
        framebuffer[1] = (k >> 8) & 0xFF
        framebuffer[2] = MARK
        return bytes(framebuffer)

    def decode(self, framebuffer: bytes | bytearray) -> int | None:
        if framebuffer[2] != MARK:
            return None
        k = framebuffer[0] | framebuffer[1] << 8
        if framebuffer[3:] != self._base[k & 0xFF][3:]:
            return None
        return k


def decode_datagrams(config: FloorConfig, frames: Frames, datagrams: list[bytes]) -> int | None:
    try:
        buffer = buffer_from_datagrams(config, datagrams)
    except ValueError:
        return None
    return frames.decode(unpack_send_buffer(config, buffer))


def control_decoder(config: FloorConfig, frames: Frames) -> list[str]:
    """Control 0: the decoder reads `mapper`'s own packets, and refuses a bad one."""
    problems = []
    for k in (1, 7, 255, 256, 1234):
        got = decode_datagrams(config, frames, build_frame(config, frames.frame(k)))
        if got != k:
            problems.append(f"control 0: frame {k} built by mapper decoded as {got}")
    flipped = bytearray(frames.frame(300))
    flipped[len(flipped) // 2] ^= 0x01
    if decode_datagrams(config, frames, build_frame(config, bytes(flipped))) is not None:
        problems.append("control 0: a frame with one flipped byte still decoded")
    black = bytes(config.pixel_count * 3)
    if decode_datagrams(config, frames, build_frame(config, black)) is not None:
        problems.append("control 0: a black frame decoded")
    return problems


# ------------------------------------------------------------------ the tap


class Tap:
    """Every datagram on 127.0.0.1:PORT, stamped with `perf_counter` on arrival."""

    def __init__(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
        self._sock.bind(("127.0.0.1", PORT))
        self._sock.settimeout(0.1)
        self._lock = threading.Lock()
        self._packets: list[tuple[float, bytes]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                data = self._sock.recv(65_535)
            except socket.timeout:
                continue
            t = time.perf_counter()
            with self._lock:
                self._packets.append((t, data))

    def take(self) -> list[tuple[float, bytes]]:
        with self._lock:
            packets, self._packets = self._packets, []
        return packets

    def peek(self) -> list[tuple[float, bytes]]:
        with self._lock:
            return list(self._packets)

    def close(self) -> None:
        self._stop.set()
        self._thread.join()
        self._sock.close()


@dataclass
class WireFrame:
    t: float  # first packet's arrival
    complete: bool
    index: int | None


def assemble(config: FloorConfig, frames: Frames, packets, decode: bool = True) -> list[WireFrame]:
    """Wire frames, split on the last controller's end-of-frame packet.

    The partial frame before the first end-of-frame is dropped.
    """
    last = config.controller_count - 1
    out: list[WireFrame] = []
    started = False
    current: list[tuple[float, bytes]] = []
    for t, packet in packets:
        ends = (packet[4] & 0x80) != 0 and packet[1] == last
        if not started:
            started = ends
            continue
        current.append((t, packet))
        if ends:
            datagrams = [p for _, p in current]
            complete = len(datagrams) == config.packets_per_frame
            index = decode_datagrams(config, frames, datagrams) if (complete and decode) else None
            out.append(WireFrame(current[0][0], complete, index))
            current = []
    return out


def tick_grid(times: list[float]) -> float:
    """A reference arrival on the sender's grid: the median residual from a
    PERIOD-spaced lattice anchored at the first arrival."""
    t0 = times[0]
    residuals = [(t - t0) - round((t - t0) / PERIOD) * PERIOD for t in times]
    return t0 + statistics.median(residuals)


def phase_of(t: float, ref: float, near: float) -> float:
    """Where `t` falls in the sender's period, unwrapped to within half a period
    of `near`, so writes scattered either side of the boundary do not split
    between ~0 and ~PERIOD and hand the median a value from neither."""
    phase = (t - ref) % PERIOD
    return phase + PERIOD * round((near - phase) / PERIOD)


# ------------------------------------------------------------------ one run


@dataclass
class Write:
    k: int
    target: float
    start: float
    end: float


@dataclass
class Timing:
    """One `--emit-timing` line: a frame the sender says it sent."""

    n: int
    read: float  # the sender took it from the slot
    sent: float  # it finished going out
    seq: int  # which write it was; 0 is the opening black
    wrote: float | None  # the reader thread put it in the slot


def parse_timing(stdout: bytes) -> list[Timing]:
    out = []
    for line in stdout.decode(errors="replace").splitlines():
        if not line.startswith("timing "):
            continue
        f = line.split()
        out.append(Timing(int(f[1]), float(f[3]), float(f[5]), int(f[7]),
                          None if f[9] == "-" else float(f[9])))
    return out


@dataclass
class Run:
    geometry: str
    sender: str
    writer_hz: float
    target_phase: float | None
    jitter: float = 0.0
    pause: float = 0.0
    problems: list[str] = field(default_factory=list)
    steps: dict[int, int] = field(default_factory=dict)
    steady: int = 0
    errors: int = 0
    repeats: int = 0
    mean_step: float = float("nan")
    wire_fps: float = float("nan")
    wire_sd_ms: float = float("nan")
    wire_p50_ms: float = float("nan")
    wire_p99_ms: float = float("nan")
    wire_max_ms: float = float("nan")
    jitter_p99_ms: float = float("nan")
    measured_phase_ms: float = float("nan")
    adoption_ms: list[float] = field(default_factory=list)
    # From the sender's own --emit-timing record.
    write_after_wake: int = 0
    reader_lag: int = 0
    race_margin_ms: list[float] = field(default_factory=list)
    reader_lag_ms: list[float] = field(default_factory=list)
    read_to_sent_ms: list[float] = field(default_factory=list)
    compared: bool = False
    pause_frames: int = 0
    pause_max_gap: float = float("nan")

    @property
    def is_control(self) -> bool:
        return self.writer_hz != SENDER_FPS or self.jitter > 0

    @property
    def error_pct(self) -> float:
        return 100.0 * self.errors / self.steady if self.steady else float("nan")

    @property
    def repeat_pct(self) -> float:
        return 100.0 * self.repeats / self.steady if self.steady else float("nan")


def sleep_until(target: float) -> None:
    """Sleep to `target` on `perf_counter`, in slices of at most 1 ms.

    MEASURED 2026-09-28 on the dev Mac, from a shell under Claude Code: one
    `time.sleep` of ~33 ms wakes 7-15 ms late (p50 6.7, max 15.5), because
    macOS grants timer leeway in proportion to the interval requested. In 1 ms
    slices the same loop lands p99 0.56 ms late. A single long sleep cannot
    hold a phase, so the writer uses this. `mapper/sender.py` has the same
    loop for `--pacing precise`; it is kept separate here so the writer never
    depends on the thing under test.
    """
    while True:
        remaining = target - time.perf_counter()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 0.001))


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def run_once(config, frames, tap, geometry, cols, rows, sender_kind, writer_hz, target_phase, window,
             jitter: float = 0.0, pause: float = 0.0, seed: int = 0) -> Run:
    run = Run(geometry, sender_kind, writer_hz, target_phase, jitter, pause)
    kind = SENDERS[sender_kind]
    rng = random.Random(seed)
    tap.take()
    sender = subprocess.Popen(
        [sys.executable, *kind.argv, "stream", "--type", FLOOR_TYPE,
         "--cols", str(cols), "--rows", str(rows), "--fps", str(SENDER_FPS),
         "--address", "127.0.0.1", "--port", str(PORT), *kind.pacing, "--emit-timing"],
        cwd=REPO_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    writes: list[Write] = []
    ref: float | None = None
    # A metronome shows its grid in a second of black; `arrival` sends black
    # once and then once a second, so two frames is its whole lead-in.
    lead_needed = 2 if kind.follows_writer else int(LEAD_IN * SENDER_FPS)
    pause_start = pause_end = None
    try:
        # Control 2: watch the black lead-in and fit the tick grid from it.
        deadline = time.perf_counter() + 5.0
        lead: list[WireFrame] = []
        while time.perf_counter() < deadline and sender.poll() is None:
            time.sleep(0.05)
            lead = assemble(config, frames, tap.peek(), decode=False)
            if len(lead) >= lead_needed:
                ref = tick_grid([f.t for f in lead])
                break
        if ref is None:
            # No early return: the sender's own exit status and stderr, read
            # below, are usually the reason, and must reach the refusal.
            run.problems.append(f"control 2: saw {len(lead)} lead-in frames in 5 s")
        else:
            interval = 1.0 / writer_hz
            now = time.perf_counter()
            if target_phase is None:
                first = now + 0.1
            else:
                first = ref + (int((now + 0.1 - ref) / PERIOD) + 1) * PERIOD + target_phase
            fd = sender.stdin.fileno()
            k = 1
            while True:
                target = first + (k - 1) * interval
                if target > first + window:
                    break
                if jitter:
                    target += rng.uniform(-jitter, jitter)
                payload = frames.frame(k)
                sleep_until(target)
                start = time.perf_counter()
                try:
                    write_all(fd, payload)
                except OSError as exc:
                    # The sender went away mid-run. That is a refusal with the
                    # sender's own account attached (control 1, below), never a
                    # traceback that takes every other run's evidence with it.
                    run.problems.append(f"control 1: write of frame {k} failed: {exc}")
                    break
                writes.append(Write(k, target, start, time.perf_counter()))
                k += 1
            if pause and writes:
                # Control 9: stdin stays open and silent; the sender must not.
                pause_start = writes[-1].end
                time.sleep(pause)
                pause_end = time.perf_counter()
    finally:
        # `communicate` closes stdin, which is the sender's end of input.
        try:
            out, err = sender.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            sender.kill()
            out, err = sender.communicate()
        time.sleep(0.1)

    # Control 1: the sender ended as a sender that worked.
    if sender.returncode != 0:
        run.problems.append(f"control 1: sender exited {sender.returncode}")
    if err.strip():
        run.problems.append(f"control 1: sender stderr: {err.decode(errors='replace').strip()[:300]}")
    if b"sent " not in out:
        run.problems.append("control 1: sender printed no packet count")

    wire = assemble(config, frames, tap.take())
    if ref is not None:
        analyse(run, kind, wire, writes, parse_timing(out), ref)
        if pause_start is not None:
            check_pause(run, wire, writes[-1].k, pause_start, pause_end)
    return run


def check_pause(run: Run, wire: list[WireFrame], last_k: int, pause_start: float, pause_end: float) -> None:
    """Control 9: the wire stays live, on the last frame, while the writer is silent."""
    # The last frame's own first send may land just after its write ended;
    # that is still the frame, not a repeat, so it anchors the gaps too.
    during = [f for f in wire if pause_start < f.t < pause_end]
    wrong = [f.index for f in during if f.index != last_k]
    points = [pause_start] + [f.t for f in during] + [pause_end]
    run.pause_frames = len(during)
    run.pause_max_gap = max(b - a for a, b in zip(points, points[1:]))
    if run.pause_frames < 2:
        run.problems.append(f"control 9: {run.pause_frames} wire frame(s) in a {run.pause:.1f} s writer pause")
    if run.pause_max_gap > SILENCE_BOUND:
        run.problems.append(f"control 9: wire silent {run.pause_max_gap:.2f} s during a writer pause "
                            f"(bound {SILENCE_BOUND:.2f} s)")
    if wrong:
        run.problems.append(f"control 9: pause carried {wrong[:5]}, not the last frame {last_k}")


def quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[int(q * (len(ordered) - 1))]


def analyse(run: Run, kind: Sender, wire: list[WireFrame], writes: list[Write],
            timing: list[Timing], ref: float) -> None:
    if len(writes) < 2 * EDGE + 10:
        run.problems.append(f"only {len(writes)} frames written")
        return
    lo, hi = writes[EDGE].k, writes[-EDGE].k
    # The steady window: wire frames from the first carrying `lo` or later to
    # the last carrying `hi` or earlier. Not `lo` and `hi` exactly -- a sender
    # that skips a frame is the thing under test, and may skip either of those;
    # the first full sweep refused four runs on exactly that. Undecoded frames
    # inside the window count against control 3.
    first = next((i for i, f in enumerate(wire) if f.index is not None and f.index >= lo), None)
    last = next((i for i in range(len(wire) - 1, -1, -1)
                 if wire[i].index is not None and wire[i].index <= hi), None)
    if first is None or last is None or last <= first:
        run.problems.append(f"control 3: no wire frames between {lo} and {hi}")
        return
    window = wire[first:last + 1]

    incomplete = sum(1 for f in window if not f.complete)
    undecoded = sum(1 for f in window if f.index is None)
    if incomplete:
        run.problems.append(f"control 3: {incomplete} incomplete wire frame(s) in the steady window")
    if undecoded > 0.01 * len(window):
        run.problems.append(f"control 3: {undecoded}/{len(window)} wire frames did not decode")

    # A metronome puts out SENDER_FPS whatever it is fed, so its rate is an
    # instrument check. `arrival` puts out what it is fed, up to that ceiling,
    # and a frame it skips lowers its rate -- which is the quantity under
    # test, so only the ceiling is checked there. **Changed after seeing
    # data, 2026-09-29:** the first smoke refused an `arrival` run for
    # skipping 3.4 % of frames under a well-timed writer; that is a result.
    span = window[-1].t - window[0].t
    run.wire_fps = (len(window) - 1) / span if span > 0 else float("nan")
    if kind.follows_writer:
        if not run.wire_fps <= SENDER_FPS + 1.0:
            run.problems.append(f"control 4: wire rate {run.wire_fps:.2f} fps over a {SENDER_FPS} fps ceiling")
    elif not SENDER_FPS - 1.0 <= run.wire_fps <= SENDER_FPS + 1.0:
        run.problems.append(f"control 4: wire rate {run.wire_fps:.2f} fps, expected {SENDER_FPS} +- 1")
    gaps = [(b.t - a.t) * 1e3 for a, b in zip(window, window[1:])]
    run.wire_sd_ms = statistics.pstdev(gaps)
    run.wire_p50_ms = quantile(gaps, 0.5)
    run.wire_p99_ms = quantile(gaps, 0.99)
    run.wire_max_ms = max(gaps)
    if run.jitter and run.wire_p99_ms - run.wire_p50_ms < INJECTED_SPREAD_MIN_MS:
        run.problems.append(f"control 8: +-{run.jitter * 1e3:g} ms of writer jitter through {run.sender} "
                            f"read as wire-interval p99 - p50 = {run.wire_p99_ms - run.wire_p50_ms:.1f} ms, "
                            f"needs >= {INJECTED_SPREAD_MIN_MS:g}: the interval grade cannot see unevenness")

    allowed = {1} if (kind.follows_writer or run.writer_hz == SENDER_FPS) else {0, 1}
    total = 0
    for a, b in zip(window, window[1:]):
        if a.index is None or b.index is None:
            continue
        step = b.index - a.index
        run.steps[step] = run.steps.get(step, 0) + 1
        run.steady += 1
        total += step
        if step not in allowed:
            run.errors += 1
    run.repeats = run.steps.get(0, 0)
    run.mean_step = total / run.steady if run.steady else float("nan")
    # Frames advanced per wire second must be the writer's rate, whatever the
    # sender repeats or skips along the way -- for a metronome that is the
    # same test as mean step = writer_hz / 30, and it holds for `arrival` too.
    index_rate = total / span if span > 0 else float("nan")
    if not abs(index_rate - run.writer_hz) <= 0.02 * run.writer_hz:
        run.problems.append(f"control 5: frames advance {index_rate:.2f}/s on the wire, "
                            f"the writer wrote {run.writer_hz:g}/s")
    if not kind.follows_writer and run.writer_hz != SENDER_FPS and run.repeat_pct < 15.0:
        run.problems.append(f"control 6: 24 fps arm shows {run.repeat_pct:.1f} % repeats, needs >= 15 %")

    steady_writes = [w for w in writes if lo <= w.k <= hi]
    jitter = sorted(w.start - w.target for w in steady_writes)
    p99 = jitter[int(0.99 * (len(jitter) - 1))]
    run.jitter_p99_ms = p99 * 1e3
    if p99 > WRITER_JITTER_P99_MAX:
        # Which writes, so a burst (one stall that cost several ticks) reads
        # differently from scattered late wakes.
        late = [f"{w.k}:{(w.start - w.target) * 1e3:.1f}" for w in steady_writes
                if w.start - w.target > WRITER_JITTER_P99_MAX]
        run.problems.append(f"control 7: writer jitter p99 {run.jitter_p99_ms:.2f} ms; "
                            f"{len(late)} late writes (frame:ms) {' '.join(late[:12])}")

    # The phase actually held, against a grid re-fitted from the whole window,
    # and how long each frame sat written before it first reached the wire.
    grid = tick_grid([f.t for f in window])
    near = run.target_phase if run.target_phase is not None else 0.0
    run.measured_phase_ms = statistics.median(phase_of(w.start, grid, near) for w in steady_writes) * 1e3
    first_seen: dict[int, float] = {}
    for f in window:
        if f.index is not None and f.index not in first_seen:
            first_seen[f.index] = f.t
    run.adoption_ms = [(first_seen[w.k] - w.end) * 1e3 for w in steady_writes if w.k in first_seen]

    # Control 10: the sender's record of what it sent is what the tap saw.
    told = [t.seq for t in timing if lo <= t.seq <= hi]
    seen = [f.index for f in window if f.index is not None]
    if not told:
        run.problems.append("control 10: the sender printed no --emit-timing lines in the steady window")
    elif undecoded == 0:
        run.compared = True
        # The wire window may start or end on a frame the sender also sent
        # just outside it, so compare the sender's record trimmed to the
        # wire's first and last index.
        a = told.index(seen[0]) if seen[0] in told else None
        b = len(told) - 1 - told[::-1].index(seen[-1]) if seen[-1] in told else None
        if a is None or b is None or told[a:b + 1] != seen:
            run.problems.append(f"control 10: sender sent {len(told)} steady frames, tap decoded "
                                f"{len(seen)}, and the sequences differ")

    # Why each repeat happened, from the sender's side (see the module doc).
    by_k = {w.k: w for w in writes}
    steady_timing = [t for t in timing if lo <= t.seq <= hi]
    for t in steady_timing:
        if t.wrote is not None and t.seq in by_k:
            run.reader_lag_ms.append((t.wrote - by_k[t.seq].end) * 1e3)
        run.read_to_sent_ms.append((t.sent - t.read) * 1e3)
    if not run.is_control:
        for prev, t in zip(steady_timing, steady_timing[1:]):
            if t.seq != prev.seq:
                continue
            due = by_k.get(t.seq + 1)
            if due is None:
                continue
            margin = (due.end - t.read) * 1e3
            run.race_margin_ms.append(margin)
            if margin > 0:
                run.write_after_wake += 1
            else:
                run.reader_lag += 1


def where(run: Run) -> str:
    return f"{run.geometry} {run.sender} {run.writer_hz:g} Hz" + (
        f" phase {run.target_phase * 1e3:.2f} ms" if run.target_phase is not None else "") + (
        f" jitter +-{run.jitter * 1e3:g} ms" if run.jitter else "")


def run_valid(reruns: list[str], *args, **kwargs) -> Run:
    """`run_once`, re-run once if control 7 alone refused it (see control 7)."""
    run = run_once(*args, **kwargs)
    if run.problems and all(p.startswith("control 7:") for p in run.problems):
        reruns.append(f"{where(run)}: {run.problems[0]}")
        run = run_once(*args, **kwargs)
    return run


# ------------------------------------------------------------------- report


def pct(v: float) -> str:
    return "-" if v != v else f"{v:5.1f}%"


def spread(values: list[float]) -> str:
    """p1 / p50 / p99 / max of a pooled sample, in ms."""
    if not values:
        return "no samples"
    return (f"p1 {quantile(values, 0.01):.2f}  p50 {quantile(values, 0.5):.2f}  "
            f"p99 {quantile(values, 0.99):.2f}  max {max(values):.2f} ms")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--geometry", default="10x10,10x12", help="comma-separated COLSxROWS")
    parser.add_argument("--phases", type=int, default=20, help="writer phases across one period")
    parser.add_argument("--repeats", type=int, default=3, help="sweeps per geometry")
    parser.add_argument("--window", type=float, default=10.0, help="seconds written per run")
    parser.add_argument("--seed", type=int, default=None, help="shuffle phase order with this seed")
    parser.add_argument("--sender", default="stock,precise,arrival",
                        help=f"comma-separated, of {', '.join(SENDERS)}")
    args = parser.parse_args(argv)
    senders = args.sender.split(",")
    unknown = [k for k in senders if k not in SENDERS]
    if unknown:
        parser.error(f"unknown sender(s): {', '.join(unknown)}")
    if all(SENDERS[k].follows_writer for k in senders):
        parser.error("control 6 (the repeat detector) needs a metronome sender: add stock, sliced or precise")

    sys.setswitchinterval(1e-4)
    print(f"command: {' '.join([Path(sys.argv[0]).name] + (argv if argv is not None else sys.argv[1:]))}")
    print(f"python {sys.version.split()[0]}, sender --fps {SENDER_FPS}, loopback port {PORT}")

    refusals: list[str] = []
    reruns: list[str] = []
    runs: list[Run] = []
    tap = Tap()
    try:
        for geometry in args.geometry.split(","):
            cols, rows = (int(v) for v in geometry.split("x"))
            config = FloorConfig.of(FLOOR_TYPE, cols, rows)
            frames = Frames(config.pixel_count * 3)
            problems = control_decoder(config, frames)
            if problems:
                refusals += [f"{geometry}: {p}" for p in problems]
                continue
            phases = [i * PERIOD / args.phases for i in range(args.phases)]
            common = (config, frames, tap, geometry, cols, rows)
            for rep in range(args.repeats):
                order = list(phases)
                if args.seed is not None:
                    random.Random(args.seed + rep).shuffle(order)
                # Senders alternate at each phase, so a slow drift in machine
                # state lands on every arm rather than on whichever ran last.
                for phase in order:
                    for kind in senders:
                        run = run_valid(reruns, *common, kind, SENDER_FPS, phase, args.window)
                        runs.append(run)
                        print(f"  {geometry} {kind:>7} 30 Hz phase {phase * 1e3:5.2f} ms  rep {rep + 1}: "
                              f"{pct(run.error_pct)} off-pattern, wire p99 {run.wire_p99_ms:5.1f} ms"
                              + (" REFUSED" if run.problems else ""), flush=True)
                for kind in senders:
                    run = run_valid(reruns, *common, kind, 24.0, None, args.window, pause=PAUSE)
                    runs.append(run)
                    print(f"  {geometry} {kind:>7} 24 Hz control      rep {rep + 1}: "
                          f"{pct(run.repeat_pct)} repeats, {run.pause_frames} frames in the pause"
                          + (" REFUSED" if run.problems else ""), flush=True)
                if "arrival" in senders:
                    run = run_valid(reruns, *common, "arrival", INJECTED_HZ, None, args.window,
                                    jitter=INJECTED_JITTER, seed=rep)
                    runs.append(run)
                    print(f"  {geometry} arrival {INJECTED_HZ:g} Hz +-{INJECTED_JITTER * 1e3:g} ms jitter control "
                          f"rep {rep + 1}: wire p50 {run.wire_p50_ms:.1f} p99 {run.wire_p99_ms:.1f} ms"
                          + (" REFUSED" if run.problems else ""), flush=True)
    finally:
        tap.close()

    print(f"\nre-run after control 7 alone refused (the first attempt is discarded): {len(reruns)}")
    for line in reruns:
        print(f"  {line}")
    for run in runs:
        refusals += [f"{where(run)}: {p}" for p in run.problems]
    compared = sum(r.compared for r in runs)
    print(f"control 10 compared sender and tap on {compared}/{len(runs)} runs "
          "(skipped only where a wire frame in the window did not decode)")
    if refusals:
        print("\nREFUSED -- the instrument is broken; no table is printed.")
        for line in refusals:
            print(f"  {line}")
        return 2

    for geometry, kind in ((g, k) for g in args.geometry.split(",") for k in senders):
        mine = [r for r in runs if r.geometry == geometry and r.sender == kind]
        sweep = [r for r in mine if not r.is_control]
        control = [r for r in mine if r.writer_hz != SENDER_FPS and not r.jitter]
        print(f"\n== {FLOOR_TYPE} {geometry}, {kind} sender: 30 Hz writer, by phase ==")
        if SENDERS[kind].follows_writer:
            print("  phase = writer start against a grid fitted to this sender's own lead-in and")
            print("  wire; it has no tick, so nothing here should depend on phase.")
        else:
            print("  phase = writer start minus the sender's tick, as fitted from the wire.")
        print("  off-pattern = steps other than +1, as a share of steady steps (ideal 0 %).")
        print("  p99 = wire-interval p99 of that run, ms (graded; ideal ~33.3).")
        print(f"  {'target ms':>9}  {'held ms':>8}  "
              + "  ".join(f"{'rep ' + str(i + 1):>14}" for i in range(args.repeats)))
        for phase in sorted({r.target_phase for r in sweep}):
            row = [r for r in sweep if r.target_phase == phase]
            held = statistics.median(r.measured_phase_ms for r in row)
            print(f"  {phase * 1e3:9.2f}  {held:8.2f}  "
                  + "  ".join(f"{pct(r.error_pct):>6} p99 {r.wire_p99_ms:4.1f}" for r in row))
        print(f"  GRADE wire interval: per-run p50 {min(r.wire_p50_ms for r in sweep):.2f}-"
              f"{max(r.wire_p50_ms for r in sweep):.2f} ms, per-run p99 {min(r.wire_p99_ms for r in sweep):.2f}-"
              f"{max(r.wire_p99_ms for r in sweep):.2f} ms, per-run max "
              f"{min(r.wire_max_ms for r in sweep):.2f}-{max(r.wire_max_ms for r in sweep):.2f} ms, "
              f"sd {min(r.wire_sd_ms for r in sweep):.2f}-{max(r.wire_sd_ms for r in sweep):.2f} ms")
        print(f"  GRADE write-end to first wire arrival: {spread([v for r in sweep for v in r.adoption_ms])}")
        print(f"  wire rate {min(r.wire_fps for r in sweep):.2f}-{max(r.wire_fps for r in sweep):.2f} fps; "
              f"writer jitter p99, worst run: {max(r.jitter_p99_ms for r in sweep):.3f} ms")
        steps: dict[int, int] = {}
        for r in sweep:
            for s, n in r.steps.items():
                steps[s] = steps.get(s, 0) + n
        print("  step histogram, all 30 Hz runs: " + ", ".join(f"{s:+d}: {n}" for s, n in sorted(steps.items())))
        after_wake = sum(r.write_after_wake for r in sweep)
        lag = sum(r.reader_lag for r in sweep)
        print(f"  repeats, by the sender's own timing: {after_wake} write still in progress when the sender "
              f"woke, {lag} written but not yet in the slot (reader lag)")
        margins = [v for r in sweep for v in r.race_margin_ms]
        if margins:
            print(f"    write end minus sender wake, at those repeats: {spread(margins)}")
        print(f"  reader lag (slot write minus writer's write end), every frame: "
              f"{spread([v for r in sweep for v in r.reader_lag_ms])}")
        print(f"  sender read to send complete: {spread([v for r in sweep for v in r.read_to_sent_ms])}")
        print("\n  24 Hz control (repeat detector, then a writer pause): " + ", ".join(
            f"{pct(r.repeat_pct).strip()} repeats / mean step {r.mean_step:.3f} / "
            f"{r.pause_frames} frames in pause, longest silence {r.pause_max_gap:.2f} s" for r in control))
        jittered = [r for r in mine if r.jitter]
        if jittered:
            print(f"  {INJECTED_HZ:g} Hz +-{INJECTED_JITTER * 1e3:g} ms writer jitter control, wire p99 - p50: "
                  + ", ".join(f"{r.wire_p99_ms - r.wire_p50_ms:.1f}" for r in jittered)
                  + f" ms (needs >= {INJECTED_SPREAD_MIN_MS:g})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
