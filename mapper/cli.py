"""Command line front end.

    python -m mapper plan     --type 8x8_4P --cols 10 --rows 5
    python -m mapper matrix
    python -m mapper fixtures --out fixtures
    python -m mapper xml      --type 8x8_4P --cols 10 --rows 5 --out Test3.xml
    python -m mapper verify   captures/02-white.pcapng --type 8x8_8P --cols 8 --rows 5 \\
                              --pattern white
    python -m mapper send     --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 \\
                              --duration 5 --dry-run
    python -m mapper play     tools/oracle/media/09-gradient24-8x8_4P-10x5.avi \\
                              --type 8x8_4P --cols 10 --rows 5 --duration 30
    python -m mapper stream   --type 8x8_4P --cols 10 --rows 12 < frames.rgb
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import threading
import time
import traceback
from pathlib import Path

from . import fixtures as fixtures_module
from . import mapper_xml
from .avi import read_video
from .floors import FLOOR_TYPES, FloorConfig, legal_configs
from .frame import send_buffer_sources
from .orientation import Orientation
from .patterns import PATTERNS, tile
from .plan import build_plan, format_plan
from .sender import DEFAULT_FPS, MAX_ADOPTED_FPS, dry_run, on_arrival, run
from .verify import format_diffs, verify_capture
from .video import framebuffers


def _add_geometry(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--type", required=True, choices=sorted(FLOOR_TYPES))
    parser.add_argument("--cols", required=True, type=int, help="tile columns")
    parser.add_argument("--rows", required=True, type=int, help="tile rows")
    parser.add_argument(
        "--orientation",
        default="identity",
        help="identity | rotate180 | mirrorX | reverseColumnsPerController, joined by +",
    )


def _config(args) -> FloorConfig:
    return FloorConfig.of(args.type, args.cols, args.rows)


def _framebuffer(args, config):
    if args.pattern == "tile":
        return tile(config, args.tile_col, args.tile_row)
    return PATTERNS[args.pattern](config)


def _dry_run(config, frame_source, orientation: Orientation, eof: bool) -> int:
    """Print the plan and a digest of frame 0. Nothing touches the network.

    The digest is what makes `play` and `send` comparable at the command line.
    On `09-gradient24-8x8_4P-10x5.avi` the two must agree exactly — that is the
    acceptance bar for the cutover off Ledset — and a byte count alone would
    have shown nothing, since every wrong permutation of a frame is the same
    number of bytes as the right one.
    """
    datagrams = list(dry_run(config, frame_source, orientation, eof=eof))
    print(format_plan(config, build_plan(config, eof=eof)))
    print(f"frame 0 is {sum(len(d) for d in datagrams)} bytes, nothing sent")
    print(f"frame 0 sha256: {hashlib.sha256(b''.join(datagrams)).hexdigest()}")
    return 0


def cmd_plan(args) -> int:
    config = _config(args)
    print(format_plan(config, build_plan(config, eof=not args.no_eof)))
    return 0


def cmd_matrix(args) -> int:
    """Run the invariants over every legal geometry and report a summary."""
    checked = 0
    pixels = 0
    for config in legal_configs(supported_only=args.supported_only):
        plan = build_plan(config)
        assert len(plan) == config.packets_per_frame
        assert sum(p.datagram_len for p in plan) == config.bytes_per_frame
        assert sum(1 for p in plan if p.is_eof) == config.controller_count
        if not args.plan_only:
            send_buffer_sources(config, Orientation.parse(args.orientation))
            pixels += config.pixel_count
        checked += 1
        if args.verbose:
            print(config.describe())
    scope = "supported floor types" if args.supported_only else "all floor types"
    print(f"{checked} legal configurations checked across {scope}")
    if not args.plan_only:
        print(f"{pixels:,} pixels placed, every one at a unique wire slot")
    return 0


def cmd_fixtures(args) -> int:
    try:
        written = fixtures_module.emit(args.out, force=args.force)
    except fixtures_module.FixturesExist as exc:
        print(exc, file=sys.stderr)
        return 2
    for path in written:
        print(path)
    print(f"{len(written)} file(s) written to {Path(args.out).resolve()}")
    return 0


def cmd_xml(args) -> int:
    config = _config(args)
    text = mapper_xml.to_xml(config)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}: {config.describe()}")
    else:
        print(text)
    return 0


def cmd_verify(args) -> int:
    config = _config(args)
    diffs = verify_capture(
        args.capture,
        config,
        _framebuffer(args, config),
        Orientation.parse(args.orientation),
        eof=not args.no_eof,
    )
    if not diffs:
        print("no complete frames found in the capture")
        return 1
    print(format_diffs(config, diffs))
    bad = [i for i, d in enumerate(diffs) if not d.ok]
    if not bad:
        return 0
    # This used to be `any(d.ok ...)`, i.e. one matching frame out of 46 exited
    # 0 — `verify` reported success on a mapping that was wrong 45 times out of
    # 46, which is the one thing this command exists not to do. Mismatches must
    # be named and budgeted, never averaged away: Ledset's own defects (two
    # loop-boundary blanks per capture, the occasional torn frame) are real and
    # expected, so they are declared with --allow-mismatch rather than silently
    # tolerated. See `mapper/tests/test_oracle_capture.py`.
    print(f"differing frames: {', '.join(str(i) for i in bad)}", file=sys.stderr)
    if len(bad) <= args.allow_mismatch:
        print(f"within the --allow-mismatch {args.allow_mismatch} budget", file=sys.stderr)
        return 0
    return 1


def cmd_send(args) -> int:
    config = _config(args)
    orientation = Orientation.parse(args.orientation)
    framebuffer = _framebuffer(args, config)

    print(config.describe())
    print(f"orientation: {orientation.describe()}   pattern: {args.pattern}")

    if args.dry_run:
        return _dry_run(config, lambda n: framebuffer, orientation, eof=not args.no_eof)

    print(
        f"sending to {args.address}:{args.port} at {args.fps} fps for {args.duration}s"
        + (f" from {args.local_ip}" if args.local_ip else "")
    )
    sent = run(
        config,
        lambda n: framebuffer,
        duration=args.duration,
        orientation=orientation,
        fps=args.fps,
        eof=not args.no_eof,
        address=args.address,
        port=args.port,
        local_ip=args.local_ip,
    )
    print(f"sent {sent} packets")
    return 0


def _resolve_fps(args, clip_fps: float | None) -> int:
    """Decide the send rate: the clip's own, capped, unless `--fps` says otherwise.

    Settled at the floor on 2026-08-08 rather than argued about here. Both
    behaviours were built and played back to back on the same file one flag
    apart, and adopting the clip's own rate won: a clip authored at 25 and sent
    at the project default plays at the wrong speed, and no byte comparison
    anywhere in this project can see it — every individual frame is correct and
    only the spacing between them is wrong.

    The cap is the other half of the same session. The floor drops no frames up
    to 60 fps, but 60 judders on fast hard-edged motion for no gain over 30, so
    an automatic path must not walk a 60 fps source into it. `--fps` is checked
    first and is never capped: this protects the default, not the operator.
    """
    if args.fps is not None:
        return args.fps
    if clip_fps is None:
        return DEFAULT_FPS

    rate = int(round(clip_fps))
    if abs(clip_fps - rate) > 0.001:
        # 30000/1001 and friends. `run` takes a whole number of frames per
        # second, and a fractional rate only reaches here from a file this
        # repo did not write — `make_clip` normalises it on the way through.
        print(
            f"note: clip is {clip_fps:.3f} fps; sending at {rate} -- the sender "
            f"takes a whole number of frames per second",
            file=sys.stderr,
        )
    if rate > MAX_ADOPTED_FPS:
        print(
            f"note: clip is authored at {rate} fps; sending at {MAX_ADOPTED_FPS} -- "
            f"measured at the floor, above {MAX_ADOPTED_FPS} judders on fast motion "
            f"for no gain. Pass --fps {rate} to override.",
            file=sys.stderr,
        )
        return MAX_ADOPTED_FPS
    return rate


def cmd_play(args) -> int:
    config = _config(args)
    orientation = Orientation.parse(args.orientation)

    # Decode the whole clip before anything opens a socket. A wrong-geometry
    # asset must fail here, not at frame 0 with the floor already being
    # broadcast to; and at 1.28 ms to build a frame against a 100 ms interval,
    # a per-frame decode on the send loop is the one thing that could
    # reintroduce the gaps this command exists to remove.
    try:
        video = read_video(args.video)
        frames = framebuffers(video, config)
    except ValueError as exc:
        # A wrong-geometry asset and an unreadable one are both ordinary
        # operator errors — `tools/make_clip.py` exists to fix the first — and
        # neither deserves a traceback.
        print(f"{args.video}: {exc}", file=sys.stderr)
        return 2
    if not frames:
        print(f"{args.video} holds no frames", file=sys.stderr)
        return 2

    fps = _resolve_fps(args, video.fps)

    print(config.describe())
    print(f"orientation: {orientation.describe()}   video: {args.video} ({len(frames)} frames)")

    # The list is built once and indexed modulo its length, so a loop boundary
    # is not a special case at all. Ledset emits three blank frames at every
    # one of its own, measured twice at this geometry.
    def frame_source(n: int) -> bytes:
        return frames[n % len(frames)]

    if args.dry_run:
        return _dry_run(config, frame_source, orientation, eof=not args.no_eof)

    # Three mutually exclusive ways to say how long, and a default of exactly
    # one pass. Inheriting `send`'s five seconds would stop a 60-frame clip at
    # 10 fps two thirds of the way through, which is a strange thing for a
    # command whose argument is a whole video to do.
    if args.forever:
        duration, total_frames, how = None, None, "until interrupted"
    elif args.loop is not None:
        total = args.loop * len(frames)
        duration, total_frames, how = None, total, f"for {args.loop} loop(s), {total} frames"
    elif args.duration is not None:
        duration, total_frames, how = args.duration, None, f"for {args.duration}s"
    else:
        total = len(frames)
        duration, total_frames, how = None, total, f"for one pass, {total} frames"

    print(
        f"sending to {args.address}:{args.port} at {fps} fps {how}"
        + (f" from {args.local_ip}" if args.local_ip else "")
    )
    sent = run(
        config,
        frame_source,
        duration=duration,
        orientation=orientation,
        fps=fps,
        eof=not args.no_eof,
        address=args.address,
        port=args.port,
        local_ip=args.local_ip,
        total_frames=total_frames,
    )
    print(f"sent {sent} packets")
    return 0


#: `mapper stream` could not use the socket at all — almost always a floor NIC
#: that has gone away under a live sender. Distinct from 1 so a human reading a
#: log or shell status can tell "the network went away" from "the sender is
#: broken". No supervisor reads this value today; interface polling decides
#: whether the app suspends the sender.
EXIT_NETWORK_GONE = 3


def _exit_now(code: int) -> None:
    """Leave without running interpreter finalisation.

    MEASURED 2026-08-13, from a crash report and reproduced off-hardware
    (`mapper/tests/test_stream_exit.py`): the stdin reader below is a **daemon
    thread parked inside `read()`**, and it holds the `BufferedReader`'s lock
    for as long as it is parked. Returning normally from an error path sends the
    main thread into `Py_FinalizeEx`, which deallocates `sys.stdin`, whose
    `close()` reaches `_enter_buffered_busy`, which cannot take that lock and
    calls `abort()`.

    That is SIGABRT — exit 134, and a macOS "python quit unexpectedly" dialog
    per respawn, forever, because the app's supervisor restarts the sender. The
    operator's only recourse was killing the app from a terminal.

    The daemon thread is deliberate and stays: the reader blocks on a pipe
    nobody may still be writing to, and there is no way to interrupt that read
    from here. So the exit is what changes. Everything this process had to say
    is flushed first; a process that *threw* must still read as one that threw,
    just not as one that crashed.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


class LatestFrame:
    """A one-slot mailbox between a stdin reader and the send loop.

    The renderer and the sender run on different clocks and neither may wait for
    the other: the sender's metronome is the thing the floor was graded against,
    and a renderer that misses a deadline must cost a repeated frame, never a
    gap. So the reader only ever overwrites this slot and the sender only ever
    reads the newest thing in it. That is the whole of the double-buffering
    requirement, satisfied by construction rather than by a second code path —
    a stalled writer re-sends the previous frame automatically, because the
    previous frame is what is still sitting here.

    The slot starts black rather than empty. A stream that has not produced its
    first frame yet must hold the floor dark; if it instead held off sending,
    controller 1 would time out ~5 s after packets stop and revert to the
    vendor's local content, which looks exactly like a working floor showing
    the wrong show.

    Under `--pacing arrival` the sender also *waits* here, on `wait_for_new`,
    which is why the lock is a condition. A frame counts as handed out when the
    sender reads it, and the sender reads a frame only to send it at once.

    Each write is stamped on `perf_counter`, and `adopted` says which write the
    last `read` handed out and when it was written. That is what
    `--emit-timing` reports; the stamp costs one clock read per frame whether
    or not anyone asks.
    """

    def __init__(self, frame_bytes: int) -> None:
        self._lock = threading.Condition()
        self._size = frame_bytes
        self._frame = bytes(frame_bytes)
        self._written = 0
        self._written_at: float | None = None
        self._handed_out = 0
        self._eof = False
        #: (write number, when written, when read) of the frame the last `read`
        #: returned. Write number 0 is the opening black, never written.
        self.adopted: tuple[int, float | None, float | None] = (0, None, None)

    def write(self, frame: bytes) -> None:
        written_at = time.perf_counter()
        with self._lock:
            self._frame = frame
            self._written += 1
            self._written_at = written_at
            self._lock.notify_all()

    def read(self) -> bytes:
        """Hand the newest frame to the sender, recording that we did."""
        with self._lock:
            # Stamped under the lock, so a write can never appear to land
            # after the read that handed it out.
            self._handed_out = self._written
            self.adopted = (self._written, self._written_at, time.perf_counter())
            return self._frame

    def wait_for_new(self, timeout: float) -> bool:
        """Block until a frame not yet handed out arrives, the input ends, or `timeout`.

        True if there is a new frame to send. End of input wakes the wait too,
        so a sender with nothing left to send is not parked for a whole
        maximum silence before it notices it is done.
        """
        with self._lock:
            return self._lock.wait_for(
                lambda: self._written > self._handed_out or self._eof,
                timeout=max(timeout, 0.0),
            ) and self._written > self._handed_out

    def close(self) -> None:
        with self._lock:
            self._eof = True
            self._lock.notify_all()

    def drained(self) -> bool:
        """True once the input has ended and its last frame has been sent."""
        with self._lock:
            return self._eof and self._handed_out >= self._written

    def pump(self, stream) -> None:
        """Read whole frames off `stream` until it ends. Runs on the reader thread.

        A short read is end of stream, and a trailing partial frame is dropped:
        half a framebuffer mapped onto the floor is not a degraded picture, it
        is a wrong one.
        """
        while True:
            frame = read_frame(stream, self._size)
            if frame is None:
                break
            self.write(frame)
        self.close()


def read_frame(stream, size: int) -> bytes | None:
    """Read exactly `size` bytes, or None if the stream ends first.

    A pipe hands over whatever it has, so one `read` is not one frame; the loop
    is what makes the byte contract below true regardless of how the renderer
    happens to flush.
    """
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _frame_digest(config, framebuffer: bytes, orientation: Orientation, eof: bool) -> str:
    """sha256 over the datagrams one framebuffer becomes on the wire.

    This rebuilds the frame a second time, off the send path. It is a gating
    aid — it is how a `stream` frame is compared against the `send` digest in
    the verification bar — and not something the show runs through.
    """
    datagrams = dry_run(config, lambda n: framebuffer, orientation, eof=eof)
    return hashlib.sha256(b"".join(datagrams)).hexdigest()


def cmd_stream(args) -> int:
    """Send raw framebuffers arriving on stdin, on the sender's own clock.

    This is the seam between the macOS app and the only hardware-graded code in
    the repo. The app renders and composites; `mapper` owns the wire, unchanged.

    The byte contract, which is the documented renderer-to-sidecar protocol:
    stdin is a raw byte stream of back-to-back frames, each exactly
    `config.pixel_count * 3` bytes, row-major RGB, top-left origin, with no
    header, no length prefix and no delimiter between frames. A short read is
    end of stream, and a trailing partial frame is discarded.
    """
    config = _config(args)
    orientation = Orientation.parse(args.orientation)
    frame_bytes = config.pixel_count * 3

    print(config.describe())
    print(f"orientation: {orientation.describe()}   source: stdin ({frame_bytes} bytes/frame)")

    if args.dry_run:
        # No thread, no socket and no metronome: read the frames straight
        # through and report what each one would have become. Timing is the
        # only thing this path cannot tell you about, and timing is the one
        # thing a digest was never going to show.
        n = 0
        while True:
            framebuffer = read_frame(sys.stdin.buffer, frame_bytes)
            if framebuffer is None:
                break
            digest = _frame_digest(config, framebuffer, orientation, eof=not args.no_eof)
            print(f"frame {n} sha256: {digest}")
            n += 1
        print(f"{n} frame(s) read, nothing sent")
        return 0

    latest = LatestFrame(frame_bytes)
    # Daemon, because the reader blocks on stdin and there is no way to
    # interrupt that read from here. Once the send loop is done the process
    # should go, not sit waiting on a pipe nobody is writing to.
    reader = threading.Thread(target=latest.pump, args=(sys.stdin.buffer,), daemon=True)
    reader.start()

    print(
        f"sending to {args.address}:{args.port} at {args.fps} fps, pacing {args.pacing}, "
        "until stdin ends"
        + (f" from {args.local_ip}" if args.local_ip else "")
    )

    # `clock` passes no pace, so `run` keeps its own one-sleep-per-tick loop:
    # today's sender, timing for timing, and the default until a floor capture
    # says otherwise (D-02).
    pace = {
        "clock": None,
        "arrival": on_arrival(args.fps, latest.wait_for_new),
    }[args.pacing]

    sent_frame: dict[str, bytes] = {}

    def frame_source(n: int) -> bytes:
        framebuffer = latest.read()
        sent_frame["latest"] = framebuffer
        return framebuffer

    def on_frame(n: int, elapsed: float) -> None:
        if args.emit_timing:
            # Stamped before anything below spends time: `sent` is when the
            # frame finished going out, `read` when the sender woke and took
            # it, `wrote` when the reader thread put it in the slot.
            sent_at = time.perf_counter()
            seq, written_at, read_at = latest.adopted
            wrote = "-" if written_at is None else f"{written_at:.6f}"
            print(f"timing {n} read {read_at:.6f} sent {sent_at:.6f} "
                  f"seq {seq} wrote {wrote}", flush=True)
        if args.emit_digest:
            digest = _frame_digest(config, sent_frame["latest"], orientation, eof=not args.no_eof)
            print(f"frame {n} sha256: {digest}", flush=True)
        # Stop once the input has ended *and* its newest frame has been on the
        # wire at least once. Exiting on the bare end-of-input flag would drop
        # the final frame, which on a floor that holds its last picture is the
        # frame the audience is left looking at.
        #
        # It is raised rather than returned because `run` has no stop
        # predicate, and KeyboardInterrupt is its documented exit from the
        # endless mode — it catches it, closes the socket and returns the
        # packet count.
        if latest.drained():
            raise KeyboardInterrupt

    # Both handlers exist because of the daemon reader — see `_exit_now`. Any
    # exception leaving `run()` while that thread is parked turns into SIGABRT,
    # so no error path here may return or re-raise normally. Distinct exit codes
    # preserve the diagnosis for a human reading a log; no supervisor reads the
    # value today. The app decides whether to wait from its interface poll.
    try:
        sent = run(
            config,
            frame_source,
            duration=None,
            orientation=orientation,
            fps=args.fps,
            eof=not args.no_eof,
            address=args.address,
            port=args.port,
            local_ip=args.local_ip,
            on_frame=on_frame,
            pace=pace,
        )
    except OSError as exc:
        where = args.local_ip or f"{args.address}:{args.port}"
        print(f"floor NIC {where} unusable: {exc}", file=sys.stderr, flush=True)
        _exit_now(EXIT_NETWORK_GONE)
    except BaseException:
        # Still loud, still a full traceback — the channel for bad news stays
        # open. It just arrives as a traceback rather than as a crash dialog.
        traceback.print_exc()
        _exit_now(1)

    print(f"sent {sent} packets")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mapper", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    plan = sub.add_parser("plan", help="print the packet plan for one geometry")
    _add_geometry(plan)
    plan.add_argument("--no-eof", action="store_true", help="suppress the 0x80 flag")
    plan.set_defaults(func=cmd_plan)

    matrix = sub.add_parser("matrix", help="run the invariants over every legal geometry")
    matrix.add_argument("--orientation", default="identity")
    matrix.add_argument("--supported-only", action="store_true", help="8x8 floor types only")
    matrix.add_argument("--plan-only", action="store_true", help="skip the per-pixel sweep")
    matrix.add_argument("--verbose", action="store_true")
    matrix.set_defaults(func=cmd_matrix)

    fixtures = sub.add_parser("fixtures", help="emit conformance fixtures")
    fixtures.add_argument("--out", default="fixtures")
    fixtures.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing fixture set — only for a reviewed contract change",
    )
    fixtures.set_defaults(func=cmd_fixtures)

    xml = sub.add_parser("xml", help="write a Ledset mapper XML for a geometry")
    _add_geometry(xml)
    xml.add_argument("--out", help="path to write; prints to stdout if omitted")
    xml.set_defaults(func=cmd_xml)

    verify = sub.add_parser("verify", help="diff a capture against what we would send")
    verify.add_argument("capture")
    _add_geometry(verify)
    verify.add_argument("--pattern", default="white", choices=sorted(PATTERNS) + ["tile"])
    verify.add_argument("--tile-col", type=int, default=0)
    verify.add_argument("--tile-row", type=int, default=0)
    verify.add_argument("--no-eof", action="store_true")
    verify.add_argument(
        "--allow-mismatch",
        type=int,
        default=0,
        metavar="N",
        help="exit 0 with up to N differing frames, for Ledset's documented "
        "loop-boundary blanks and torn frames (02-white needs 3)",
    )
    verify.set_defaults(func=cmd_verify)

    send = sub.add_parser("send", help="broadcast a pattern to the floor")
    _add_geometry(send)
    send.add_argument("--pattern", default="gradient24", choices=sorted(PATTERNS) + ["tile"])
    send.add_argument("--tile-col", type=int, default=0)
    send.add_argument("--tile-row", type=int, default=0)
    send.add_argument("--duration", type=float, default=5.0, help="seconds")
    send.add_argument("--fps", type=int, default=DEFAULT_FPS)
    send.add_argument("--no-eof", action="store_true", help="the floor will not latch")
    send.add_argument("--address", default="255.255.255.255")
    send.add_argument("--port", type=int, default=60001)
    send.add_argument("--local-ip", help="bind to a specific NIC, e.g. 10.200.50.78")
    send.add_argument("--dry-run", action="store_true", help="print the plan, send nothing")
    send.set_defaults(func=cmd_send)

    play = sub.add_parser("play", help="broadcast an uncompressed AVI to the floor")
    play.add_argument("video", help="uncompressed 24-bit AVI at the floor's exact resolution")
    _add_geometry(play)
    # How long to send. Three ways to say it, one at a time; the default with
    # none of them is a single pass of the clip. Deliberately not a magic
    # `--loop 0` for forever — an explicit flag is harder to mistype at 2 a.m.
    # at the floor, where the cost of getting it wrong is a session.
    span = play.add_mutually_exclusive_group()
    span.add_argument("--duration", type=float, help="seconds")
    span.add_argument("--loop", type=int, metavar="N", help="play the clip N times")
    span.add_argument(
        "--forever", action="store_true", help="loop until interrupted with Ctrl-C"
    )
    play.add_argument(
        "--fps",
        type=int,
        help=f"send rate. Default is the clip's own authored rate, capped at "
        f"{MAX_ADOPTED_FPS}, or {DEFAULT_FPS} if the file carries no rate. An "
        f"explicit value always wins and is never capped",
    )
    play.add_argument("--no-eof", action="store_true", help="the floor will not latch")
    play.add_argument("--address", default="255.255.255.255")
    play.add_argument("--port", type=int, default=60001)
    play.add_argument("--local-ip", help="bind to a specific NIC, e.g. 10.200.50.78")
    play.add_argument("--dry-run", action="store_true", help="print the plan, send nothing")
    play.set_defaults(func=cmd_play)

    stream = sub.add_parser("stream", help="broadcast raw RGB framebuffers read from stdin")
    _add_geometry(stream)
    stream.add_argument("--fps", type=int, default=DEFAULT_FPS)
    stream.add_argument("--no-eof", action="store_true", help="the floor will not latch")
    stream.add_argument("--address", default="255.255.255.255")
    stream.add_argument("--port", type=int, default=60001)
    stream.add_argument("--local-ip", help="bind to a specific NIC, e.g. 10.200.50.78")
    stream.add_argument(
        "--emit-digest",
        action="store_true",
        help="print a sha256 per frame sent, so a live stream can be graded "
        "against the `send` digests in the verification bar",
    )
    stream.add_argument(
        "--pacing",
        choices=("clock", "arrival"),
        default="clock",
        help="when frames go. clock (default): one sleep per tick, as always. "
        "arrival: on each new "
        "frame, no faster than --fps, repeated after 1 s of silence. "
        "Experimental; see docs/DECISIONS.md D-02/D-03",
    )
    stream.add_argument(
        "--emit-timing",
        action="store_true",
        help="print, per frame sent, when it was written into the slot, read by "
        "the sender and sent (perf_counter seconds). A measurement aid",
    )
    stream.add_argument("--dry-run", action="store_true", help="digest each frame, send nothing")
    stream.set_defaults(func=cmd_stream)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
