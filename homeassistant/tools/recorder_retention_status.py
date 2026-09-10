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


def target_has_pending(connection: sqlite3.Connection, keep_days: int, clause: str, values: tuple[str, ...], now: float) -> bool:
    placeholders = ", ".join("?" for _ in values)
    entity_clause = clause.format(placeholders)
    # keep_days=0 deliberately uses the current instant: every historical row
    # is eligible, while the current state continues to be served by HA.
    cutoff = now - keep_days * 24 * 60 * 60
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
            pending = [
                key
                for key, (keep_days, clause, values) in TARGETS.items()
                if target_has_pending(connection, keep_days, clause, values, checked_at)
            ]
        print(json.dumps({"status": "ready" if not pending else "pending", "pending_targets": pending, "checked_at": checked_at}))
    except sqlite3.Error as error:
        print(json.dumps({"status": "unavailable", "pending_targets": [], "checked_at": checked_at, "error": str(error)[:160]}))


if __name__ == "__main__":
    main()
