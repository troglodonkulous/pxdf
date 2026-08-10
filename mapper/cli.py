"""Command line front end.

    python -m mapper plan     --type 8x8_4P --cols 10 --rows 5
    python -m mapper matrix
    python -m mapper fixtures --out fixtures
    python -m mapper xml      --type 8x8_4P --cols 10 --rows 5 --out Test3.xml
    python -m mapper verify   captures/02-white.pcapng --type 8x8_8P --cols 8 --rows 5 \\
                              --pattern white
    python -m mapper send     --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 \\
                              --duration 5 --dry-run
    python -m mapper play     test-patterns/09-gradient24-8x8_4P-10x5.avi \\
                              --type 8x8_4P --cols 10 --rows 5 --duration 30
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from . import fixtures as fixtures_module
from . import mapper_xml
from .avi import read_video
from .calibration import load as load_calibration
from .floors import FLOOR_TYPES, FloorConfig, legal_configs
from .frame import send_buffer_sources
from .orientation import Orientation
from .patterns import PATTERNS, resolve as resolve_pattern
from .plan import build_plan, format_plan
from .sender import DEFAULT_FPS, MAX_ADOPTED_FPS, dry_run, run
from .verify import format_diffs, verify_capture
from .video import framebuffers


#: Shared help text for the free-text `--pattern` argument on `send`/`verify`.
#: `tile` (bare) plus `--tile-col`/`--tile-row` is kept as its own legal form
#: for anything already scripted against it; `tile:col,row` is the equivalent
#: one-shot spec `patterns.resolve` understands directly.
_PATTERN_HELP = (
    "pattern to send: a name (" + ", ".join(sorted(PATTERNS)) + "), 'level:N' "
    "(solid grey, 0-255), 'solid:R,G,B', 'steps' (grey band ladder), 'tile' "
    "(use with --tile-col/--tile-row), or 'tile:col,row'"
)


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
    """Resolve `--pattern` (and, for the legacy `tile` name, `--tile-col`/`--tile-row`).

    `--pattern tile` alone is ambiguous without a col/row, so it is translated
    to the `tile:col,row` spec `patterns.resolve` understands -- this keeps
    `--tile-col`/`--tile-row` working exactly as before for anything already
    scripted against them. Everything else goes through `resolve` unchanged.
    """
    if args.pattern == "tile":
        return resolve_pattern(f"tile:{args.tile_col},{args.tile_row}")(config)
    return resolve_pattern(args.pattern)(config)


def _load_calibration(args, config):
    """Load and validate `--calibration`, and print the provenance line.

    A session log must record what was actually on the wire -- printing the
    file, region count and each region's rect/gain here is the only place that
    happens, so it must run whether or not `--dry-run` is set.
    """
    if not args.calibration:
        return None
    cal = load_calibration(args.calibration)
    cal.validate(config)
    print(f"calibration: {args.calibration} ({len(cal.regions)} region(s))")
    for region in cal.regions:
        note = f" {region.note!r}" if region.note else ""
        print(
            f"  ({region.x},{region.y}) {region.w}x{region.h} "
            f"gain={region.gain}{note}"
        )
    return cal


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
    try:
        framebuffer = _framebuffer(args, config)
    except ValueError as exc:
        # A bad --pattern is an ordinary operator error -- see the identical
        # treatment of a wrong-geometry asset in cmd_play -- and does not
        # deserve a traceback.
        print(str(exc), file=sys.stderr)
        return 2
    diffs = verify_capture(
        args.capture,
        config,
        framebuffer,
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
    try:
        framebuffer = _framebuffer(args, config)
        cal = _load_calibration(args, config)
    except ValueError as exc:
        # A bad --pattern or --calibration is an ordinary operator error, the
        # same treatment cmd_play gives a wrong-geometry asset, and neither
        # deserves a traceback. Loading/validating the calibration here, ahead
        # of everything else, is also what makes it fail before a socket
        # opens rather than mid-broadcast.
        print(str(exc), file=sys.stderr)
        return 2

    print(config.describe())
    print(f"orientation: {orientation.describe()}   pattern: {args.pattern}")

    base_source = lambda n: framebuffer
    # The calibration wrap happens before the --dry-run branch below, so a
    # dry run with --calibration prints the digest of what would actually go
    # on the wire, not of the unadjusted pattern. Grading something other than
    # what the socket would carry is the exact failure this project has
    # already been burned by twice (CLAUDE.md, `oracle.harness --live`).
    frame_source = (lambda n: cal.apply(config, base_source(n))) if cal else base_source

    if args.dry_run:
        return _dry_run(config, frame_source, orientation, eof=not args.no_eof)

    print(
        f"sending to {args.address}:{args.port} at {args.fps} fps for {args.duration}s"
        + (f" from {args.local_ip}" if args.local_ip else "")
    )
    sent = run(
        config,
        frame_source,
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

    try:
        cal = _load_calibration(args, config)
    except ValueError as exc:
        # Same treatment as the wrong-geometry case above: fail before a
        # socket opens, no traceback.
        print(str(exc), file=sys.stderr)
        return 2

    fps = _resolve_fps(args, video.fps)

    print(config.describe())
    print(f"orientation: {orientation.describe()}   video: {args.video} ({len(frames)} frames)")

    # The list is built once and indexed modulo its length, so a loop boundary
    # is not a special case at all. Ledset emits three blank frames at every
    # one of its own, measured twice at this geometry.
    def _clip_source(n: int) -> bytes:
        return frames[n % len(frames)]

    # The calibration wrap happens before the --dry-run branch below -- see
    # the identical comment in cmd_send for why that ordering is load-bearing.
    frame_source = (lambda n: cal.apply(config, _clip_source(n))) if cal else _clip_source

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
    verify.add_argument("--pattern", default="white", help=_PATTERN_HELP)
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
    send.add_argument("--pattern", default="gradient24", help=_PATTERN_HELP)
    send.add_argument("--tile-col", type=int, default=0)
    send.add_argument("--tile-row", type=int, default=0)
    send.add_argument("--duration", type=float, default=5.0, help="seconds")
    send.add_argument("--fps", type=int, default=DEFAULT_FPS)
    send.add_argument("--no-eof", action="store_true", help="the floor will not latch")
    send.add_argument("--address", default="255.255.255.255")
    send.add_argument("--port", type=int, default=60001)
    send.add_argument("--local-ip", help="bind to a specific NIC, e.g. 10.200.50.78")
    send.add_argument("--dry-run", action="store_true", help="print the plan, send nothing")
    send.add_argument(
        "--calibration",
        metavar="PATH",
        help="apply a per-region gain calibration before sending or dry-running",
    )
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
    play.add_argument(
        "--calibration",
        metavar="PATH",
        help="apply a per-region gain calibration before sending or dry-running",
    )
    play.set_defaults(func=cmd_play)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
