"""Regression contracts for real-time and daily RTX dashboard mappings."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = (ROOT / "packages" / "codex_usage.yaml").read_text(encoding="utf-8")
DASHBOARD = (ROOT / "dashboards" / "chat.yaml").read_text(encoding="utf-8")


class CodexRtxRealtimeConfigTest(unittest.TestCase):
    def test_health_and_current_job_follow_the_fast_live_sensor(self):
        for unique_id in (
            "codex_local_ai_status",
            "codex_rtx_4070",
            "codex_ultimo_job_local_ai",
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            block = PACKAGE[start : start + 1800]
            self.assertIn("sensor.codex_rtx_ao_vivo", block)

    def test_today_sections_use_daily_entities(self):
        today_entities = (
            "sensor.codex_reducao_de_contexto_local_ai_hoje",
            "sensor.codex_taxa_de_falhas_local_ai_hoje",
            "sensor.codex_taxa_de_delegacao_rtx_hoje",
            "sensor.codex_cobertura_ponderada_de_economia_rtx_hoje",
            "sensor.codex_tokens_potenciais_evitaveis_hoje_estimados",
            "sensor.codex_compressao_de_memoria_hoje",
        )
        for entity_id in today_entities:
            self.assertIn(f"entity: {entity_id}", DASHBOARD)

    def test_accumulated_failure_rate_remains_in_seven_day_graph(self):
        self.assertIn("entity: sensor.codex_taxa_de_falhas_local_ai", DASHBOARD)


if __name__ == "__main__":
    unittest.main()
