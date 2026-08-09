"""Video frames -> the framebuffers the sender sends.

`avi.Video` holds raw DIB scanlines: BGR, padded to a 4-byte stride, and
bottom-up unless `top_down`. `frame.py` wants plain RGB, top-left origin,
row-major, `config.pixel_count * 3` bytes. This module is that conversion and
nothing else — the one new seam between two halves of the project that were
each already tested, and the last thing standing between us and Ledset.

Two deliberate choices:

* **`Video.pixel` does the addressing**, rather than this module indexing the
  raw bytes. The stride padding and `biHeight`'s sign are already handled there,
  and a second implementation of them is how you get a mirrored frame that
  still looks plausible.
* **The size check happens here**, not in the sender, because here it happens
  before a socket exists. `pack_send_buffer` would otherwise raise at frame 0
  with the floor already being broadcast to.
"""

from __future__ import annotations

from .avi import Video
from .floors import FloorConfig


def framebuffers(video: Video, config: FloorConfig) -> list[bytes]:
    """Every frame of `video` as an RGB framebuffer for `config`.

    Decoding is done once, up front, for the whole clip. At the 10x5 `8x8_4P`
    geometry that is ~215 ms and ~576 KB for a 60-frame clip, against a 100 ms
    frame interval — so it stays off the send loop's critical path, which is
    what lets the loop be gapless rather than merely fast.
    """
    if (video.width, video.height) != (config.width_px, config.height_px):
        raise ValueError(
            f"video is {video.width}x{video.height}, but the floor is "
            f"{config.width_px}x{config.height_px} -- wrong asset for "
            f"{config.describe()}"
        )

    pixel = video.pixel
    width, height = video.width, video.height
    out: list[bytes] = []
    for frame in video.frames:
        buffer = bytearray(width * height * 3)
        i = 0
        for y in range(height):
            for x in range(width):
                buffer[i : i + 3] = pixel(frame, x, y)
                i += 3
        out.append(bytes(buffer))
    return out
