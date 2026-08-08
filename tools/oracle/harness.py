"""Oracle harness CLI.

    python -m tools.oracle.harness run                                # dry-run (default)
    python -m tools.oracle.harness run --configs my-list.json
    python -m tools.oracle.harness run --live --interface 8 --seconds 8 \
        --configs tools/oracle/configs.acceptance.json \
        --only acceptance-gradient24-identity
    python -m tools.oracle.harness list-interfaces

Dry-run reads `captures/*.pcapng` already in the repo and touches no hardware,
no Ledset, and no network. It is the default because it is how this harness
proves itself without going near the floor.

`--live` starts a **passive** packet capture and waits. It never drives
Ledset, never opens media, and never sends anything -- getting a frame onto
the wire during the capture window is the operator's job, exactly as
`docs/CAPTURE_PLAN.md` already documents by hand. A config whose `capture` is
`null` is precisely the one `--live` captures for: the null says "no oracle
exists for this geometry yet", and `--live` is how one gets made.

**Use `--only` for every attended run.** The acceptance list holds three rows
and `--live` captures a window for each in turn, but they are not
interchangeable: the third needs the controllers physically moved to the far
end first (decision 20). Capturing them back to back would record whatever
happened to be on the wire, which is how a session produces a table of numbers
that means nothing. One row, one window, one verdict.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from . import capture as capture_mod
from .config_list import load as load_configs
from .decode_diff import verify_config
from .report import to_json, to_table

DEFAULT_CONFIGS = Path(__file__).resolve().parent / "configs.dryrun.json"
DEFAULT_JSON_OUT = Path(__file__).resolve().parent / "out" / "report.json"


def _unused_path(path: Path) -> Path:
    """`path`, or the first `-2`, `-3`, ... variant that does not exist yet.

    A second take never overwrites the first. At the floor a re-run usually
    means the operator thinks the previous window was botched -- and "thinks"
    is the operative word. Deciding which take was good is a job for after the
    session, and it needs both files to still exist.
    """
    if not path.exists():
        return path
    for n in range(2, 1000):
        candidate = path.with_name(f"{path.stem}-{n}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"too many existing captures named like {path}")


def cmd_run(args) -> int:
    configs = load_configs(args.configs)
    if args.only:
        wanted = set(args.only)
        unknown = wanted - {oc.name for oc in configs}
        if unknown:
            print(
                f"no config named {sorted(unknown)} in {args.configs} "
                f"(available: {[oc.name for oc in configs]})",
                file=sys.stderr,
            )
            return 2
        configs = [oc for oc in configs if oc.name in wanted]

    # A live run opens one capture window per row, and the acceptance rows are
    # not interchangeable -- one of them needs the controllers physically moved
    # first. Walking the list would record whatever happened to be on the wire
    # and hand back verdicts about nothing, which is worse than an error.
    if args.live and len(configs) > 1:
        print(
            f"--live over {len(configs)} configs needs --only: each row is a separate "
            f"capture window and they are not interchangeable. Pick one of "
            f"{[oc.name for oc in configs]}",
            file=sys.stderr,
        )
        return 2

    results = []
    for oc in configs:
        if args.live:
            if not oc.capture:
                out = _unused_path(Path(args.out_dir) / f"{oc.name}.pcapng")
                print(
                    f"[{oc.name}] capturing on interface {args.interface} for {args.seconds}s "
                    f"-> {out}"
                    f" -- start playback on the floor now (this call does not touch Ledset)",
                    file=sys.stderr,
                )
                capture_mod.capture_for(args.interface, out, args.seconds)
                capture_path = out
            else:
                capture_path = ROOT / oc.capture if oc.capture else None
        else:
            capture_path = ROOT / oc.capture if oc.capture else None
        results.append(verify_config(oc, capture_path))

    print(to_table(results))

    json_out = Path(args.json_out) if args.json_out else DEFAULT_JSON_OUT
    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(to_json(results), encoding="utf-8")
    print(f"\nwrote {json_out}")

    return 0 if all(r.passed for r in results) else 1


def cmd_list_interfaces(args) -> int:
    for line in capture_mod.list_interfaces(args.dumpcap):
        print(line)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="oracle", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run a config list, emit a pass/fail table + JSON")
    run.add_argument("--configs", default=str(DEFAULT_CONFIGS), help="config list JSON (default: the dry-run list)")
    run.add_argument(
        "--only", action="append", metavar="NAME",
        help="run just this config by name, repeatable. Required in practice for --live: "
             "the acceptance rows are not interchangeable and each needs its own window.",
    )
    run.add_argument(
        "--live", action="store_true",
        help="capture live instead of reading captures/*.pcapng. Never drives Ledset -- "
             "starts a passive capture and waits for a human to trigger playback.",
    )
    run.add_argument("--interface", default="8", help="dumpcap interface number, --live only")
    run.add_argument("--seconds", type=float, default=6.0, help="capture window, --live only")
    run.add_argument("--out-dir", default=str(ROOT / "captures" / "oracle"), help="where --live captures are written")
    run.add_argument("--json-out", help=f"machine-readable report path (default: {DEFAULT_JSON_OUT})")
    run.set_defaults(func=cmd_run)

    li = sub.add_parser("list-interfaces", help="dumpcap -D, for finding the floor NIC")
    li.add_argument("--dumpcap", help="explicit path to dumpcap.exe")
    li.set_defaults(func=cmd_list_interfaces)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
