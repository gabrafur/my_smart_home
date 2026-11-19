#!/usr/bin/env python3
"""Report Git, offsite copy and tested restoration as three separate results.

Read-only producer for the house-status dashboard. Each result carries the
last attempt, the last confirmation and the age of the data, and the producer
(not the dashboard) classifies freshness. Only fixed fields leave this script:
never paths, request ids, remote names or private manifests.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1]
SOURCES = {
    "git": CONFIG / ".git-backup-trigger" / "result",
    "offsite": CONFIG / ".daily-update-trigger" / "offsite-backup-result",
}
# Both producers run once a night; 26 h leaves room for one late cycle.
FRESH_SECONDS = 26 * 3600
STATUSES = {"success", "failed", "blocked", "skipped"}


def parse(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for token in text.split():
        key, sep, value = token.partition("=")
        if sep and key not in fields:
            fields[key] = value
    return fields


def timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def result(kind: str, now: datetime) -> dict[str, object]:
    checked = now.isoformat()
    if kind == "restore":
        # No producer records a tested restore yet; absence is unknown, not failure.
        return {"state": "unknown", "reason": "no_restore_evidence", "last_attempt_at": None,
                "last_confirmed_at": None, "age_seconds": None, "freshness": "unknown", "checked_at": checked}
    try:
        fields = parse(SOURCES[kind].read_text(encoding="utf-8")[:8192])
    except OSError:
        return {"state": "unknown", "reason": "result_unreadable", "last_attempt_at": None,
                "last_confirmed_at": None, "age_seconds": None, "freshness": "unknown", "checked_at": checked}
    status = fields.get("status", "")
    finished = timestamp(fields.get("finished_at"))
    if status not in STATUSES or finished is None or finished > now:
        return {"state": "unknown", "reason": "result_invalid", "last_attempt_at": None,
                "last_confirmed_at": None, "age_seconds": None, "freshness": "unknown", "checked_at": checked}
    age = int((now - finished).total_seconds())
    confirmed = finished if status == "success" and (kind != "offsite" or fields.get("remote_verified") == "true") else None
    reason = fields.get("reason", "none")
    if not reason.replace("_", "").isalnum():
        reason = "unclassified"
    return {
        "state": "confirmed" if confirmed else status if status != "success" else "unconfirmed",
        "reason": reason,
        "last_attempt_at": finished.isoformat(),
        # Only the latest producer result is readable; an older success is not inferred.
        "last_confirmed_at": confirmed.isoformat() if confirmed else None,
        "age_seconds": age,
        "freshness": "fresh" if age <= FRESH_SECONDS else "stale",
        "checked_at": checked,
    }


def main(argv: list[str]) -> int:
    kind = argv[1] if len(argv) > 1 else ""
    if kind not in {"git", "offsite", "restore"}:
        print(json.dumps({"state": "unknown", "reason": "invalid_argument"}))
        return 0
    print(json.dumps(result(kind, datetime.now(timezone.utc)), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
