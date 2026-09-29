#!/usr/bin/env python3
"""Does `mapper stream` alone judder when fed a steady 30 fps, and at what phase?

**A measurement, not a gate.** Nothing runs it automatically, and nothing should.

    python3 tools/probe_stream_cadence.py                      # both geometries
    python3 tools/probe_stream_cadence.py --geometry 10x10 --repeats 1 --phases 4

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
 4. Wire rate within 29-31 fps.
 5. **Time axis**: mean step within +-2 % of `writer_hz / 30`. A decoder stuck
    on one index, or a lost run of frames, cannot satisfy it.
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

#: The two senders compared. `stock` is `mapper stream` exactly as the app runs
#: it. `sliced` is the same code with one substitution made at runtime, not in
#: `mapper/`: `sender.run()`'s single `time.sleep` per tick becomes the 1 ms
#: slices of `sleep_until` below. If `sliced` runs clean where `stock` judders,
#: the sender's own wake-up jitter is sufficient to cause it.
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
    "stock": ["-m", "mapper"],
    "sliced": ["-c", SLICED_SENDER],
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
class Run:
    geometry: str
    sender: str
    writer_hz: float
    target_phase: float | None
    problems: list[str] = field(default_factory=list)
    steps: dict[int, int] = field(default_factory=dict)
    steady: int = 0
    errors: int = 0
    repeats: int = 0
    mean_step: float = float("nan")
    wire_fps: float = float("nan")
    wire_sd_ms: float = float("nan")
    wire_max_ms: float = float("nan")
    jitter_p99_ms: float = float("nan")
    measured_phase_ms: float = float("nan")
    adoption_ms: list[float] = field(default_factory=list)

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
    hold a phase, so the writer uses this. `mapper/sender.py` does *not* -- it
    sleeps once per tick -- and that is left alone here, because the sender is
    the thing under test.
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


def run_once(config, frames, tap, geometry, cols, rows, sender_kind, writer_hz, target_phase, window) -> Run:
    run = Run(geometry, sender_kind, writer_hz, target_phase)
    tap.take()
    sender = subprocess.Popen(
        [sys.executable, *SENDERS[sender_kind], "stream", "--type", FLOOR_TYPE,
         "--cols", str(cols), "--rows", str(rows), "--fps", str(SENDER_FPS),
         "--address", "127.0.0.1", "--port", str(PORT)],
        cwd=REPO_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    writes: list[Write] = []
    ref: float | None = None
    try:
        # Control 2: watch the black lead-in and fit the tick grid from it.
        deadline = time.perf_counter() + 5.0
        lead: list[WireFrame] = []
        while time.perf_counter() < deadline and sender.poll() is None:
            time.sleep(0.05)
            lead = assemble(config, frames, tap.peek(), decode=False)
            if len(lead) >= LEAD_IN * SENDER_FPS:
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
        analyse(run, wire, writes, ref)
    return run


def analyse(run: Run, wire: list[WireFrame], writes: list[Write], ref: float) -> None:
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

    span = window[-1].t - window[0].t
    run.wire_fps = (len(window) - 1) / span if span > 0 else float("nan")
    if not 29.0 <= run.wire_fps <= 31.0:
        run.problems.append(f"control 4: wire rate {run.wire_fps:.2f} fps")
    gaps = [(b.t - a.t) * 1e3 for a, b in zip(window, window[1:])]
    run.wire_sd_ms = statistics.pstdev(gaps)
    run.wire_max_ms = max(gaps)

    allowed = {1} if run.writer_hz == SENDER_FPS else {0, 1}
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
    expected = run.writer_hz / SENDER_FPS
    if not abs(run.mean_step - expected) <= 0.02 * expected:
        run.problems.append(f"control 5: mean step {run.mean_step:.3f}, expected {expected:.3f}")
    if run.writer_hz != SENDER_FPS and run.repeat_pct < 15.0:
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


def where(run: Run) -> str:
    return f"{run.geometry} {run.sender} {run.writer_hz:g} Hz" + (
        f" phase {run.target_phase * 1e3:.2f} ms" if run.target_phase is not None else "")


def run_valid(reruns: list[str], *args) -> Run:
    """`run_once`, re-run once if control 7 alone refused it (see control 7)."""
    run = run_once(*args)
    if run.problems and all(p.startswith("control 7:") for p in run.problems):
        reruns.append(f"{where(run)}: {run.problems[0]}")
        run = run_once(*args)
    return run


# ------------------------------------------------------------------- report


def pct(v: float) -> str:
    return "-" if v != v else f"{v:5.1f}%"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--geometry", default="10x10,10x12", help="comma-separated COLSxROWS")
    parser.add_argument("--phases", type=int, default=10, help="writer phases across one period")
    parser.add_argument("--repeats", type=int, default=3, help="sweeps per geometry")
    parser.add_argument("--window", type=float, default=10.0, help="seconds written per run")
    parser.add_argument("--seed", type=int, default=None, help="shuffle phase order with this seed")
    parser.add_argument("--sender", default="stock,sliced", help=f"comma-separated, of {', '.join(SENDERS)}")
    args = parser.parse_args(argv)
    senders = args.sender.split(",")
    unknown = [k for k in senders if k not in SENDERS]
    if unknown:
        parser.error(f"unknown sender(s): {', '.join(unknown)}")

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
            for rep in range(args.repeats):
                order = list(phases)
                if args.seed is not None:
                    random.Random(args.seed + rep).shuffle(order)
                # Senders alternate at each phase, so a slow drift in machine
                # state lands on both arms rather than on whichever ran last.
                for phase in order:
                    for kind in senders:
                        run = run_valid(reruns, config, frames, tap, geometry, cols, rows, kind, SENDER_FPS,
                                        phase, args.window)
                        runs.append(run)
                        print(f"  {geometry} {kind:>6} 30 Hz phase {phase * 1e3:5.2f} ms  rep {rep + 1}: "
                              f"{pct(run.error_pct)} off-pattern" + (" REFUSED" if run.problems else ""),
                              flush=True)
                for kind in senders:
                    run = run_valid(reruns, config, frames, tap, geometry, cols, rows, kind, 24.0, None, args.window)
                    runs.append(run)
                    print(f"  {geometry} {kind:>6} 24 Hz control      rep {rep + 1}: "
                          f"{pct(run.repeat_pct)} repeats" + (" REFUSED" if run.problems else ""), flush=True)
    finally:
        tap.close()

    print(f"\nre-run after control 7 alone refused (the first attempt is discarded): {len(reruns)}")
    for line in reruns:
        print(f"  {line}")
    for run in runs:
        refusals += [f"{where(run)}: {p}" for p in run.problems]
    if refusals:
        print("\nREFUSED -- the instrument is broken; no table is printed.")
        for line in refusals:
            print(f"  {line}")
        return 2

    for geometry, kind in ((g, k) for g in args.geometry.split(",") for k in senders):
        mine = [r for r in runs if r.geometry == geometry and r.sender == kind]
        sweep = [r for r in mine if r.writer_hz == SENDER_FPS]
        control = [r for r in mine if r.writer_hz != SENDER_FPS]
        print(f"\n== {FLOOR_TYPE} {geometry}, {kind} sender: 30 Hz writer on the sender's clock, by phase ==")
        print("  phase = writer start minus the sender's tick, as fitted from the wire.")
        print("  off-pattern = steps other than +1, as a share of steady steps (ideal 0 %).")
        print(f"  {'target ms':>9}  {'held ms':>8}  " + "  ".join(f"{'rep ' + str(i + 1):>7}" for i in range(args.repeats)))
        for phase in sorted({r.target_phase for r in sweep}):
            row = [r for r in sweep if r.target_phase == phase]
            held = statistics.median(r.measured_phase_ms for r in row)
            print(f"  {phase * 1e3:9.2f}  {held:8.2f}  " + "  ".join(f"{pct(r.error_pct):>7}" for r in row))
        adoption = sorted(v for r in sweep for v in r.adoption_ms)
        q = lambda p: adoption[int(p * (len(adoption) - 1))]  # noqa: E731
        print(f"  write-end to first wire arrival: p1 {q(0.01):.2f}  p50 {q(0.5):.2f}  "
              f"p99 {q(0.99):.2f}  max {adoption[-1]:.2f} ms")
        print(f"  writer jitter p99, worst run: {max(r.jitter_p99_ms for r in sweep):.3f} ms")
        print(f"  wire interval sd {min(r.wire_sd_ms for r in mine):.2f}-{max(r.wire_sd_ms for r in mine):.2f} ms, "
              f"max {max(r.wire_max_ms for r in mine):.2f} ms, rate "
              f"{min(r.wire_fps for r in mine):.2f}-{max(r.wire_fps for r in mine):.2f} fps")
        steps: dict[int, int] = {}
        for r in sweep:
            for s, n in r.steps.items():
                steps[s] = steps.get(s, 0) + n
        print("  step histogram, all 30 Hz runs: " + ", ".join(f"{s:+d}: {n}" for s, n in sorted(steps.items())))
        print(f"\n  24 Hz control (repeat detector): " + ", ".join(
            f"{pct(r.repeat_pct).strip()} repeats / mean step {r.mean_step:.3f}" for r in control))
    return 0


if __name__ == "__main__":
    sys.exit(main())
