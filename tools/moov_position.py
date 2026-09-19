#!/usr/bin/env python3
"""Where the `moov` atom sits in an MP4/MOV, and why that decides whether a clip opens.

**An instrument, not a gate.** Nothing runs it automatically.

## What it is for

The 2026-09-05/06 job produced 105 `DEMUXER_ERROR_COULD_NOT_OPEN` errors across
seven clips that `ffprobe` opens without complaint. The discriminator turned out
to be the position of the `moov` atom: an MP4 that carries `moov` *after* `mdat`
requires the demuxer to read the tail of the file before anything is buffered,
which requires a working `Range` request. `ddf-media://` could not answer one
with a `206` until it was fixed, so those reads silently got byte 0 of a
full-file `200`, every offset was wrong, and the container never opened.

This script exists so that claim has an instrument behind it that shares no code
with the analysis that produced it. `docs/POSTMORTEMS.md` is a catalogue of
conclusions that survived their own disproof; CLAUDE.md's rule is that two
findings from one instrument are one finding. The original correlation came out
of the investigation's own tooling. This walks the atom tree directly -- stdlib
only, no ffprobe, no project code -- so it can disagree.

## The measurement it was written for

Run against the job's own media library, 2026-09-18:

    $ python3 tools/moov_position.py ~/Downloads/CLIP_ddf/* ~/Downloads/CLIP_ddf_more/*

    49 files: 42 FRONT, 7 END

and the seven `END` files are, name for name, exactly the seven distinct clips
the job log reports `DEMUXER_ERROR_COULD_NOT_OPEN` for -- with no counterexample
in either direction. The log is tracked at
`captures/ddf-job-2026-09-05T23-2026-09-06T08.log`; the comparison is

    grep DEMUXER_ERROR_COULD_NOT_OPEN <log> \\
      | sed -E 's/.*cue "(.*)" (failed to preview|stopped playing|failed to play).*/\\1/' \\
      | sort -u

Note the three message phrasings. Grepping only `failed to preview` finds 97 of
the 105 lines and 7 of the clips by luck; `stopped playing` and `failed to play`
are the other two, and a regex that misses them silently under-reports. That
mistake was made and caught while taking this measurement.

## The positive control

A scanner that classified everything as FRONT would have produced a clean-looking
table and a false all-clear. So before it reports anything, it builds a pair of
clips with known, opposite atom order -- ffmpeg's `+faststart` writes `moov`
first, and ffmpeg's default for this muxer writes it last -- and requires itself
to classify both correctly.

If the control does not pass, or ffmpeg is not on `PATH` to build it, this prints
no table at all and exits non-zero. An unverified instrument's output is not a
weaker result; it is not a result. `CLAUDE.md`: state it as refusal, print no
table rather than a table of failures.
"""

from __future__ import annotations

import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# A 64-bit `largesize` follows the header when the 32-bit size field is 1; a
# size of 0 means "this atom runs to the end of the file". Both are in the spec
# and both appear in the wild, so neither can be treated as corruption.
_SIZE_IS_64BIT = 1
_SIZE_TO_EOF = 0
_HEADER_BYTES = 8


def top_level_atoms(path: str) -> list[str]:
    """The four-character types of the file's top-level atoms, in file order.

    Stops rather than raising on a truncated or non-ISO-BMFF file: the caller
    distinguishes "no `moov` found" from "classified", and a partial list is
    enough to do that. Returning what was read keeps a damaged file reportable
    instead of turning it into a traceback that hides the other 48 results.
    """
    atoms: list[str] = []
    size = os.path.getsize(path)
    offset = 0

    with open(path, "rb") as handle:
        while offset < size:
            handle.seek(offset)
            header = handle.read(_HEADER_BYTES)
            if len(header) < _HEADER_BYTES:
                break

            atom_size = struct.unpack(">I", header[:4])[0]
            atom_type = header[4:8].decode("latin-1")

            if atom_size == _SIZE_IS_64BIT:
                extended = handle.read(8)
                if len(extended) < 8:
                    break
                atom_size = struct.unpack(">Q", extended)[0]
            elif atom_size == _SIZE_TO_EOF:
                atom_size = size - offset

            # Below the header length the offset cannot advance, and trusting it
            # would loop forever on a malformed file.
            if atom_size < _HEADER_BYTES:
                break

            atoms.append(atom_type)
            offset += atom_size

    return atoms


def classify(path: str) -> tuple[str, str]:
    """`(verdict, atom order)` for one file.

    `FRONT` and `END` are the two that matter. `MOOV-ONLY` is a file with
    metadata and no media payload, and `NO-MOOV` is not an ISO-BMFF file at all
    -- both are reported under their own names rather than folded into `FRONT`,
    because a bucket that absorbs the cases you did not think about is how an
    instrument reports a clean run it did not have.
    """
    atoms = top_level_atoms(path)
    shown = ",".join(atoms[:6])

    if "moov" not in atoms:
        return "NO-MOOV", shown
    if "mdat" not in atoms:
        return "MOOV-ONLY", shown
    return ("FRONT" if atoms.index("moov") < atoms.index("mdat") else "END"), shown


def _build_control(directory: str, faststart: bool) -> str | None:
    """One tiny clip whose atom order is known by construction, or `None`."""
    target = os.path.join(directory, "front.mp4" if faststart else "end.mp4")
    command = [
        "ffmpeg", "-v", "error",
        "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2",
        "-r", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]
    if faststart:
        command += ["-movflags", "+faststart"]
    command += ["-y", target]

    try:
        subprocess.run(command, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return target


def control_passes() -> tuple[bool, str]:
    """Does this scanner still tell the two orders apart? `(ok, why not)`."""
    with tempfile.TemporaryDirectory() as directory:
        front = _build_control(directory, faststart=True)
        end = _build_control(directory, faststart=False)
        if front is None or end is None:
            return False, "could not build the control pair (is ffmpeg on PATH?)"

        front_verdict, front_order = classify(front)
        end_verdict, end_order = classify(end)

        if front_verdict != "FRONT":
            return False, f"+faststart clip read as {front_verdict} ({front_order}), expected FRONT"
        if end_verdict != "END":
            return False, f"default-muxed clip read as {end_verdict} ({end_order}), expected END"

    return True, ""


def main(argv: list[str]) -> int:
    paths = argv[1:]
    if not paths:
        print(f"usage: {Path(sys.argv[0]).name} FILE [FILE ...]", file=sys.stderr)
        return 2

    # Before the table, not after: a control checked afterwards is a control
    # whose failure arrives once the numbers have already been read.
    ok, reason = control_passes()
    if not ok:
        print(f"POSITIVE CONTROL FAILED: {reason}", file=sys.stderr)
        print("Refusing to report. This instrument is unverified, so its output is not a result.", file=sys.stderr)
        return 3

    counts: dict[str, int] = {}
    for path in paths:
        if not os.path.isfile(path):
            continue
        verdict, order = classify(path)
        counts[verdict] = counts.get(verdict, 0) + 1
        print(f"{verdict}\t{order}\t{os.path.basename(path)}")

    total = sum(counts.values())
    summary = ", ".join(f"{count} {verdict}" for verdict, count in sorted(counts.items()))
    print(f"\n{total} files: {summary}" if total else "\nno readable files given", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
