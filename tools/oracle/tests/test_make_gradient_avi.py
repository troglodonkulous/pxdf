"""Cross-checks `tools/oracle/make-gradient-avi.ps1` against the real source.

`make-gradient-avi.ps1` transcribes `mapper.patterns.gradient24`'s per-pixel
formula into PowerShell rather than calling Python, because the attended
capture session needs a plain AVI file, not a live cross-language pipeline.
A transcription can drift from its source silently -- this test is what
would catch that. It runs the real PowerShell generator, parses its own
declared AVI container (fixed chunk layout, asserted by the generator
itself), and diffs frame 0 against `mapper.patterns.gradient24()` run
through the exact same RGB->BGR conversion `mapper.frame.pack_send_buffer`
uses. If the two ever disagree, the capture this test guards -- the one
capture that can catch a misplaced tile or a misassigned port -- would
silently stop meaning anything.

Skipped (not failed) where PowerShell is unavailable, so this suite still
runs on non-Windows checkouts of the harness.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from mapper.floors import FloorConfig
from mapper.patterns import gradient24

SCRIPT = ROOT / "tools" / "oracle" / "make-gradient-avi.ps1"

# Fixed by the generator's own chunk layout (asserted in the script itself:
# "movi" always starts at byte 5666, whatever the frame size). The first
# frame's pixel data starts 12 bytes into the "movi" LIST (LIST + size +
# 'movi' fourcc = 12 bytes) plus 8 bytes for the '00dc' chunk header.
MOVI_OFFSET = 5666
FIRST_FRAME_OFFSET = MOVI_OFFSET + 12 + 8


def _find_powershell() -> str | None:
    for name in ("powershell", "pwsh"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _bgr_from_gradient24(config: FloorConfig) -> bytes:
    """What the AVI's DIB should hold: gradient24's RGB, stored as B,G,R."""
    rgb = gradient24(config)
    out = bytearray(len(rgb))
    for i in range(0, len(rgb), 3):
        out[i], out[i + 1], out[i + 2] = rgb[i + 2], rgb[i + 1], rgb[i]
    return bytes(out)


class GradientAviMatchesPython(unittest.TestCase):
    def test_frame_zero_matches_mapper_patterns_gradient24(self):
        powershell = _find_powershell()
        if not powershell:
            self.skipTest("no powershell/pwsh on PATH")

        # A small, fast geometry -- the formula is what is under test, not
        # the file size. Deliberately not square and not a multiple of the
        # real rig's 10 columns, so a row/column swap in the transcription
        # would not accidentally cancel out.
        cols, rows, tile = 6, 4, 8
        config = FloorConfig.of("8x8_4P", cols, rows)

        out_dir = Path(__file__).resolve().parent / "_tmp"
        out_dir.mkdir(exist_ok=True)
        out_file = out_dir / "gradient24-crosscheck.avi"
        try:
            subprocess.run(
                [
                    powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
                    "-Cols", str(cols), "-Rows", str(rows), "-TileSize", str(tile),
                    "-Seconds", "0.1", "-Fps", "10", "-OutFile", str(out_file),
                ],
                check=True, capture_output=True, text=True, timeout=60,
            )
            data = out_file.read_bytes()
            frame_bytes = config.pixel_count * 3
            observed = data[FIRST_FRAME_OFFSET : FIRST_FRAME_OFFSET + frame_bytes]
            expected = _bgr_from_gradient24(config)

            self.assertEqual(len(observed), len(expected), "frame slice is the wrong length")
            if observed != expected:
                first = next(i for i in range(len(expected)) if expected[i] != observed[i])
                self.fail(
                    f"byte {first}: expected 0x{expected[first]:02X}, "
                    f"got 0x{observed[first]:02X} (pixel {first // 3}, channel {first % 3})"
                )
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
