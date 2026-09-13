#!/usr/bin/env python3
"""Report whether the Recorder retention purge queue has drained.

This is intentionally read-only.  The Node-RED retention flow uses the result
to enqueue a repack only after the entity-specific purge tasks have removed all
rows covered by the current retention cycle.
"""

from __future__ import annotations

import json
import sqlite3
import time


DATABASE_URI = "file:/config/home-assistant_v2.db?mode=ro"
CYCLE_ENTITY_ID = "input_number.recorder_retention_cycle_started_at"
TARGETS = {
    "codex_diagnostics": (
        0,
        "sm.entity_id IN ({})",
        (
            "sensor.codex_dados_de_limite",
            "sensor.codex_benchmark_rtx_alto_potencial",
            "sensor.codex_canario_extracao_estruturada",
            "sensor.codex_pivot_rtx_restrito",
            "sensor.codex_atualizacao_do_limite_em",
            "sensor.codex_esgotamento_estimado",
            "sensor.codex_proxima_atualizacao_do_limite",
            "sensor.codex_ultima_atualizacao_do_limite",
            "sensor.codex_ritmo_do_limite",
            "sensor.codex_local_ai_status",
        ),
    ),
    "vehicle_refresh": (2, "sm.entity_id IN ({})", ("sensor.vehicle_primary_refresh_coordinator",)),
    "zigbee_diagnostics": (2, "sm.entity_id IN ({})", ("sensor.zigbee_network_state", "binary_sensor.zigbee_network")),
    "raspberry_pi_health": (2, "(sm.entity_id LIKE ? OR sm.entity_id LIKE ?)", ("sensor.raspberry_pi_%", "binary_sensor.raspberry_pi_%")),
    "tuya_diagnostics": (2, "sm.entity_id IN ({})", ("sensor.tuya_devices_state", "binary_sensor.tuya_devices")),
    "internet_diagnostics": (2, "sm.entity_id IN ({})", ("sensor.internet_connection_state", "binary_sensor.internet_connection")),
}


def read_cycle_started_at(connection: sqlite3.Connection) -> float | None:
    row = connection.execute(
        """
        SELECT s.state
        FROM states AS s
        JOIN states_meta AS sm ON sm.metadata_id = s.metadata_id
        WHERE sm.entity_id = ?
        ORDER BY s.state_id DESC
        LIMIT 1
        """,
        (CYCLE_ENTITY_ID,),
    ).fetchone()
    if row is None:
        return None
    try:
        value = float(row[0])
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def database_space_metrics(connection: sqlite3.Connection) -> dict[str, int | float]:
    """Return raw SQLite allocation facts without deciding repack policy."""
    page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
    page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
    freelist_count = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
    database_bytes = page_size * page_count
    reclaimable_bytes = page_size * freelist_count
    reclaimable_percent = round((reclaimable_bytes / database_bytes) * 100, 2) if database_bytes else 0.0
    return {
        "database_bytes": database_bytes,
        "reclaimable_bytes": reclaimable_bytes,
        "reclaimable_percent": reclaimable_percent,
    }


def target_has_pending(connection: sqlite3.Connection, keep_days: int, clause: str, values: tuple[str, ...], cycle_started_at: float) -> bool:
    placeholders = ", ".join("?" for _ in values)
    entity_clause = clause.format(placeholders)
    # The service computes its cutoff when the cycle starts. Using the current
    # time here would make new rows become eligible while the purge is running
    # and could keep the readiness sensor pending forever.
    cutoff = cycle_started_at - keep_days * 24 * 60 * 60
    query = f"""
        SELECT EXISTS(
            SELECT 1
            FROM states AS s
            JOIN states_meta AS sm ON sm.metadata_id = s.metadata_id
            WHERE s.last_updated_ts < ? AND {entity_clause}
            LIMIT 1
        )
    """
    return bool(connection.execute(query, (cutoff, *values)).fetchone()[0])


def main() -> None:
    checked_at = int(time.time())
    try:
        with sqlite3.connect(DATABASE_URI, uri=True, timeout=1) as connection:
            space = database_space_metrics(connection)
            cycle_started_at = read_cycle_started_at(connection)
            if cycle_started_at is None or cycle_started_at > checked_at + 300:
                print(json.dumps({"status": "unavailable", "pending_targets": [], "checked_at": checked_at, "cycle_started_at": cycle_started_at, **space}))
                return
            pending = [
                key
                for key, (keep_days, clause, values) in TARGETS.items()
                if target_has_pending(connection, keep_days, clause, values, cycle_started_at)
            ]
        print(json.dumps({"status": "ready" if not pending else "pending", "pending_targets": pending, "checked_at": checked_at, "cycle_started_at": int(cycle_started_at), **space}))
    except sqlite3.Error as error:
        print(json.dumps({"status": "unavailable", "pending_targets": [], "checked_at": checked_at, "error": str(error)[:160]}))


if __name__ == "__main__":
    main()
