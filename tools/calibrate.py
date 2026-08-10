#!/usr/bin/env python3
"""Interactive by-eye white-balance tuner for the LED floor.

Part of one tile on the rig reads orange at full white -- confirmed tile
hardware, no vendor fix. This lets an operator standing at the floor select
the bad region, nudge its R/G/B gains down until it matches its neighbours,
and write a `mapper.calibration` file that `python -m mapper play
--calibration ...` (or `send --calibration ...`) then applies.

    python tools/calibrate.py --type 8x8_4P --cols 10 --rows 5 \\
        --local-ip 10.200.50.78 [--load existing.json] [--out calibration.json]

A background thread runs `mapper.sender.run(...)` forever against a frame
source that rebuilds the framebuffer from the current shared state on every
call; the main thread reads single keypresses and mutates that state under a
`threading.Lock`. See `_HELP_TEXT` below for the exact key map, and the
module docstring of `mapper/calibration.py` for what a calibration file is
(and, pointedly, is not) evidence of.

Portability
-----------
This is a Windows-only tool today. Every bit of platform-specific code is
isolated in `_read_key()` at the bottom of the file -- it reads one keypress
via stdlib `msvcrt` and normalises it to the same small vocabulary of
strings ('up', 'left', 'tab', a literal character, ...) that `handle_key()`
consumes. `msvcrt` is imported lazily, inside that function, so merely
*importing* this module on a non-Windows machine does not explode; `main()`
below refuses to run at all on a non-Windows platform before ever calling it.

**A macOS/Linux version is still owed.** The only things a future session
needs to write are: a replacement `_read_key()` that reads one keypress from
a cbreak-mode terminal (`termios`/`tty.setcbreak` + `os.read(fd, 1)`,
decoding arrow-key escape sequences such as `\\x1b[A` into the same
'up'/'down'/'left'/'right' strings this one returns), and a matching raw-mode
context manager (`tty`/`termios`, saving and restoring `termios.tcgetattr`)
to stand in for the Windows console, which needs no such setup. Everything
else in this file -- the state machine (`TunerState`, `handle_key` and its
helpers), the frame builder, the argument parsing, and the file I/O -- is
already portable stdlib and untouched by the platform split.
"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    # `python -m tools.calibrate` (this repo's usual convention -- see
    # `python -m tools.make_clip` in mapper/README.md) already runs with the
    # repo root on `sys.path` and does not need this. Bare `python
    # tools/calibrate.py` does not, and the task's Definition of Done names
    # that exact invocation, so this makes both forms work identically
    # rather than picking one and leaving the other a trap.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import threading
from datetime import date
from typing import Callable

from mapper.calibration import Calibration, Region, load as load_calibration
from mapper.floors import DEST_ADDRESS, DEST_PORT, FLOOR_TYPES, FloorConfig
from mapper.patterns import solid
from mapper.sender import DEFAULT_FPS, run as sender_run

#: The `t` cycle. 255 first: a defect that reads orange at full white is the
#: whole reason this tool exists, so that is the level an operator wants on
#: entry, not something they have to press a key to reach.
BASE_LEVELS = (255, 192, 128, 64)

#: Fine nudge step for '-'/'+' (and their shifted forms '_'/'=', which this
#: tool treats identically -- see the header comment on `_HELP_TEXT` for why
#: that is a deliberate reading of an ambiguous spec, not an oversight).
FINE_STEP = 0.01

#: Coarse nudge step for shifted R/G/B. Chosen as a *decrease* (see
#: `_HELP_TEXT`): the floor's own defect is a tile that is too bright, so the
#: coarse shortcut an operator reaches for first is "bring it down a lot",
#: not up.
COARSE_STEP = 0.05

_HELP_TEXT = """\
calibrate -- by-eye white-balance tuner

  Movement (two granularities -- pick either, both always work):
    Up/Down/Left/Right    move the selection one whole TILE
    h j k l  (any case)   move the selection one PIXEL (vi directions:
                          h=left, l=right, k=up, j=down)
    Esc                   deselect the active region -- leaves it exactly
                          where it is and frees the cursor at its rect, so
                          movement keys start a fresh selection from there
                          (this is how you aim 'n' at a second bad tile)
  [ ]                     shrink / grow the selection (halves / doubles
                          each side, minimum 1x1; growth that would run
                          past the floor edge is capped there instead --
                          the top-left corner always stays put, never the
                          growth direction; the status line says so when
                          it happens)

  r g b                   choose the active channel (for -/+ below)
  R G B (shift)           choose that channel AND nudge it down %.2f in
                          one keystroke -- the coarse "dim this a lot"
                          shortcut; there is no coarse *up*, since the
                          defect this tool exists for is a tile that is
                          too bright
  - _                     nudge the active channel's gain down %.2f
  + =                     nudge the active channel's gain up %.2f

  n                       new region at the current selection, gain 1,1,1
  0 (zero)                reset the selected region's gain to 1,1,1
  d                       delete the selected region
  Tab                     cycle the selected region among existing ones

  space                   BYPASS -- send the raw base level with NO
                          calibration applied at all (not a gain of 1.0
                          through the same code path -- an actual bypass,
                          so the A/B is against the real floor, not
                          against this tool's own correction). Gain edits
                          still land in the file while bypassed -- the
                          status line marks each one, since the floor
                          itself shows no change until bypass is off again
  t                       cycle the base level 255 -> 192 -> 128 -> 64

  w                       write the calibration file. Refuses to clobber a
                          file that existed before this session unless
                          --force was passed; once this session has
                          written it once, later w's overwrite it freely
  q                       quit. With unsaved changes this arms a
                          confirmation -- press q again immediately to
                          quit without saving, or w first to keep them.
                          Ctrl-C quits outright, no confirmation.

  If the sender thread dies (e.g. a bad --local-ip), the status line
  leads with a "SENDER THREAD DEAD" alarm. Every key still works, but
  nothing reaches the floor until the tool is restarted.
""" % (COARSE_STEP, FINE_STEP, FINE_STEP)


# --------------------------------------------------------------------------
# State machine. No msvcrt, no sockets, no file I/O below this line until
# `write_calibration` / `main` -- this is what a scratch script can import
# and drive without touching a network or a real keyboard.
# --------------------------------------------------------------------------


class TunerState:
    """Everything one interactive session is currently looking at.

    Mutated only through `handle_key` (and `write_calibration` for the one
    action that needs the filesystem), always under `lock`. The background
    sender thread only ever *reads* `calibration`/`base_level`/`bypass`, and
    does so under the same lock, copying before it builds a frame -- see
    `make_frame_source`.
    """

    def __init__(self, config: FloorConfig, floor_tag: tuple[str, int, int]) -> None:
        self.config = config
        self.floor_tag = floor_tag
        self.lock = threading.Lock()

        self.regions: list[Region] = []
        self.calibration = Calibration(regions=(), floor=floor_tag)

        tile = config.type.tile_px
        #: [x, y, w, h] of the free-floating cursor, used when `active` is
        #: `None`. Starts as one whole tile, snapped to the tile grid.
        self.cursor: list[int] = [0, 0, tile, tile]
        #: Index into `regions` of the region currently being edited, or
        #: `None` if the cursor has not been committed as a region yet.
        self.active: int | None = None

        self.channel: str = "r"
        self.bypass: bool = False
        self.base_level: int = BASE_LEVELS[0]
        self.dirty: bool = False
        self.message: str = "ready"

        #: Set when the background sender thread dies (an exception from
        #: `sender.run`, most commonly `open_socket` failing to bind a bad
        #: `--local-ip`). Surfaced loudly by `status_line` rather than left
        #: to look like a silently healthy send -- see `_check_sender_alive`.
        self.sender_dead: bool = False
        self.sender_error: str | None = None

        #: 'q' while `dirty` arms this instead of quitting outright; a
        #: second, immediate 'q' then quits. Any other key clears it. See
        #: `handle_key`.
        self.confirm_quit: bool = False

        #: Whether *this session* has itself already written `--out` once.
        #: `--force` only ever governs clobbering a file that predates the
        #: session; once the session owns the file, 'w' overwrites it
        #: freely from then on. See `write_calibration`.
        self.wrote_once: bool = False


def make_initial_state(
    config: FloorConfig,
    initial_regions: tuple[Region, ...],
    floor_tag: tuple[str, int, int],
) -> TunerState:
    """Build a `TunerState` seeded from `--load`'s regions, if any.

    Raises `ValueError` (uncaught here, same as every other operator-error
    path in this file) if the loaded regions do not stand up as a
    `Calibration` re-tagged for the *current* geometry -- see the note in
    `main` about why the file is always re-tagged with the running floor
    rather than whatever it claimed on disk.
    """
    state = TunerState(config, floor_tag)
    if initial_regions:
        cal = Calibration(regions=tuple(initial_regions), floor=floor_tag)
        cal.validate(config)
        state.regions = list(initial_regions)
        state.calibration = cal
    return state


def _clamp(value: int, lo: int, hi: int) -> int:
    if hi < lo:
        return lo
    return max(lo, min(value, hi))


def _auto_note(state: TunerState) -> str:
    """`note` records *when* and *at what base level* a region was judged.

    Per `mapper/calibration.py`'s module docstring, a calibration file's
    value later is entirely in knowing that -- so this is called on every
    gain-changing action (nudge, coarse nudge, reset, creation), not just
    on write. A move or resize does *not* refresh it: relocating a region's
    rectangle is not a re-judgement of how much dimmer it needs to be.
    """
    return f"tuned {date.today().isoformat()} at base {state.base_level}"


def _try_replace_region(
    state: TunerState, index: int, status_suffix: str = "", **updates
) -> None:
    """Rebuild region `index` with `updates` applied, or refuse the edit.

    `Region.__post_init__` and `Calibration.__post_init__` are the source of
    truth for "is this legal" (gain range, overlap); this just catches the
    `ValueError` either can raise and turns it into a status-line message
    instead of a crash -- see the requirement in the task spec that a bad
    edit must not be able to end a session at the floor.

    On success, `state.cursor` is resynced to the region's (possibly new)
    rect. Every caller of this function acts on the *active* region, so
    without this a move or resize left the cursor pointing at stale
    coordinates -- the bug where `n`, after repositioning a region, tried
    to create the next one wherever the cursor had last been free, not
    where the operator was now looking.
    """
    r = state.regions[index]
    fields = {"x": r.x, "y": r.y, "w": r.w, "h": r.h, "gain": r.gain, "note": r.note}
    fields.update(updates)
    try:
        candidate = Region(**fields)
    except ValueError as exc:
        state.message = f"edit refused: {exc}"
        return

    new_regions = list(state.regions)
    new_regions[index] = candidate
    try:
        new_cal = Calibration(regions=tuple(new_regions), floor=state.floor_tag)
        new_cal.validate(state.config)
    except ValueError as exc:
        state.message = f"edit refused: {exc}"
        return

    state.regions = new_regions
    state.calibration = new_cal
    state.dirty = True
    if state.active == index:
        state.cursor = [candidate.x, candidate.y, candidate.w, candidate.h]
    gain = tuple(round(g, 3) for g in candidate.gain)
    state.message = (
        f"region {index}: ({candidate.x},{candidate.y}) "
        f"{candidate.w}x{candidate.h} gain={gain}{status_suffix}"
    )


def _move(state: TunerState, dx: int, dy: int) -> None:
    width, height = state.config.width_px, state.config.height_px
    if state.active is not None:
        r = state.regions[state.active]
        nx = _clamp(r.x + dx, 0, width - r.w)
        ny = _clamp(r.y + dy, 0, height - r.h)
        _try_replace_region(state, state.active, x=nx, y=ny)
    else:
        x, y, w, h = state.cursor
        nx = _clamp(x + dx, 0, width - w)
        ny = _clamp(y + dy, 0, height - h)
        state.cursor[0], state.cursor[1] = nx, ny
        state.message = f"selection ({nx},{ny}) {w}x{h}"


def _resize(state: TunerState, grow: bool) -> None:
    """Halve/double toward the floor edge, top-left corner held fixed.

    The previous version clamped the *position* to make the new size fit,
    which silently slid a region's origin away from wherever the operator
    had placed it whenever growth ran past the right or bottom edge --
    directly contradicting the on-screen help's own claim that the corner
    stays put. The fix clamps the *size* to what actually fits at the
    current `(x, y)` instead, and says so in the status line when that caps
    the growth short of a full double.
    """
    width, height = state.config.width_px, state.config.height_px
    if state.active is not None:
        r = state.regions[state.active]
        x, y, w, h = r.x, r.y, r.w, r.h
    else:
        x, y, w, h = state.cursor

    max_w, max_h = width - x, height - y
    if grow:
        desired_w, desired_h = w * 2, h * 2
        nw, nh = min(desired_w, max_w), min(desired_h, max_h)
        capped = nw < desired_w or nh < desired_h
    else:
        nw, nh = max(1, w // 2), max(1, h // 2)
        capped = False

    suffix = " -- capped at the floor edge, top-left held" if capped else ""

    if state.active is not None:
        _try_replace_region(state, state.active, x=x, y=y, w=nw, h=nh, status_suffix=suffix)
    else:
        state.cursor[:] = [x, y, nw, nh]
        state.message = f"selection ({x},{y}) {nw}x{nh}{suffix}"


def _nudge(state: TunerState, delta: float) -> None:
    if state.active is None:
        state.message = (
            "no region selected -- 'n' creates one at the selection, "
            "Tab cycles to an existing one"
        )
        return
    r = state.regions[state.active]
    gains = list(r.gain)
    idx = {"r": 0, "g": 1, "b": 2}[state.channel]
    gains[idx] = round(_clamp(gains[idx] + delta, 0.0, 1.0), 4)
    suffix = " (bypassed -- no floor change)" if state.bypass else ""
    _try_replace_region(
        state, state.active, gain=tuple(gains), note=_auto_note(state), status_suffix=suffix
    )


def _new_region(state: TunerState) -> None:
    x, y, w, h = state.cursor
    try:
        candidate = Region(x=x, y=y, w=w, h=h, gain=(1.0, 1.0, 1.0), note=_auto_note(state))
    except ValueError as exc:
        state.message = f"cannot create region: {exc}"
        return

    new_regions = state.regions + [candidate]
    try:
        new_cal = Calibration(regions=tuple(new_regions), floor=state.floor_tag)
        new_cal.validate(state.config)
    except ValueError as exc:
        state.message = f"new region refused: {exc}"
        return

    state.regions = new_regions
    state.calibration = new_cal
    state.active = len(new_regions) - 1
    state.dirty = True
    suffix = " (bypassed -- no floor change)" if state.bypass else ""
    state.message = f"created region {state.active} at ({x},{y}) {w}x{h}{suffix}"


def _reset_active(state: TunerState) -> None:
    if state.active is None:
        state.message = "no region selected"
        return
    suffix = " (bypassed -- no floor change)" if state.bypass else ""
    _try_replace_region(
        state, state.active, gain=(1.0, 1.0, 1.0), note=_auto_note(state), status_suffix=suffix
    )


def _delete_active(state: TunerState) -> None:
    if state.active is None:
        state.message = "no region selected"
        return
    removed = state.regions[state.active]
    new_regions = state.regions[: state.active] + state.regions[state.active + 1 :]
    # Deleting a region can never create an overlap, so this cannot raise.
    state.calibration = Calibration(regions=tuple(new_regions), floor=state.floor_tag)
    state.regions = new_regions
    state.cursor = [removed.x, removed.y, removed.w, removed.h]
    state.active = None
    state.dirty = True
    state.message = f"deleted region at ({removed.x},{removed.y}) {removed.w}x{removed.h}"


def _deselect(state: TunerState) -> None:
    """Esc: stop editing the active region without deleting it.

    The free cursor is left at the region's current rect, so movement keys
    resume moving a free selection from there. This is the explicit
    deselect action the key map was missing -- previously nothing cleared
    `active` short of deleting the region outright, so `n` for a second bad
    tile only ever landed at wherever the cursor had last been free, not
    where the operator had since moved the active region to.
    """
    if state.active is None:
        state.message = "no region selected"
        return
    r = state.regions[state.active]
    state.cursor = [r.x, r.y, r.w, r.h]
    state.active = None
    state.message = f"deselected region ({r.x},{r.y}) {r.w}x{r.h} -- cursor free"


def _cycle_active(state: TunerState) -> None:
    if not state.regions:
        state.message = "no regions yet -- 'n' creates one at the selection"
        return
    state.active = 0 if state.active is None else (state.active + 1) % len(state.regions)
    r = state.regions[state.active]
    state.cursor = [r.x, r.y, r.w, r.h]
    state.message = f"region {state.active}/{len(state.regions)} selected"


def _cycle_base(state: TunerState) -> None:
    idx = BASE_LEVELS.index(state.base_level)
    state.base_level = BASE_LEVELS[(idx + 1) % len(BASE_LEVELS)]
    state.message = f"base level {state.base_level}"


def _toggle_bypass(state: TunerState) -> None:
    state.bypass = not state.bypass
    state.message = (
        "BYPASS -- raw floor, NO calibration applied" if state.bypass else "calibration applied"
    )


#: Keys handled directly as one pixel of movement. Deliberately case-folded
#: to both cases -- see `_HELP_TEXT` for why shift+hjkl was chosen over
#: shift+arrow (which raw console input cannot reliably distinguish from
#: unshifted arrow at all) as the fine-movement modifier.
_PIXEL_MOVES = {
    "h": (-1, 0), "H": (-1, 0),
    "l": (1, 0), "L": (1, 0),
    "k": (0, -1), "K": (0, -1),
    "j": (0, 1), "J": (0, 1),
}

_TILE_MOVES = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


def handle_key(state: TunerState, key: str) -> str:
    """Apply one normalised keypress to `state`. Returns 'continue' | 'write' | 'quit'.

    `'write'` and `'quit'` are handed back rather than acted on here so this
    function -- and therefore the whole state machine -- never touches the
    filesystem or a socket. That is what makes it possible to unit-exercise
    this from a scratch script with no floor, no network and no terminal.

    `q` with unsaved changes does not quit outright: it arms
    `confirm_quit` and asks for a second, immediate `q` instead, since the
    key an operator reaches for to leave is otherwise the same one that
    silently discards whatever they just tuned. Any other key disarms it,
    so only two `q`s in a row -- nothing in between -- confirm the quit.
    """
    with state.lock:
        if key == "q":
            if state.dirty and not state.confirm_quit:
                state.confirm_quit = True
                state.message = (
                    "unsaved changes -- press q again to quit without saving, or w to save first"
                )
                return "continue"
            return "quit"
        state.confirm_quit = False

        if key == "w":
            return "write"

        if key in _TILE_MOVES:
            dx, dy = _TILE_MOVES[key]
            tile = state.config.type.tile_px
            _move(state, dx * tile, dy * tile)
        elif key in _PIXEL_MOVES:
            dx, dy = _PIXEL_MOVES[key]
            _move(state, dx, dy)
        elif key == "[":
            _resize(state, grow=False)
        elif key == "]":
            _resize(state, grow=True)
        elif key == "r":
            state.channel = "r"
            state.message = "channel R"
        elif key == "g":
            state.channel = "g"
            state.message = "channel G"
        elif key == "b":
            state.channel = "b"
            state.message = "channel B"
        elif key == "R":
            state.channel = "r"
            _nudge(state, -COARSE_STEP)
        elif key == "G":
            state.channel = "g"
            _nudge(state, -COARSE_STEP)
        elif key == "B":
            state.channel = "b"
            _nudge(state, -COARSE_STEP)
        elif key in ("-", "_"):
            _nudge(state, -FINE_STEP)
        elif key in ("+", "="):
            _nudge(state, FINE_STEP)
        elif key == "t":
            _cycle_base(state)
        elif key == "n":
            _new_region(state)
        elif key == "0":
            _reset_active(state)
        elif key == "d":
            _delete_active(state)
        elif key == "tab":
            _cycle_active(state)
        elif key == "esc":
            _deselect(state)
        elif key == " ":
            _toggle_bypass(state)
        else:
            state.message = f"unrecognised key {key!r} -- see the help printed at startup"
    return "continue"


def status_line(state: TunerState) -> str:
    with state.lock:
        n = len(state.regions)
        if state.active is not None:
            r = state.regions[state.active]
            gain = tuple(round(g, 3) for g in r.gain)
            where = f"region {state.active}/{n} ({r.x},{r.y}) {r.w}x{r.h} gain={gain}"
        else:
            x, y, w, h = state.cursor
            where = f"no region [{n} exist] -- cursor ({x},{y}) {w}x{h}"
        channel = state.channel.upper()
        base = state.base_level
        sender_dead = state.sender_dead
        sender_error = state.sender_error
        mode = "SENDER DEAD" if sender_dead else ("BYPASS(raw)" if state.bypass else "calibrated")
        dirty = "*unsaved*" if state.dirty else "saved"
        message = state.message
    # Deliberately the loudest thing on the line. A dead sender previously
    # read as "calibrated | *unsaved*" -- indistinguishable from a healthy
    # session -- while every packet the operator thought they were judging
    # by eye was never sent.
    alarm = (
        f"!!! SENDER THREAD DEAD, NOTHING IS ON THE WIRE ({sender_error}) !!! "
        if sender_dead
        else ""
    )
    return f"{alarm}[{where} | ch={channel} | base={base} | {mode} | {dirty}] {message}"


def _check_sender_alive(state: TunerState, thread: threading.Thread) -> None:
    """Make a dead sender thread loud the moment it is noticed.

    `sender.run` only ever exits early on an exception raised before its own
    `try/except KeyboardInterrupt` takes over -- most commonly
    `open_socket` failing to bind a bad `--local-ip`. `_send_forever`
    catches that and records it into `state`, but nothing previously
    checked the thread's pulse, so a dead sender looked identical to a
    healthy one for the rest of the session. Call this once per key-loop
    iteration.
    """
    if thread.is_alive():
        return
    with state.lock:
        if not state.sender_dead:
            state.sender_dead = True
            if not state.sender_error:
                state.sender_error = "thread exited without recording a cause"
            state.message = f"SENDER THREAD DEAD: {state.sender_error}"


# --------------------------------------------------------------------------
# Frame building for the background sender thread.
# --------------------------------------------------------------------------


def make_frame_source(state: TunerState, stop_event: threading.Event) -> Callable[[int], bytes]:
    """A `frame_source` for `mapper.sender.run`, closed over `state`.

    `run` is invoked with `duration=None` and no `total_frames`, i.e. it
    sends forever (see `mapper/sender.py::frame_numbers`) until
    `KeyboardInterrupt` reaches it. There is no public way to stop a
    background thread's `run()` call from outside -- but `run`'s own
    `except KeyboardInterrupt: pass` wraps the call to this function, so
    raising `KeyboardInterrupt` *from here* when `stop_event` is set is
    exactly the exit path `run` already offers, reached without touching
    `sender.py`.

    The lock is held only long enough to copy `calibration`/`base_level`/
    `bypass`; the pattern build and the (possibly per-region) gain-table
    application happen after it is released, per the task's requirement
    that frame building must not hold the lock while sending.
    """

    def frame_source(n: int) -> bytes:
        if stop_event.is_set():
            raise KeyboardInterrupt
        with state.lock:
            calibration = state.calibration
            base_level = state.base_level
            bypass = state.bypass
        base = solid(state.config, base_level, base_level, base_level)
        if bypass:
            # Not `calibration.apply` with an identity gain -- an actual
            # bypass. Re-applying a gain of 1.0 through the same apply()
            # path would compare the correction against itself, which is
            # exactly the class of self-confirming error CLAUDE.md warns
            # about; this returns the untouched base buffer instead.
            return bytes(base)
        return bytes(calibration.apply(state.config, base))

    return frame_source


# --------------------------------------------------------------------------
# File I/O -- kept out of `handle_key` so the state machine stays testable
# without a filesystem.
# --------------------------------------------------------------------------


def write_calibration(state: TunerState, out_path: Path, force: bool) -> Path:
    """Write the current calibration to `out_path`. Mirrors `mapper fixtures`.

    `force` governs only clobbering a file that existed **before this
    session started**. Once this session has written `out_path` itself,
    every later `w` overwrites it freely, `force` or not -- the previous
    version checked `force` unconditionally, so the *second* `w` of every
    session raised `FileExistsError` against the file the *first* `w` had
    just created, and the operator's final keystrokes before quitting were
    exactly the ones most likely to never reach disk.

    Written via a temp file plus an atomic rename (`Path.replace`, which
    overwrites the destination on both Windows and POSIX) so a write that
    fails partway -- a full disk, a yanked cable -- cannot leave a
    half-written `out_path` in place of a good one.

    Raises `OSError` (of which `FileExistsError` is one case) rather than
    doing anything, so the caller can report it and keep the session alive
    instead of losing the operator's in-memory work over a filesystem
    problem.
    """
    with state.lock:
        pre_existing_before_session = out_path.exists() and not state.wrote_once
        text = state.calibration.dumps()

    if pre_existing_before_session and not force:
        raise FileExistsError(
            f"{out_path} already existed before this session -- pass --force to overwrite it "
            "(once a write from this session succeeds, later ones overwrite it freely)"
        )

    tmp_path = out_path.with_name(out_path.name + ".tmp")
    try:
        tmp_path.write_text(text, encoding="utf-8")
        tmp_path.replace(out_path)
    except OSError:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise

    with state.lock:
        state.wrote_once = True
    return out_path.resolve()


# --------------------------------------------------------------------------
# Windows raw keypress reading -- the ONLY platform-specific code in this
# file. See the module docstring's "Portability" section.
# --------------------------------------------------------------------------


def _read_key() -> str | None:
    """Block for one keypress and normalise it.

    Returns 'up' / 'down' / 'left' / 'right' / 'tab' / 'esc' for the keys of
    the same name, or the literal typed character (case preserved) for
    everything else it recognises, or `None` for a byte it does not.

    `msvcrt.getch()` needs no raw-mode setup on Windows -- it already reads
    one keypress without waiting for Enter and without echoing it, which is
    the whole reason this project's console tools use it. That is also why
    there is no raw-mode context manager here to pair with `_read_key`: on
    Windows there is nothing to enter or restore. A `termios`/`tty` port
    will need one (see the module docstring).
    """
    import msvcrt

    ch = msvcrt.getch()
    if ch in (b"\x00", b"\xe0"):
        # Function/arrow keys arrive as a two-byte sequence.
        ch2 = msvcrt.getch()
        return {b"H": "up", b"P": "down", b"K": "left", b"M": "right"}.get(ch2)
    if ch == b"\t":
        return "tab"
    if ch == b"\x03":
        # Ctrl-C -- quits outright, same as before.
        return "q"
    if ch == b"\x1b":
        # Escape -- deselects (see `_deselect`), NOT quit. A stray Escape
        # pressed to dismiss an "edit refused:" message must not be able
        # to end the session.
        return "esc"
    try:
        return ch.decode("ascii")
    except UnicodeDecodeError:
        return None


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _positive_fps(value: str) -> int:
    """`argparse` `type=` for `--fps`: reject anything that cannot pace a send.

    `0` divides `sender.run`'s `interval = 1.0 / fps` by zero and kills the
    sender thread before it sends a single packet; a negative value is
    accepted by plain `int` and makes `interval` negative, so `run` never
    sleeps and broadcasts flat out with no pacing at all. Both are operator
    typos, not floor conditions, so they are rejected here at parse time --
    `argparse.ArgumentTypeError` becomes a normal exit-2 usage error, no
    traceback -- rather than surfacing later as a dead or runaway thread.
    """
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"--fps must be a whole number, got {value!r}") from None
    if n < 1:
        raise argparse.ArgumentTypeError(
            f"--fps must be >= 1, got {n} -- 0 divides by zero and kills the sender thread "
            "outright, and a negative value sends with no pacing at all"
        )
    return n


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="calibrate",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--type", required=True, choices=sorted(FLOOR_TYPES))
    parser.add_argument("--cols", required=True, type=int, help="tile columns")
    parser.add_argument("--rows", required=True, type=int, help="tile rows")
    parser.add_argument("--local-ip", help="bind to a specific NIC, e.g. 10.200.50.78")
    parser.add_argument("--load", metavar="PATH", help="existing calibration file to start from")
    parser.add_argument(
        "--out", default="calibration.json", metavar="PATH", help="path 'w' writes to"
    )
    parser.add_argument(
        "--force", action="store_true", help="let 'w' overwrite an existing --out file"
    )
    parser.add_argument("--fps", type=_positive_fps, default=DEFAULT_FPS)
    parser.add_argument("--address", default=DEST_ADDRESS)
    parser.add_argument("--port", type=int, default=DEST_PORT)
    return parser


def main(argv: list[str] | None = None) -> int:
    # Parsed first so `--help` (and ordinary usage errors) work regardless
    # of platform -- argparse's own `-h` handling exits before this ever
    # runs, so checking platform first was refusing `--help` on a machine
    # that will never reach `_read_key` at all.
    args = build_parser().parse_args(argv)

    if not sys.platform.startswith("win"):
        print(
            "the tuner needs a Windows key reader today, see the header comment",
            file=sys.stderr,
        )
        return 2

    try:
        config = FloorConfig.of(args.type, args.cols, args.rows)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    # Always tagged with the *current* run's geometry, regardless of what a
    # `--load`ed file claimed -- this session is judging this floor, right
    # now, and that is the claim the written file should make.
    floor_tag = (config.type.name, config.tile_cols, config.tile_rows)

    initial_regions: tuple[Region, ...] = ()
    if args.load:
        try:
            loaded = load_calibration(args.load)
            loaded.validate(config)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        initial_regions = loaded.regions
        print(f"loaded {args.load}: {len(initial_regions)} region(s)")

    try:
        state = make_initial_state(config, initial_regions, floor_tag)
    except ValueError as exc:
        print(f"{args.load}: {exc}", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    stop_event = threading.Event()
    frame_source = make_frame_source(state, stop_event)

    def _send_forever() -> None:
        # `sender.run` swallows its own `KeyboardInterrupt` (that is how
        # `stop_event` shuts it down cleanly, see `make_frame_source`), but
        # nothing else it can raise is caught anywhere -- `open_socket`
        # failing to bind a bad `--local-ip` raises `OSError` before `run`'s
        # own try/except even starts. Uncaught, that traceback would print
        # via `threading.excepthook` and vanish under the help text and
        # status lines that follow, leaving the operator tuning against a
        # floor nobody is driving. Catching it here and recording it into
        # `state` is what `_check_sender_alive` / `status_line` surface.
        try:
            sender_run(
                config,
                frame_source,
                duration=None,
                fps=args.fps,
                address=args.address,
                port=args.port,
                local_ip=args.local_ip,
            )
        except Exception as exc:
            with state.lock:
                state.sender_dead = True
                state.sender_error = str(exc) or exc.__class__.__name__
                state.message = f"SENDER THREAD DEAD: {state.sender_error}"

    thread = threading.Thread(target=_send_forever, name="calibrate-sender", daemon=True)
    thread.start()

    print(config.describe())
    # The only on-screen confirmation of which NIC/address the broadcast
    # actually left by -- `cmd_send`/`cmd_play` print the equivalent line in
    # `mapper/cli.py`; this was missing here entirely.
    print(
        f"sending to {args.address}:{args.port} at {args.fps} fps, forever"
        + (f" from {args.local_ip}" if args.local_ip else "")
    )
    print(_HELP_TEXT)
    _check_sender_alive(state, thread)
    print(status_line(state))
    try:
        while True:
            # Widened to cover the whole iteration, not just `_read_key()`:
            # a Ctrl-C landing during `handle_key`, `write_calibration` or
            # the status `print` used to escape uncaught, turning a clean
            # quit into exit 1 with a traceback in place of the
            # controller-1 caveat.
            try:
                key = _read_key()
                if key is None:
                    _check_sender_alive(state, thread)
                    continue
                action = handle_key(state, key)
                if action == "write":
                    try:
                        resolved = write_calibration(state, out_path, args.force)
                    except OSError as exc:
                        with state.lock:
                            state.message = f"write failed: {exc}"
                    else:
                        with state.lock:
                            state.dirty = False
                        print(f"wrote {resolved}")
                elif action == "quit":
                    break
                _check_sender_alive(state, thread)
                print(status_line(state))
            except KeyboardInterrupt:
                break
    finally:
        stop_event.set()
        thread.join(timeout=2.0)

    print(
        "controller 1 (Master/IR) times out ~5s after packets stop and reverts to "
        "local content; controllers 2 and 3 hold their last frame indefinitely -- "
        "not a defect, see CLAUDE.md"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
