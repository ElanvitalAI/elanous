"""Capture PTY state and retain the live descriptor for replay comparison."""

from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import select
import struct
import tempfile
import termios


DEFAULT_SNAPSHOT_ID = "pty_dee629e3"
_SCHEMA = 1
_LIVE_FDS: dict[str, int] = {}


@dataclass(eq=True)
class Snapshot:
    snapshot_id: str
    rows: int
    cols: int
    termios_attributes: list
    output: str


@dataclass(eq=True)
class ReplayState:
    snapshot: Snapshot
    live_rows: int
    live_cols: int
    live_termios_attributes: list
    matches_live: bool


def _location(snapshot_id: str) -> Path:
    if not isinstance(snapshot_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", snapshot_id):
        raise ValueError("invalid snapshot id")
    directory = Path(os.environ.get("ELANOUS_PTY_SNAPSHOT_DIR", tempfile.gettempdir() + "/elanous-pty-snapshots"))
    return directory / (snapshot_id + ".json")


def _size(fd: int) -> tuple[int, int]:
    rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
    return rows, cols


def _serialize_attrs(attrs: list) -> list:
    return attrs[:6] + [[
        {"bytes": entry.hex()} if isinstance(entry, bytes) else entry
        for entry in attrs[6]
    ]]


def _deserialize_attrs(value: object) -> list:
    if not isinstance(value, list) or len(value) != 7 or any(
        type(item) is not int for item in value[:6]
    ) or not isinstance(value[6], list):
        raise ValueError("invalid termios attributes")
    controls = []
    for item in value[6]:
        if type(item) is int and 0 <= item <= 255:
            controls.append(item)
        elif isinstance(item, dict) and set(item) == {"bytes"} and isinstance(item["bytes"], str):
            try:
                controls.append(bytes.fromhex(item["bytes"]))
            except ValueError as error:
                raise ValueError("invalid termios control byte") from error
        else:
            raise ValueError("invalid termios control byte")
    return value[:6] + [controls]


def snapshot(pty_fd: int, snapshot_id: str = DEFAULT_SNAPSHOT_ID) -> Snapshot:
    """Drain currently available output from a PTY master and save its state."""
    path = _location(snapshot_id)
    rows, cols = _size(pty_fd)
    attrs = termios.tcgetattr(pty_fd)
    output = bytearray()
    while select.select([pty_fd], [], [], 0)[0]:
        chunk = os.read(pty_fd, 65536)
        if not chunk:
            break
        output.extend(chunk)
    captured = Snapshot(snapshot_id, rows, cols, attrs, output.decode("utf-8"))
    payload = {
        "schema": _SCHEMA,
        "snapshot_id": snapshot_id,
        "rows": rows,
        "cols": cols,
        "termios_attributes": _serialize_attrs(attrs),
        "output": captured.output,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(payload, file, ensure_ascii=False)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(path)
    _LIVE_FDS[snapshot_id] = pty_fd
    return captured


def restore(snapshot_id: str = DEFAULT_SNAPSHOT_ID) -> ReplayState:
    """Load a validated snapshot and compare it with its live PTY."""
    path = _location(snapshot_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise ValueError("invalid snapshot document") from error
    if not isinstance(payload, dict) or set(payload) != {
        "schema", "snapshot_id", "rows", "cols", "termios_attributes", "output"
    } or type(payload["schema"]) is not int or payload["schema"] != _SCHEMA or payload["snapshot_id"] != snapshot_id or any(
        type(payload[field]) is not int or not 0 <= payload[field] <= 65535 for field in ("rows", "cols")
    ) or not isinstance(payload["output"], str):
        raise ValueError("snapshot schema or id mismatch")
    attrs = _deserialize_attrs(payload["termios_attributes"])
    saved = Snapshot(snapshot_id, payload["rows"], payload["cols"], attrs, payload["output"])
    if snapshot_id not in _LIVE_FDS:
        raise RuntimeError("no live PTY registered for snapshot")
    fd = _LIVE_FDS[snapshot_id]
    live_rows, live_cols = _size(fd)
    live_attrs = termios.tcgetattr(fd)
    return ReplayState(
        saved, live_rows, live_cols, live_attrs,
        (live_rows, live_cols, live_attrs) == (saved.rows, saved.cols, saved.termios_attributes),
    )
