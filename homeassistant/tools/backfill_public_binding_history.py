#!/usr/bin/env python3
"""Backfill public-binding Recorder history without exposing private targets."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path
from typing import Any


HISTORY_DOMAINS = {"binary_sensor", "device_tracker", "lock", "sensor"}
ENTITY_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])(?:binary_sensor|device_tracker|lock|sensor)\.[a-z0-9_]+"
)
STATISTIC_COLUMNS = (
    "created",
    "created_ts",
    "start",
    "start_ts",
    "mean",
    "mean_weight",
    "min",
    "max",
    "last_reset",
    "last_reset_ts",
    "state",
    "sum",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="/config/home-assistant_v2.db")
    parser.add_argument(
        "--bindings", default="/run/private-bindings/private-bindings.json"
    )
    parser.add_argument("--dashboard", default="/config/dashboards/vehicle_primary.yaml")
    parser.add_argument("--role", default="vehicle_primary")
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def state_value(mode: str, state: str) -> str:
    if mode == "home_away":
        return "home" if state == "home" else "not_home"
    if mode == "boolean":
        return "on" if state == "on" else "off"
    return state


def projected_attributes(raw: str | None, role: str, allowed: list[str]) -> str:
    try:
        source = json.loads(raw or "{}")
    except (TypeError, ValueError):
        source = {}
    projected = {key: source[key] for key in allowed if key in source}
    projected["binding_role"] = role
    return json.dumps(projected, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def metadata_id(db: sqlite3.Connection, entity_id: str) -> int | None:
    row = db.execute(
        "SELECT metadata_id FROM states_meta WHERE entity_id = ?", (entity_id,)
    ).fetchone()
    return row[0] if row else None


def ensure_metadata_id(db: sqlite3.Connection, entity_id: str) -> int:
    current = metadata_id(db, entity_id)
    if current is not None:
        return current
    return db.execute(
        "INSERT INTO states_meta (entity_id) VALUES (?) RETURNING metadata_id",
        (entity_id,),
    ).fetchone()[0]


def backfill_states(
    db: sqlite3.Connection,
    public_id: str,
    binding: dict[str, Any],
    role: str,
    apply: bool,
) -> int:
    source_metadata = metadata_id(db, binding["target_entity_id"])
    if source_metadata is None:
        return 0
    public_metadata = metadata_id(db, public_id)
    cutoff = None
    if public_metadata is not None:
        cutoff = db.execute(
            "SELECT MIN(last_updated_ts) FROM states WHERE metadata_id = ?",
            (public_metadata,),
        ).fetchone()[0]
    condition = "AND s.last_updated_ts < ?" if cutoff is not None else ""
    params: tuple[Any, ...] = (
        (source_metadata, cutoff) if cutoff is not None else (source_metadata,)
    )
    rows = db.execute(
        f"""
        SELECT s.state, s.last_changed_ts, s.last_reported_ts,
               s.last_updated_ts, s.origin_idx, a.shared_attrs
          FROM states s
          LEFT JOIN state_attributes a ON a.attributes_id = s.attributes_id
         WHERE s.metadata_id = ? {condition}
         ORDER BY s.last_updated_ts, s.state_id
        """,
        params,
    ).fetchall()
    if not apply or not rows:
        return len(rows)

    public_metadata = ensure_metadata_id(db, public_id)
    attribute_cache: dict[str, int] = {}
    previous_state_id: int | None = None
    allowed = binding.get("attributes", [])
    mode = binding.get("state_mode", "passthrough")
    for state, changed, reported, updated, origin, raw_attributes in rows:
        attributes = projected_attributes(raw_attributes, role, allowed)
        attributes_id = attribute_cache.get(attributes)
        if attributes_id is None:
            attributes_id = db.execute(
                "INSERT INTO state_attributes (shared_attrs) VALUES (?) RETURNING attributes_id",
                (attributes,),
            ).fetchone()[0]
            attribute_cache[attributes] = attributes_id
        previous_state_id = db.execute(
            """
            INSERT INTO states (
                state, last_changed_ts, last_reported_ts, last_updated_ts,
                old_state_id, attributes_id, origin_idx, metadata_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING state_id
            """,
            (
                state_value(mode, state),
                changed,
                reported,
                updated,
                previous_state_id,
                attributes_id,
                origin,
                public_metadata,
            ),
        ).fetchone()[0]
    return len(rows)


def statistic_metadata(db: sqlite3.Connection, statistic_id: str) -> tuple | None:
    return db.execute(
        """
        SELECT id, source, unit_of_measurement, unit_class,
               has_mean, has_sum, mean_type
          FROM statistics_meta WHERE statistic_id = ?
        """,
        (statistic_id,),
    ).fetchone()


def backfill_statistics(
    db: sqlite3.Connection, public_id: str, source_id: str, apply: bool
) -> tuple[int, int]:
    source_meta = statistic_metadata(db, source_id)
    if source_meta is None:
        return (0, 0)
    public_meta = statistic_metadata(db, public_id)
    if apply:
        if public_meta is None:
            public_meta_id = db.execute(
                """
                INSERT INTO statistics_meta (
                    statistic_id, source, unit_of_measurement, unit_class,
                    has_mean, has_sum, mean_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
                """,
                (public_id, *source_meta[1:]),
            ).fetchone()[0]
        else:
            public_meta_id = public_meta[0]
            db.execute(
                """
                UPDATE statistics_meta
                   SET source = ?, unit_of_measurement = ?, unit_class = ?,
                       has_mean = ?, has_sum = ?, mean_type = ?
                 WHERE id = ?
                """,
                (*source_meta[1:], public_meta_id),
            )
    else:
        public_meta_id = public_meta[0] if public_meta else None

    inserted: list[int] = []
    columns = ", ".join(STATISTIC_COLUMNS)
    placeholders = ", ".join("?" for _ in STATISTIC_COLUMNS)
    for table in ("statistics", "statistics_short_term"):
        cutoff = None
        if public_meta_id is not None:
            cutoff = db.execute(
                f"SELECT MIN(start_ts) FROM {table} WHERE metadata_id = ?",
                (public_meta_id,),
            ).fetchone()[0]
        condition = "AND start_ts < ?" if cutoff is not None else ""
        params = (source_meta[0], cutoff) if cutoff is not None else (source_meta[0],)
        rows = db.execute(
            f"SELECT {columns} FROM {table} WHERE metadata_id = ? {condition} ORDER BY start_ts",
            params,
        ).fetchall()
        if apply and rows:
            db.executemany(
                f"INSERT INTO {table} (metadata_id, {columns}) VALUES (?, {placeholders})",
                ((public_meta_id, *row) for row in rows),
            )
        inserted.append(len(rows))
    return tuple(inserted)


def main() -> None:
    args = parse_args()
    document = json.loads(Path(args.bindings).read_text(encoding="utf-8"))
    dashboard_refs = set(
        ENTITY_PATTERN.findall(Path(args.dashboard).read_text(encoding="utf-8"))
    )
    role_entities = document.get("roles", {}).get(args.role, {}).get("entities", {})
    bindings = {
        public_id: binding
        for public_id, binding in role_entities.items()
        if public_id in dashboard_refs
        and public_id.split(".", 1)[0] in HISTORY_DOMAINS
        and isinstance(binding, dict)
        and isinstance(binding.get("target_entity_id"), str)
    }

    db = sqlite3.connect(args.database)
    db.execute("PRAGMA foreign_keys = ON")
    if args.apply:
        db.execute("BEGIN IMMEDIATE")
    total_states = total_hourly = total_short = 0
    try:
        for public_id, binding in sorted(bindings.items()):
            states = backfill_states(db, public_id, binding, args.role, args.apply)
            hourly, short = backfill_statistics(
                db, public_id, binding["target_entity_id"], args.apply
            )
            total_states += states
            total_hourly += hourly
            total_short += short
            print(
                f"{public_id}: states={states} statistics={hourly} short_term={short}"
            )
        if args.apply:
            db.commit()
        print(
            f"TOTAL entities={len(bindings)} states={total_states} "
            f"statistics={total_hourly} short_term={total_short} "
            f"mode={'applied' if args.apply else 'dry-run'}"
        )
    except Exception:
        if args.apply:
            db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
