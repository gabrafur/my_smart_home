#!/usr/bin/env python3
"""Summarize Moni Mobile TCP captures for protocol discovery."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Message:
    """A single captured TCP payload."""

    timestamp: str
    direction: str
    payload: bytes


@dataclass(frozen=True)
class Session:
    """A captured TCP session."""

    path: Path
    messages: tuple[Message, ...]


ACTION_HINTS = {
    "20260705T004824": "arm_away",
    "20260705T004830": "state_after_arm",
    "20260705T004844": "disarm",
    "20260705T004849": "state_after_disarm",
}


def parse_session(path: Path) -> Session:
    """Parse a capture log produced by moni_proxy.py."""
    messages: list[Message] = []
    current_ts = ""
    current_direction = ""

    for line in path.read_text(errors="ignore").splitlines():
        if " app -> central " in line or " central -> app " in line:
            current_ts = line.split(" ", 1)[0]
            current_direction = (
                "app" if " app -> central " in line else "central"
            )
        elif line.startswith("hex   "):
            payload = bytes.fromhex(line[6:].replace(" ", ""))
            messages.append(Message(current_ts, current_direction, payload))

    return Session(path, tuple(messages))


def session_hint(path: Path) -> str:
    """Return a known action hint for a capture file."""
    for needle, label in ACTION_HINTS.items():
        if needle in path.name:
            return label
    return ""


def block_id(payload: bytes, block: int = 0) -> str:
    """Return a short stable identifier for a 16-byte block."""
    start = block * 16
    end = start + 16
    if len(payload) < end:
        return ""
    return payload[start:end].hex()


def summarize_session(session: Session) -> str:
    """Build a compact one-line summary."""
    sizes = " ".join(
        f"{'A' if msg.direction == 'app' else 'C'}{len(msg.payload)}"
        for msg in session.messages
    )
    first_blocks = " ".join(
        block_id(msg.payload)[:8] for msg in session.messages[:3]
    )
    hint = session_hint(session.path)
    prefix = f"{hint:17} " if hint else " " * 18
    return f"{prefix}{session.path.name}  {sizes:<35}  {first_blocks}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "capture_dir",
        nargs="?",
        default=".local-secrets/moni-captures",
        help="Directory with moni_*.log capture files",
    )
    parser.add_argument("--prefix", default="moni_20260705T0048")
    args = parser.parse_args()

    capture_dir = Path(args.capture_dir)
    sessions = [
        parse_session(path)
        for path in sorted(capture_dir.glob(f"{args.prefix}*.log"))
    ]

    print("sessions", len(sessions))
    print()
    for session in sessions:
        print(summarize_session(session))

    print()
    print("message patterns")
    patterns = Counter(
        tuple(
            f"{'A' if msg.direction == 'app' else 'C'}{len(msg.payload)}"
            for msg in session.messages
        )
        for session in sessions
    )
    for pattern, count in patterns.most_common():
        print(f"{count:3} {' '.join(pattern)}")

    print()
    print("first app packet clusters")
    clusters: dict[str, list[str]] = defaultdict(list)
    for session in sessions:
        first_app = next(
            (msg for msg in session.messages if msg.direction == "app"), None
        )
        if first_app:
            clusters[first_app.payload.hex()].append(session.path.name)
    for packet, names in sorted(clusters.items(), key=lambda item: (-len(item[1]), item[0])):
        hints = sorted({session_hint(Path(name)) for name in names if session_hint(Path(name))})
        print(f"{len(names):3} {packet} {' '.join(hints)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
