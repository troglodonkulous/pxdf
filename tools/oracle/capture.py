"""Programmatic packet capture via Wireshark's `dumpcap`.

The floor protocol is pure UDP broadcast on port 60001 (`docs/PROTOCOL.md`
S2). `dumpcap` is a passive listener -- it opens no connection to the
controller and sends nothing. Running it never crosses the "does this
transmit" line; it only listens. It does not know or care what is on the
wire: Ledset's Player page, our own `python -m mapper send`, or nothing at
all produce exactly the same kind of capture from here.

Two modes:

* `capture_for()` -- fire-and-forget, automating `docs/CAPTURE_PLAN.md`'s
  manual recipe exactly: `dumpcap -a duration:N` runs for a fixed window and
  exits on its own, flushing a valid pcapng trailer without needing a signal
  sent to it. This is what an unattended config sweep uses.
* `start()` / `stop()` -- start now, stop on request, for the attended case
  where a human triggers floor playback inside the window (mirrors
  `docs/CAPTURE_PLAN.md` S3 exactly: start capture, do the floor action,
  then stop). `stop()` sends CTRL_BREAK_EVENT, which `dumpcap` treats as a
  clean-shutdown request (same effect as the Ctrl+C in the manual recipe).

The interface number and filter used throughout this repo --
`docs/CAPTURE_RESULTS.md`: "Interface 8 (Ethernet, 10.200.50.78), filter
udp port 60001" -- are re-derivable, not hard fact: `list_interfaces()`
below and `Get-NetIPAddress` are how that pairing was (re-)confirmed for
this session (see `docs/ORACLE_HARNESS.md`). Nothing here hard-codes it as a
default, since a different machine or a re-cabled NIC changes it.
"""

from __future__ import annotations

import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_FILTER = "udp port 60001"
_DEFAULT_DUMPCAP = Path(r"C:\Program Files\Wireshark\dumpcap.exe")


def find_dumpcap(explicit: str | Path | None = None) -> Path:
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise FileNotFoundError(f"dumpcap not found at {p}")
        return p
    if _DEFAULT_DUMPCAP.exists():
        return _DEFAULT_DUMPCAP
    found = shutil.which("dumpcap")
    if found:
        return Path(found)
    raise FileNotFoundError(
        f"dumpcap.exe not found. Checked {_DEFAULT_DUMPCAP} and PATH. "
        "Install Wireshark (bundles Npcap) or pass an explicit path."
    )


def list_interfaces(dumpcap: str | Path | None = None) -> list[str]:
    """`dumpcap -D` output, one line per interface, numbered as `-i` expects."""
    exe = find_dumpcap(dumpcap)
    result = subprocess.run(
        [str(exe), "-D"], capture_output=True, text=True, timeout=15, check=True
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def capture_for(
    interface: str | int,
    out_path: str | Path,
    duration_s: float,
    bpf_filter: str = DEFAULT_FILTER,
    dumpcap: str | Path | None = None,
    extra_margin_s: float = 8.0,
) -> Path:
    """Capture for exactly `duration_s` seconds, then return.

    Blocking. `dumpcap -a duration:N` stops itself and writes a valid
    pcapng trailer without needing a termination signal, which is more
    robust for an unattended sweep than trying to interrupt a long-running
    process at the right moment.
    """
    exe = find_dumpcap(dumpcap)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(exe), "-i", str(interface), "-f", bpf_filter,
        "-a", f"duration:{max(1, int(round(duration_s)))}",
        "-w", str(out_path),
    ]
    try:
        subprocess.run(
            cmd, capture_output=True, text=True, timeout=duration_s + extra_margin_s, check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"dumpcap failed ({exc.returncode}): {exc.stderr}") from exc
    return out_path


@dataclass
class CaptureHandle:
    process: subprocess.Popen
    out_path: Path


def start(
    interface: str | int,
    out_path: str | Path,
    bpf_filter: str = DEFAULT_FILTER,
    dumpcap: str | Path | None = None,
    settle_s: float = 1.0,
) -> CaptureHandle:
    """Start capturing now; caller triggers the floor action, then calls `stop()`.

    Mirrors `docs/CAPTURE_PLAN.md`'s manual procedure -- "start dumpcap, then
    do the floor action, let it run, then Ctrl+C" -- automated end to end
    except for the floor action itself, which remains whatever produced the
    traffic (human-triggered Ledset playback, or a future non-Ledset sender).
    """
    exe = find_dumpcap(dumpcap)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(exe), "-i", str(interface), "-f", bpf_filter, "-w", str(out_path)]
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        creationflags=creationflags,
    )
    time.sleep(settle_s)  # let dumpcap open the adapter before the caller acts
    if proc.poll() is not None:
        raise RuntimeError(f"dumpcap exited immediately: {proc.stdout.read() if proc.stdout else ''}")
    return CaptureHandle(proc, out_path)


def stop(handle: CaptureHandle, timeout_s: float = 10.0) -> Path:
    """Stop a capture started with `start()`, flushing a valid trailer."""
    if sys.platform == "win32":
        handle.process.send_signal(signal.CTRL_BREAK_EVENT)
    else:
        handle.process.terminate()
    try:
        handle.process.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        handle.process.kill()
        handle.process.wait(timeout=5)
    return handle.out_path
