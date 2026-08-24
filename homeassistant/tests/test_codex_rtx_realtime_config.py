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
            "sensor.codex_contexto_tentado_local_ai_hoje",
            "sensor.codex_tokens_totais_hoje",
            "sensor.codex_taxa_de_aproveitamento_do_gate_hoje",
            "sensor.codex_cobertura_do_custo_do_gate_hoje",
            "sensor.codex_cobertura_da_classificacao_operacional_hoje",
            "sensor.codex_taxa_de_uso_efetivo_local_ai_hoje",
            "sensor.codex_cobertura_da_confirmacao_de_uso_hoje",
            "sensor.codex_fallbacks_local_ai_informados_hoje",
        )
        for entity_id in today_entities:
            self.assertIn(f"entity: {entity_id}", DASHBOARD)
        self.assertIn("entity: sensor.codex_tokens_de_oportunidades_rtx_perdidas_hoje", DASHBOARD)
        self.assertIn("entity: sensor.codex_disponibilidade_nas_tarefas_elegiveis_hoje", DASHBOARD)
        self.assertIn("today.get('operational_quality_rejected_calls', 0)", DASHBOARD)
        self.assertEqual(DASHBOARD.count("name: Rejeitados pelo gate"), 2)
        self.assertEqual(DASHBOARD.count("name: Redução útil líquida"), 2)
        self.assertEqual(
            DASHBOARD.count("entity: sensor.codex_tokens_totais\n"),
            2,
        )
        self.assertEqual(
            DASHBOARD.count("entity: sensor.codex_tokens_totais_hoje\n"),
            1,
        )
        self.assertIn("today.get('rtx_delegation_rate_percent', 0)", DASHBOARD)
        self.assertIn("today.get('weighted_context_savings_coverage_percent', 0)", DASHBOARD)

    def test_quality_gate_cost_is_subtracted_from_useful_tokens(self):
        for unique_id, field in (
            ("codex_economia_bruta_validada_hoje", "confirmed_gross_useful_context_tokens_avoided"),
            ("codex_custo_gate_validacao_resultados_hoje", "confirmed_quality_validation_tokens"),
            ("codex_economia_util_validada_hoje", "confirmed_useful_context_tokens_avoided"),
            ("codex_economia_util_liquida_validada_hoje", "confirmed_useful_context_tokens_avoided"),
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            self.assertIn(field, PACKAGE[start : start + 900])
        self.assertIn("entity: sensor.codex_custo_gate_validacao_resultados_hoje", DASHBOARD)
        self.assertIn("name: Saldo líquido equivalente", DASHBOARD)
        self.assertIn("name: Contexto tentado", DASHBOARD)
        self.assertIn("name: Tokens totais", DASHBOARD)

    def test_useful_reduction_uses_counterfactual_total_for_each_period(self):
        total_start = PACKAGE.index("unique_id: codex_reducao_de_contexto_local_ai\n")
        total_block = PACKAGE[total_start : total_start + 1000]
        self.assertIn("get('total_tokens', 0)", total_block)
        self.assertIn("confirmed_useful_context_tokens_avoided", total_block)
        self.assertIn("baseline_tokens = total_tokens + useful_tokens", total_block)
        self.assertIn("useful_tokens / baseline_tokens", total_block)
        self.assertNotIn("suggested_display_precision", total_block)
        self.assertIn("round(4)", total_block)
        self.assertNotIn("attempted_context_input_tokens", total_block)

        today_start = PACKAGE.index("unique_id: codex_reducao_de_contexto_local_ai_hoje")
        today_block = PACKAGE[today_start : today_start + 1000]
        self.assertIn("sensor.codex_tokens_totais_hoje", today_block)
        self.assertIn("confirmed_useful_context_tokens_avoided", today_block)
        self.assertIn("baseline_tokens = total_tokens + useful_tokens", today_block)
        self.assertIn("useful_tokens / baseline_tokens", today_block)
        self.assertNotIn("suggested_display_precision", today_block)
        self.assertIn("round(4)", today_block)
        self.assertNotIn("attempted_context_input_tokens", today_block)

    def test_empty_primary_usage_percentages_render_as_zero(self):
        for unique_id, field in (
            ("codex_taxa_de_uso_efetivo_local_ai_hoje", "primary_context_use_rate_percent"),
            ("codex_cobertura_da_confirmacao_de_uso_hoje", "primary_context_usage_coverage_percent"),
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            block = PACKAGE[start : start + 800]
            self.assertIn(f"get('{field}') | float(0)", block)
            self.assertIn("states('sensor.codex_usage_raw') == 'ok'", block)

    def test_accumulated_waterfall_exposes_every_reconciliation_branch(self):
        expected_fields = {
            "codex_falhas_operacionais_local_ai": "operational_failed_calls",
            "codex_resultados_operacionais_sem_classificacao_de_qualidade": "completed - gated",
            "codex_resultados_local_ai_rejeitados_no_gate": "operational_quality_rejected_calls",
            "codex_resultados_local_ai_aprovados_sem_custo_mensuravel": "operational_quality_validated_measured_calls",
        }
        for unique_id, expression in expected_fields.items():
            start = PACKAGE.index(f"unique_id: {unique_id}")
            end = PACKAGE.find("\n      - name:", start)
            self.assertIn(expression, PACKAGE[start:end])

        self.assertIn("**Conferência atual:**", DASHBOARD)
        self.assertIn("Sem classificação de qualidade", DASHBOARD)
        self.assertIn("Aprovados sem custo mensurável", DASHBOARD)

    def test_today_waterfall_has_daily_equivalents_for_accumulated_stages(self):
        expected_fields = {
            "codex_conclusoes_operacionais_local_ai_hoje": "operational_failed_calls",
            "codex_resultados_local_ai_com_gate_hoje": "operational_quality_rejected_calls",
            "codex_resultados_operacionais_sem_classificacao_de_qualidade_hoje": "completed - gated",
            "codex_resultados_local_ai_aprovados_no_gate_hoje": "operational_not_beneficial_calls",
            "codex_resultados_local_ai_aprovados_sem_custo_mensuravel_hoje": "operational_quality_validated_measured_calls",
            "codex_contexto_tentado_local_ai": "attempted_context_input_tokens",
        }
        for unique_id, expression in expected_fields.items():
            start = PACKAGE.index(f"unique_id: {unique_id}")
            end = PACKAGE.find("\n      - name:", start)
            self.assertIn(expression, PACKAGE[start:end])

        self.assertIn("title: Waterfall — hoje · UTC", DASHBOARD)
        self.assertIn("title: Waterfall — total preservado", DASHBOARD)
        self.assertIn("title: Diagnóstico do gate — hoje · UTC", DASHBOARD)

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
            "codex_disponibilidade_nas_tarefas_elegiveis_hoje",
            "codex_oportunidades_rtx_perdidas_hoje",
            "codex_local_ai_indisponivel_hoje",
            "codex_disponibilidade_rtx_desconhecida_hoje",
            "codex_chamadas_local_ai_desnecessarias_hoje",
            "codex_falhas_de_roteamento_local_ai_hoje",
            "codex_tokens_de_oportunidades_rtx_perdidas_hoje",
            "codex_resultados_local_ai_descartados_hoje",
            "codex_resultados_local_ai_sem_ganho_liquido_hoje",
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            self.assertIn("significado:", PACKAGE[start : start + 1200])

    def test_routing_attention_values_use_native_tiles_without_losing_data(self):
        for entity_id in (
            "sensor.codex_tokens_de_oportunidades_rtx_perdidas_hoje",
            "sensor.codex_disponibilidade_nas_tarefas_elegiveis_hoje",
        ):
            entity = f"entity: {entity_id}"
            start = DASHBOARD.index(entity)
            self.assertIn("type: tile", DASHBOARD[max(0, start - 80) : start])

        start = PACKAGE.index("unique_id: codex_disponibilidade_nas_tarefas_elegiveis_hoje")
        block = PACKAGE[start : start + 1200]
        self.assertIn("eligible_tasks", block)
        self.assertIn("eligible_and_available_tasks", block)
        self.assertIn("available / eligible * 100", block)
        self.assertIn("round(1)", block)

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

    def test_daily_operational_flow_uses_preserved_reconciled_series(self):
        self.assertIn("title: Fluxo operacional diário — últimos 7 dias", DASHBOARD)
        self.assertIn("operational_quality_validated_measured_calls", DASHBOARD)
        self.assertIn("mesmos agregados preservados", DASHBOARD)
        self.assertNotIn("title: Taxa média diária de falhas técnicas — últimos 7 dias", DASHBOARD)

    def test_latest_job_exposes_distinct_discard_reason(self):
        sensor_start = PACKAGE.index("unique_id: codex_ultimo_job_local_ai")
        sensor = PACKAGE[sensor_start : sensor_start + 8_000]
        self.assertIn("motivo_descarte:", sensor)
        self.assertIn("get('discard_reason')", sensor)
        self.assertIn("descartada por não gerar ganho líquido suficiente", DASHBOARD)
        self.assertIn("descartada pelo gate de fidelidade", DASHBOARD)

    def test_latest_job_identifies_the_confirmed_delivery_transport(self):
        sensor_start = PACKAGE.index("unique_id: codex_ultimo_job_local_ai")
        sensor = PACKAGE[sensor_start : sensor_start + 8_000]
        self.assertIn("transporte_entrega:", sensor)
        self.assertIn("get('delivery_transport')", sensor)
        self.assertIn("code-mode-orchestrator-v1", DASHBOARD)
        self.assertIn("entrega **", DASHBOARD)

    def test_daily_savings_uses_preserved_quality_validated_series(self):
        sensor_start = PACKAGE.index("unique_id: codex_economia_util_liquida_validada_hoje")
        sensor = PACKAGE[sensor_start : sensor_start + 850]
        self.assertIn("state_class: measurement", sensor)
        self.assertIn("get('confirmed_useful_context_tokens_avoided', 0)", sensor)
        self.assertIn("title: Economia útil diária — últimos 7 dias", DASHBOARD)
        self.assertIn("local.get('daily_series', [])", DASHBOARD)
        self.assertIn("agregados diários UTC", DASHBOARD)

    def test_confirmed_use_and_fallback_diagnostics_are_explicit(self):
        for unique_id, field in (
            ("codex_resultados_local_ai_utilizados_pelo_modelo_principal", "operational_primary_context_used_calls"),
            ("codex_resultados_local_ai_com_uso_nao_confirmado", "operational_primary_context_unconfirmed_calls"),
            ("codex_fallbacks_local_ai_informados_hoje", "fallbacks_reported"),
        ):
            start = PACKAGE.index(f"unique_id: {unique_id}")
            self.assertIn(field, PACKAGE[start : start + 900])
        self.assertIn("uso pelo modelo principal não confirmado", DASHBOARD)
        self.assertIn("Fallbacks informados", DASHBOARD)


if __name__ == "__main__":
    unittest.main()
