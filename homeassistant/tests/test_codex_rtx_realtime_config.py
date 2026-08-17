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
            "sensor.codex_tarefas_local_ai_elegiveis_e_disponiveis_hoje",
            "sensor.codex_compressao_de_memoria_hoje",
        )
        for entity_id in today_entities:
            self.assertIn(f"entity: {entity_id}", DASHBOARD)

    def test_retrospective_audit_is_separate_from_today_entities(self):
        audit_id = "codex_auditoria_retrospectiva_de_roteamento_rtx"
        start = PACKAGE.index(f"unique_id: {audit_id}")
        block = PACKAGE[start : start + 2800]
        self.assertIn("get('audit')", block)
        self.assertNotIn("get('today')", block)
        self.assertIn(f"entity: sensor.{audit_id}", DASHBOARD)
        self.assertIn("não entram", DASHBOARD)
        self.assertIn("totais operacionais", DASHBOARD)
        retrospective_today = "codex_oportunidades_rtx_perdidas_hoje_na_auditoria"
        start = PACKAGE.index(f"unique_id: {retrospective_today}")
        block = PACKAGE[start : start + 2200]
        self.assertIn("retrospective_today_missed_opportunities", block)
        self.assertNotIn("get('periods')", block)
        self.assertIn(f"entity: sensor.{retrospective_today}", DASHBOARD)
        self.assertIn("Perdas registradas (operacional)", DASHBOARD)

    def test_daily_routing_counters_explain_their_semantics(self):
        for unique_id in (
            "codex_decisoes_de_roteamento_hoje",
            "codex_tarefas_local_ai_elegiveis_hoje",
            "codex_tarefas_local_ai_elegiveis_e_disponiveis_hoje",
            "codex_oportunidades_rtx_perdidas_hoje",
            "codex_local_ai_indisponivel_hoje",
            "codex_disponibilidade_rtx_desconhecida_hoje",
            "codex_chamadas_local_ai_desnecessarias_hoje",
            "codex_falhas_de_roteamento_local_ai_hoje",
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            self.assertIn("significado:", PACKAGE[start : start + 1200])

    def test_unknown_availability_is_not_reported_as_confirmed_unavailability(self):
        confirmed_start = PACKAGE.index("unique_id: codex_local_ai_indisponivel_hoje")
        unknown_start = PACKAGE.index("unique_id: codex_disponibilidade_rtx_desconhecida_hoje")
        confirmed = PACKAGE[confirmed_start:unknown_start]
        unknown = PACKAGE[unknown_start:][:1400]
        self.assertIn("confirmed_unavailable_tasks", confirmed)
        self.assertNotIn("availability_unknown_tasks", confirmed)
        self.assertIn("availability_unknown_tasks", unknown)
        self.assertIn("RTX indisponível (confirmado)", DASHBOARD)
        self.assertIn("Estado RTX desconhecido", DASHBOARD)

    def test_accumulated_failure_rate_remains_in_seven_day_graph(self):
        self.assertIn("entity: sensor.codex_taxa_de_falhas_local_ai", DASHBOARD)


if __name__ == "__main__":
    unittest.main()
