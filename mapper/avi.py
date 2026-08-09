"""Minimal AVI reader — enough to read our own test-pattern videos back.

Dependency-free and deliberately narrow: one uncompressed 24-bit `BI_RGB`
video stream, which is all `test-patterns/*.avi` ever holds. Anything else
raises rather than being guessed at.

It exists to give the oracle's tile-walk assertion a machine-checked
provenance: the expected sequence is read from the video Ledset actually
played, not from a hand-typed transcription of it.

**`biHeight` carries a sign.** It is negative (top-down) in these files.
Assuming the DIB default of bottom-up silently mirrors every frame vertically,
which for a tile walk swaps tile row *r* with *rows-1-r* and still decodes to a
plausible-looking sequence. `Video.pixel` honours the sign; do not index the
raw bytes yourself.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


@dataclass(frozen=True)
class Video:
    """An uncompressed 24-bit AVI, as frames of raw DIB rows."""

    width: int
    #: Always positive. The sign of `biHeight` is carried by `top_down`.
    height: int
    #: `biHeight < 0`, i.e. row 0 of the buffer is the *top* row of the image.
    top_down: bool
    frames: list[bytes]
    #: The clip's authored frame rate from the video stream's `strh`, or `None`
    #: if the file did not carry one. **Nothing plays at this rate on its own.**
    #: It exists so a mismatch between how a clip was authored and how it is
    #: being sent can be *noticed*; `sender.DEFAULT_FPS` still decides.
    fps: float | None = None

    @property
    def stride(self) -> int:
        """DIB rows are padded to a 4-byte boundary."""
        return (self.width * 3 + 3) & ~3

    def pixel(self, frame: bytes, x: int, y: int) -> tuple[int, int, int]:
        """`(r, g, b)` at image coordinates, `y` counted from the top."""
        row = y if self.top_down else self.height - 1 - y
        i = row * self.stride + x * 3
        blue, green, red = frame[i : i + 3]
        return red, green, blue


def _chunks(data: bytes, offset: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """Yield `(fourcc, body_offset, size)` for each leaf chunk, entering `LIST`s."""
    while offset + 8 <= end:
        fourcc = data[offset : offset + 4]
        (size,) = struct.unpack_from("<I", data, offset + 4)
        body = offset + 8
        if fourcc == b"LIST":
            yield from _chunks(data, body + 4, min(body + size, end))
        else:
            yield fourcc, body, size
        offset = body + size + (size & 1)  # chunks are word-aligned


def _is_frame(fourcc: bytes) -> bool:
    """`00db` (uncompressed DIB) or `00dc` (compressed DIB) for any stream.

    Our writer emits `00dc` even though the stream is `BI_RGB`, which is
    common and harmless — the compression is decided by `strf`, not by the
    chunk id — so both spellings are accepted.
    """
    return len(fourcc) == 4 and fourcc[:2].isdigit() and fourcc[2:] in (b"db", b"dc")


def _stream_fps(data: bytes, offset: int) -> float | None:
    """`dwRate / dwScale` from an AVISTREAMHEADER, for video streams only.

    Read but never obeyed. A clip authored at 25 or 30 fps and sent at
    `DEFAULT_FPS` plays at the wrong speed, and no byte comparison anywhere in
    this project can see it: every individual frame is correct and only the
    spacing between them is wrong. This is the one thing that can notice, which
    is why it is parsed even though `sender` ignores it.

    Rates are genuinely fractional in the wild — 30000/1001 for NTSC — so this
    returns a float and lets the caller decide what an integer `--fps` should
    do about it.
    """
    fcc_type = data[offset : offset + 4]
    if fcc_type != b"vids":
        return None
    scale, rate = struct.unpack_from("<II", data, offset + 20)
    if scale == 0:
        return None
    return rate / scale


def read_video(path: str | Path) -> Video:
    """Read an uncompressed 24-bit AVI. Raises on anything else."""
    data = Path(path).read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"AVI ":
        raise ValueError(f"{path}: not a RIFF AVI file")

    header: tuple[int, ...] | None = None
    fps: float | None = None
    frames: list[bytes] = []
    for fourcc, offset, size in _chunks(data, 12, len(data)):
        if fourcc == b"strf" and header is None:
            # BITMAPINFOHEADER: biSize biWidth biHeight biPlanes biBitCount
            # biCompression. biWidth and biHeight are signed.
            header = struct.unpack_from("<iiiHHI", data, offset)
        elif fourcc == b"strh" and fps is None:
            fps = _stream_fps(data, offset)
        elif _is_frame(fourcc):
            frames.append(data[offset : offset + size])

    if header is None:
        raise ValueError(f"{path}: no strf chunk, so no bitmap header")
    _, width, height, _planes, bit_count, compression = header
    if bit_count != 24 or compression != 0:
        raise ValueError(
            f"{path}: only uncompressed 24-bit BI_RGB is supported, got "
            f"biBitCount={bit_count} biCompression={compression}"
        )

    video = Video(width, abs(height), height < 0, frames, fps)
    expected = video.stride * video.height
    for index, frame in enumerate(frames):
        if len(frame) != expected:
            raise ValueError(f"{path}: frame {index} is {len(frame)} bytes, expected {expected}")
    return video
