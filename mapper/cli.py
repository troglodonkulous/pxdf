"""Command line front end.

    python -m mapper plan     --type 8x8_4P --cols 10 --rows 5
    python -m mapper matrix
    python -m mapper fixtures --out fixtures
    python -m mapper xml      --type 8x8_4P --cols 10 --rows 5 --out Test3.xml
    python -m mapper verify   captures/02-white.pcapng --type 8x8_8P --cols 8 --rows 5 \\
                              --pattern white
    python -m mapper send     --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 \\
                              --duration 5 --dry-run
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import fixtures as fixtures_module
from . import mapper_xml
from .floors import FLOOR_TYPES, FloorConfig, legal_configs
from .frame import send_buffer_sources
from .orientation import Orientation
from .patterns import PATTERNS, tile
from .plan import build_plan, format_plan
from .sender import DEFAULT_FPS, dry_run, run
from .verify import format_diffs, verify_capture


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
    return 0 if any(d.ok for d in diffs) else 1


def cmd_send(args) -> int:
    config = _config(args)
    orientation = Orientation.parse(args.orientation)
    framebuffer = _framebuffer(args, config)

    print(config.describe())
    print(f"orientation: {orientation.describe()}   pattern: {args.pattern}")

    if args.dry_run:
        datagrams = list(dry_run(config, lambda n: framebuffer, orientation, eof=not args.no_eof))
        print(format_plan(config, build_plan(config, eof=not args.no_eof)))
        print(f"frame 0 is {sum(len(d) for d in datagrams)} bytes, nothing sent")
        return 0

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

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
