"""How `mapper stream` leaves, graded in a real subprocess.

Every other test in `mapper/tests` drives the CLI in process, which is cheaper
and enough for everything about *what* goes on the wire. It cannot see this
defect at all. The thing being graded here is the exit itself — a signal, an
exit code, and whether CPython's finaliser calls `abort()` — and none of those
exist inside the calling interpreter. So this file spawns the real thing.

MEASURED 2026-08-13, `~/Library/Logs/DiagnosticReports/python3.12-2026-08-13-131703.ips`:

    exception:   {"type": "EXC_CRASH", "signal": "SIGABRT"}
    asi:         {"libsystem_c.dylib": ["abort() called"]}
    frames:      abort -> fatal_error_exit -> _Py_FatalErrorFormat
                 -> _enter_buffered_busy -> _io__Buffered_close
                 -> finalize_modules -> Py_FinalizeEx

`cmd_stream` runs its stdin reader as a **daemon thread**, parked inside
`sys.stdin.buffer.read()` and holding the `BufferedReader`'s lock. When the main
thread leaves for any reason, `Py_FinalizeEx` deallocates `sys.stdin`, `close()`
reaches `_enter_buffered_busy`, the lock is unavailable, and CPython calls
`abort()`. That is SIGABRT, exit 134, and a macOS "python quit unexpectedly"
dialog — once per respawn, forever, because the supervisor restarts it.

The operator-visible consequence is the crash dialog, so the exit code is what
is graded. **134 is the bug and 3 is the fix**; asserting only "it failed" would
pass on both. The vanished NIC is merely the cheapest way to reach the exit —
the defect is on every error path out of `run()`, not on the network one.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

#: `mapper stream` exits with this when the socket cannot be used at all.
#: Distinct from 1 so a supervisor can tell "the network went away" from "the
#: sender is broken" without parsing text.
EXIT_NETWORK_GONE = 3

#: In TEST-NET-3 (RFC 5737), reserved for documentation and guaranteed not to be
#: a real interface on the test machine. `bind()` to it raises EADDRNOTAVAIL
#: before a single packet is built, which is exactly what a pulled Ethernet
#: cable does to a live sender.
UNASSIGNED_IP = "203.0.113.9"

#: 10 x 5 tiles of 8x8_4P = 80 x 40 px, three bytes a pixel.
SHOP_FRAME_BYTES = 80 * 40 * 3

STREAM_ARGS = [
    "-m", "mapper", "stream",
    "--type", "8x8_4P",
    "--cols", "10",
    "--rows", "5",
    "--fps", "30",
    # Loopback throughout. No test in this package may put a byte on the floor's
    # wire, and a datagram to 127.0.0.1 cannot leave the machine.
    "--address", "127.0.0.1",
    "--port", "60009",
]


def run_stream(extra: list[str], stdin_payload: bytes | None) -> subprocess.CompletedProcess[str]:
    """Spawn `mapper stream` and return once it has exited.

    `stdin_payload is None` means **leave stdin open and write nothing**, which
    is the condition the defect needs: the reader thread has to still be parked
    in `read()` when the main thread leaves.

    That is why this hands the child one end of an `os.pipe()` rather than
    `stdin=subprocess.PIPE`. `Popen.communicate()` closes `process.stdin` before
    it waits, so with a `PIPE` the reader would return end-of-stream, release the
    lock, and the process would exit through a traceback instead of `abort()` —
    a test that reports the same thing whether or not the bug is fixed. It was
    written that way first and did exactly that. Passing a raw fd leaves
    `process.stdin` as `None`, so `communicate` has nothing to close, and the
    parent holds the write end open until the child is gone.
    """
    read_fd, write_fd = -1, -1
    try:
        if stdin_payload is None:
            read_fd, write_fd = os.pipe()
            stdin_arg: int | int = read_fd
        else:
            stdin_arg = subprocess.PIPE

        process = subprocess.Popen(
            [sys.executable, *STREAM_ARGS, *extra],
            cwd=REPO_ROOT,
            stdin=stdin_arg,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            payload = None if stdin_payload is None else stdin_payload.decode("latin-1")
            stdout, stderr = process.communicate(input=payload, timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError("mapper stream did not exit within 20 s")
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
    finally:
        for fd in (read_fd, write_fd):
            if fd != -1:
                os.close(fd)


class StreamExitTest(unittest.TestCase):
    def test_clean_run_still_exits_zero(self) -> None:
        """The positive control. If this fails, discard the rest of the file.

        A run that ends because stdin ended takes the same shutdown path through
        the same daemon thread — the reader has simply finished by then and holds
        no lock. If this cannot reach 0, the harness is measuring something other
        than the defect and the exit codes below mean nothing.
        """
        result = run_stream(["--local-ip", "127.0.0.1"], b"\x00" * SHOP_FRAME_BYTES)

        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        self.assertNotIn("Fatal Python error", result.stderr)
        self.assertIn("sent ", result.stdout)

    def test_unusable_nic_exits_three_without_aborting(self) -> None:
        """The bug: today this is 134 (128 + SIGABRT), and macOS shows a dialog."""
        result = run_stream(["--local-ip", UNASSIGNED_IP], None)

        self.assertNotEqual(
            result.returncode,
            -6,
            "SIGABRT: the daemon stdin reader still holds the BufferedReader "
            f"lock at interpreter shutdown.\nstderr: {result.stderr}",
        )
        self.assertEqual(
            result.returncode,
            EXIT_NETWORK_GONE,
            f"expected a clean {EXIT_NETWORK_GONE}, got {result.returncode}.\n"
            f"stderr: {result.stderr}",
        )

    def test_unusable_nic_says_so_in_one_line(self) -> None:
        """A traceback is not an operator-facing message, and neither is a crash.

        The supervisor pipes this stderr into the app's error banner, so it has
        to read as a sentence about the floor rather than as a stack.
        """
        result = run_stream(["--local-ip", UNASSIGNED_IP], None)

        self.assertNotIn("Fatal Python error", result.stderr)
        self.assertNotIn("Traceback (most recent call last)", result.stderr)
        self.assertIn(UNASSIGNED_IP, result.stderr)

        # One line about the fault, so the banner is not handed a paragraph.
        complaints = [line for line in result.stderr.splitlines() if UNASSIGNED_IP in line]
        self.assertEqual(len(complaints), 1, result.stderr)


if __name__ == "__main__":
    unittest.main()
