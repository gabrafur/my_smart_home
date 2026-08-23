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
            "sensor.codex_taxa_de_delegacao_rtx_hoje",
            "sensor.codex_cobertura_ponderada_de_economia_rtx_hoje",
            "sensor.codex_compressao_de_memoria_hoje",
        )
        for entity_id in today_entities:
            self.assertIn(f"entity: {entity_id}", DASHBOARD)
        self.assertIn("today.get('missed_potential_tokens_avoidable', 0)", DASHBOARD)
        self.assertIn("today.get('eligible_and_available_tasks', 0)", DASHBOARD)
        self.assertIn("today.get('quality_rejected_calls', 0)", DASHBOARD)
        self.assertEqual(DASHBOARD.count("name: Descartados por qualidade"), 1)
        self.assertIn("name: Redução útil líquida", DASHBOARD)

    def test_quality_gate_cost_is_subtracted_from_useful_tokens(self):
        for unique_id, field in (
            ("codex_economia_bruta_validada_hoje", "gross_useful_context_tokens_avoided"),
            ("codex_custo_gate_validacao_resultados_hoje", "quality_validated_validation_tokens"),
            ("codex_economia_util_validada_hoje", "useful_context_tokens_avoided"),
            ("codex_economia_util_liquida_validada_hoje", "useful_context_tokens_avoided"),
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            self.assertIn(field, PACKAGE[start : start + 900])
        self.assertIn("entity: sensor.codex_custo_gate_validacao_resultados_hoje", DASHBOARD)
        self.assertIn("name: Tokens úteis líquidos", DASHBOARD)

    def test_stale_retrospective_audit_is_not_presented_as_today(self):
        self.assertNotIn("codex_auditoria_retrospectiva_de_roteamento_rtx", PACKAGE)
        self.assertNotIn("codex_oportunidades_rtx_perdidas_hoje_na_auditoria", PACKAGE)
        self.assertNotIn("get('audit')", PACKAGE)
        self.assertIn("Oportunidades realmente perdidas", DASHBOARD)
        self.assertNotIn("auditoria retrospectiva", DASHBOARD)

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
            "codex_tokens_de_oportunidades_rtx_perdidas_hoje",
            "codex_resultados_local_ai_descartados_hoje",
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

    def test_daily_failure_rate_remains_in_seven_day_graph(self):
        self.assertIn("entity: sensor.codex_taxa_de_falhas_local_ai_hoje", DASHBOARD)
        self.assertIn("Taxa média diária de falhas técnicas — últimos 7 dias", DASHBOARD)
        self.assertIn("resultados não aproveitados", DASHBOARD)

    def test_daily_savings_graph_uses_clean_quality_validated_sensor(self):
        sensor_start = PACKAGE.index("unique_id: codex_economia_util_liquida_validada_hoje")
        sensor = PACKAGE[sensor_start : sensor_start + 850]
        self.assertIn("state_class: measurement", sensor)
        self.assertIn("get('useful_context_tokens_avoided', 0)", sensor)
        self.assertIn("title: Economia útil diária — últimos 7 dias", DASHBOARD)
        self.assertIn("entity: sensor.codex_economia_util_liquida_validada_hoje", DASHBOARD)


if __name__ == "__main__":
    unittest.main()
