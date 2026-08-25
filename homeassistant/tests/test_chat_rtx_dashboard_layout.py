"""Regression contract for the RTX dashboard's compact priority layout."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


DASHBOARD = Path(__file__).resolve().parents[1] / "dashboards" / "chat.yaml"
CODEX_PACKAGE = Path(__file__).resolve().parents[1] / "packages" / "codex_usage.yaml"


def rtx_view() -> str:
    """Return only the RTX view so other dashboard layouts do not affect the test."""
    content = DASHBOARD.read_text(encoding="utf-8")
    start = content.index("  - title: RTX 4070\n")
    end = content.index("  - title: Assistentes\n", start)
    return content[start:end]


class RtxDashboardLayoutTest(unittest.TestCase):
    def test_quality_bakeoff_sensor_exposes_v3_evidence_without_operational_mix(self):
        package = CODEX_PACKAGE.read_text(encoding="utf-8")
        start = package.index("      - name: Codex Benchmark RTX Alto Potencial\n")
        end = package.index("      - name: Codex Chamadas Local AI\n", start)
        sensor = package[start:end]
        for attribute in (
            "schema_version", "compatibility_status", "benchmark_run_id",
            "ultima_execucao", "artefato_recalculado_em", "idade_benchmark_s",
            "total_eventos_benchmark",
            "independencia_ground_truth", "decisao_operacional", "resultados_recalculados",
            "base_de_medicao", "cenarios_adversariais", "totais", "atividades", "modelos",
            "resultados_primary", "resultados_verifier", "decisoes_promocao", "dataset",
            "hashes_artefatos", "hash_configuracao", "feature_flag_pipeline",
            "politica_summarize_log",
        ):
            self.assertIn(f"          {attribute}:", sensor)
        self.assertNotIn("operational_calls", sensor)
        self.assertNotIn("useful_context_tokens_avoided", sensor)

    def test_three_independent_columns_preserve_priority_and_fill_gaps(self):
        """Keep one continuous section per column so tall cards cannot open gaps."""
        view = rtx_view()

        self.assertIn("    type: sections\n", view)
        self.assertIn("    max_columns: 3\n", view)
        self.assertIn("    dense_section_placement: false\n", view)
        marker = "      - type: grid\n        cards:\n"
        columns = view.split(marker)[1:]
        self.assertEqual(len(columns), 3)
        self.assertEqual(
            [re.search(r"^\s+title: (.+)$", column, re.MULTILINE).group(1) for column in columns],
            [
            "Saúde da infraestrutura",
            "Atividade ao vivo",
            "Waterfall — hoje · UTC",
            ],
        )
        self.assertEqual(
            sum(len(re.findall(r"^          - type:", column, re.MULTILINE)) for column in columns),
            29,
        )
        for title in ("Atenção de roteamento — hoje", "Decisão de roteamento", "Diagnóstico da última execução", "Histórico de uso da RTX — últimas 48 horas"):
            self.assertIn(f"title: {title}", columns[0])
        for title in ("Última atividade", "Saldo líquido equivalente acumulado", "Waterfall — total preservado"):
            self.assertIn(f"title: {title}", columns[1])
        for title in ("Economia útil diária — últimos 7 dias", "Fluxo operacional diário — últimos 7 dias"):
            self.assertIn(f"title: {title}", columns[2])
        self.assertNotIn("title: Histórico de uso da RTX — últimas 48 horas", columns[2])
        history = columns[0].index("title: Histórico de uso da RTX — últimas 48 horas")
        self.assertEqual(columns[0].rfind("          - type:"), columns[0].rfind("          - type:", 0, history))
        self.assertNotIn("title: Última decisão de memória", view)
        self.assertIsNone(re.search(r"^\s+title: \d+ ·", view, re.MULTILINE))

    def test_live_section_preserves_quality_history_table_and_metric_peaks(self):
        """Keep the quality-aware job table and line charts with five-minute maxima."""
        view = rtx_view()

        self.assertIn("title: Atividade ao vivo", view)
        self.assertNotIn("entity: binary_sensor.codex_rtx_em_uso", view)
        self.assertIn("title: Histórico de uso da RTX — últimas 48 horas", view)
        self.assertIn("state_attr('sensor.codex_rtx_historico_48h_raw', 'jobs')", view)
        self.assertIn(
            "| Quando | Trabalho delegado à RTX | Aproveitamento | Tempo | Economia líquida |",
            view,
        )
        self.assertIn("{% for job in jobs -%}", view)
        self.assertIn("Modelo local: `{{ job.get('model', '—') }}`", view)
        self.assertIn("'review-diff': 'Revisão de alterações'", view)
        self.assertIn("job.get('discard_reason')", view)
        self.assertIn("🟠 Descartado: economia insuficiente", view)
        self.assertIn("🟠 Descartado: fidelidade insuficiente", view)
        self.assertLess(view.index("'🟠 Descartado: economia insuficiente' if status == 'discarded'"), view.index("'✅ Aproveitado' if status == 'success'"))
        self.assertIn("Qualidade do conteúdo: {{ quality }}", view)
        self.assertIn("mede aderência ao original, não economia", view)
        self.assertIn("já desconta o custo do gate", view)
        self.assertNotIn(
            "| Horário | Tarefa | Modelo | Resultado | Qualidade | Duração | Tokens úteis líquidos |",
            view,
        )
        self.assertLess(
            view.index("title: Diagnóstico da última execução"),
            view.index("title: Histórico de uso da RTX — últimas 48 horas"),
        )

        metric_graphs = re.findall(
            r"          - type: statistics-graph\n"
            r"            title: (GPU|VRAM|Potência) — últimas 48 horas\n"
            r"            chart_type: line\n"
            r"            period: 5minute\n"
            r"            days_to_show: 2\n"
            r"            stat_types:\n"
            r"              - max\n"
            r"            entities:\n"
            r"              - entity: (sensor\.codex_rtx_[a-z_]+_historico)",
            view,
        )
        self.assertEqual(metric_graphs, [
            ("GPU", "sensor.codex_rtx_gpu_historico"),
            ("VRAM", "sensor.codex_rtx_vram_historico"),
            ("Potência", "sensor.codex_rtx_potencia_historico"),
        ])
        self.assertLess(
            view.index("title: Waterfall — total preservado"),
            view.index("title: GPU — últimas 48 horas"),
        )

    def test_quality_rejection_is_not_duplicated_and_useful_reduction_is_explicit(self):
        view = rtx_view()

        self.assertEqual(view.count("name: Rejeitados pelo gate"), 2)
        self.assertNotIn("today.get('quality_rejected_tasks', 0)", view)
        self.assertEqual(view.count("name: Redução útil líquida"), 2)
        self.assertEqual(view.count("name: Tokens totais"), 2)
        self.assertIn("name: Aproveitamento de qualidade", view)
        self.assertEqual(view.count("name: Fiéis sem ganho líquido"), 2)
        self.assertIn("entity: sensor.codex_falhas_operacionais_local_ai_hoje", view)
        self.assertIn("'modelo_verificador'", view)

    def test_quality_bakeoff_separates_primary_verifier_decision_and_evidence(self):
        view = rtx_view()

        self.assertIn("title: Benchmark RTX — quality-first por atividade", view)
        self.assertIn("sensor.codex_benchmark_rtx_alto_potencial", view)
        for collection in ("resultados_primary", "resultados_verifier", "decisoes_promocao", "modelos", "dataset"):
            self.assertIn(collection, view)
        for field in (
            "total_cases", "local_inference_calls", "accepted_cases", "fallback_cases",
            "cases_with_critical_error", "pass_at_1", "critical_fact_recall",
            "run_to_run_consistency", "duration_p50", "vram_peak", "cpu_offload_observed",
            "critical_false_accepts", "critical_error_detection_recall", "false_reject_rate",
            "natural_primary_errors_total", "natural_primary_error_recall", "approved",
            "winner", "verifier", "operational_advantage_status", "production_enabled",
            "failed_gates", "prompt_injection_cases", "stability_cases",
        ):
            self.assertIn(field, view)
        for label in ("MEDIDO", "ESTIMADO", "NÃO TESTADO"):
            self.assertIn(label, view)
        self.assertIn("indisponível", view)
        self.assertIn("independencia_ground_truth", view)
        self.assertIn("autoria independente/manual externa não foi comprovada", view)
        self.assertIn("Primary — promotion holdout", view)
        self.assertIn("Verifier — corpus controlado + erros naturais", view)
        self.assertIn("Decisão por atividade", view)
        self.assertIn("Estas chamadas não entram nos contadores operacionais", view)
        self.assertNotIn("weighted_token_savings", view)
        self.assertIn("`summarize-log` está excluído", view)

    def test_daily_operational_flow_reconciles_quality_outcomes(self):
        view = rtx_view()

        flow_start = view.index("title: Fluxo operacional diário — últimos 7 dias")
        flow = view[flow_start:]
        self.assertIn("get('daily_series', [])", flow)
        self.assertIn("operational_failed_calls", flow)
        self.assertIn("operational_quality_rejected_calls", flow)
        self.assertIn("operational_not_beneficial_calls", flow)
        self.assertIn("operational_quality_validated_measured_calls", flow)
        self.assertIn("accepted_unmeasured", flow)
        self.assertIn("unclassified", flow)
        self.assertIn("mesmos agregados preservados", flow)
        self.assertIn("categorias zeradas", flow)
        self.assertIn("_Sem atividade operacional._", flow)
        self.assertNotIn("{{ '█' * blocks }}", flow)
        self.assertNotIn("type: statistics-graph", flow)
        self.assertNotIn("entity: sensor.codex_taxa_de_falhas_qwen_2_5_coder_14b", view)
        for stale_model in (
            "sensor.codex_taxa_de_falhas_qwen_2_5_coder_7b",
            "sensor.codex_taxa_de_falhas_qwen_3_8b",
            "sensor.codex_taxa_de_falhas_qwen_2_5_coder_1_5b",
        ):
            self.assertNotIn(f"entity: {stale_model}", view)
        self.assertIn("fiéis sem ganho", flow)
        self.assertIn("valem zero na Redução", flow)
        self.assertIn("útil líquida", flow)

    def test_savings_graph_uses_daily_quality_validated_bars(self):
        view = rtx_view()

        savings_start = view.index("title: Economia útil diária — últimos 7 dias")
        savings_end = view.index("title: Fluxo operacional diário — últimos 7 dias", savings_start)
        savings = view[savings_start:savings_end]
        self.assertIn("local.get('daily_series', [])", savings)
        self.assertIn("useful_context_tokens_avoided", savings)
        self.assertIn("{{ '█' * blocks }}{{ '░' * (20 - blocks) }}", savings)
        self.assertIn("agregados diários UTC", savings)
        self.assertIn("não dependem do histórico de uma entidade recém-criada", savings)
        self.assertNotIn("chart_type: bar", savings)
        self.assertNotIn("name: Economia útil líquida · hoje", view)
        self.assertIn("com custo mensurado e saldo positivo", view)
        self.assertIn("descartes,", view)
        self.assertIn("falhas, benchmarks e legado sem custo", view)
        self.assertIn("separável valem zero", view)
        self.assertIn("entity: sensor.codex_resultados_local_ai_validados_mensuraveis_hoje", view)
        self.assertNotIn("entity: sensor.codex_rtx_usos_hoje", view)
        self.assertIn("title: Referência controlada de qualidade", view)
        self.assertIn("title: Redução por gerador / verificador — total preservado", view)
        self.assertIn("get('model_pairs', [])", view)
        self.assertIn("2/16", view)
        self.assertIn("economia operacional confirmada desta bateria é **0**", view)
        self.assertIn("O antigo **23,2%**", view)

    def test_indicator_groups_explain_how_to_read_their_metrics(self):
        view = rtx_view()

        self.assertEqual(view.count("**Como ler:**"), 12)
        definitions = re.findall(
            r"\*\*Como ler:\*\*(.*?)(?:\n\s*\n|$)",
            view,
            re.DOTALL,
        )
        self.assertEqual(len(definitions), 12)
        for definition_text in definitions:
            self.assertNotIn("{{", definition_text)
            self.assertNotIn("{%", definition_text)
        for definition in (
            "*elegível* significa",
            "*economia esperada* é",
            "*job* é uma tentativa",
            "*contexto evitado validado* é",
            "*saldo líquido equivalente* é",
            "*aproveitado* significa",
        ):
            self.assertIn(definition, view)

    def test_memory_telemetry_is_not_mixed_with_net_operational_dashboard(self):
        view = rtx_view()

        self.assertNotIn("title: Contexto inicial e memória — hoje", view)
        self.assertNotIn("memory_tokens_avoided", view)
        self.assertNotIn("sensor.codex_contexto_inicial_observavel", view)
        self.assertNotIn("sensor.codex_ultima_decisao_de_memoria", view)
        self.assertIn("title: Waterfall — hoje · UTC", view)

    def test_accumulated_waterfall_reconciles_every_quality_stage(self):
        view = rtx_view()

        for field in (
            "totals.get('operational_failed_calls', 0)",
            "totals.get('operational_quality_rejected_calls', 0)",
            "totals.get('operational_not_beneficial_calls', 0)",
            "totals.get('operational_quality_validated_calls', 0)",
            "totals.get('operational_quality_validated_measured_calls', 0)",
            "totals.get('quality_validation_unmeasured_calls', 0)",
            "totals.get('diagnostic_calls', 0)",
        ):
            self.assertIn(field, view)
        for entity in (
            "sensor.codex_chamadas_operacionais_local_ai",
            "sensor.codex_conclusoes_operacionais_local_ai",
            "sensor.codex_falhas_operacionais_local_ai",
            "sensor.codex_resultados_operacionais_sem_classificacao_de_qualidade",
            "sensor.codex_resultados_local_ai_com_gate",
            "sensor.codex_resultados_local_ai_rejeitados_no_gate",
            "sensor.codex_resultados_local_ai_aprovados_no_gate",
            "sensor.codex_resultados_local_ai_aprovados_sem_custo_mensuravel",
            "sensor.codex_resultados_local_ai_validados_mensuraveis",
            "sensor.codex_resultados_local_ai_com_uso_nao_confirmado",
            "sensor.codex_resultados_local_ai_utilizados_pelo_modelo_principal",
            "sensor.codex_resultados_local_ai_sem_ganho_liquido",
            "sensor.codex_tokens_totais",
            "sensor.codex_contexto_tentado_local_ai",
            "sensor.codex_economia_bruta_validada",
            "sensor.codex_custo_gate_validacao_resultados",
            "sensor.codex_tokens_openai_evitados_estimados",
            "sensor.codex_reducao_de_contexto_local_ai",
        ):
            self.assertIn(f"entity: {entity}", view)
        self.assertNotIn("| Etapa | Restante |", view)
        self.assertIn("tentativas = sem falha técnica + falhas técnicas", view)
        self.assertIn("fidelidade aprovada =", view)
        self.assertIn("contexto OpenAI evitado, aprovado e entregue ao modelo principal − tokens locais", view)
        self.assertIn("entity: sensor.codex_fallbacks_local_ai_informados_hoje", view)
        self.assertNotIn("entity: sensor.codex_fallbacks_local_ai_informados\n", view)

    def test_today_and_preserved_waterfalls_use_identical_semantics(self):
        view = rtx_view()

        total_start = view.index("title: Waterfall — total preservado")
        total_end = view.index("          - type: markdown", total_start)
        today_start = view.index("title: Waterfall — hoje · UTC")
        today_end = view.index("          - type: markdown", today_start)
        total_entities = re.findall(r"entity: (sensor\.[a-z0-9_]+)", view[total_start:total_end])
        today_entities = re.findall(r"entity: (sensor\.[a-z0-9_]+)", view[today_start:today_end])

        expected_total = [
            "sensor.codex_chamadas_operacionais_local_ai",
            "sensor.codex_conclusoes_operacionais_local_ai",
            "sensor.codex_falhas_operacionais_local_ai",
            "sensor.codex_resultados_operacionais_sem_classificacao_de_qualidade",
            "sensor.codex_resultados_local_ai_com_gate",
            "sensor.codex_resultados_local_ai_rejeitados_no_gate",
            "sensor.codex_resultados_local_ai_aprovados_no_gate",
            "sensor.codex_resultados_local_ai_sem_ganho_liquido",
            "sensor.codex_resultados_local_ai_aprovados_sem_custo_mensuravel",
            "sensor.codex_resultados_local_ai_validados_mensuraveis",
            "sensor.codex_resultados_local_ai_com_uso_nao_confirmado",
            "sensor.codex_resultados_local_ai_utilizados_pelo_modelo_principal",
            "sensor.codex_tokens_totais",
            "sensor.codex_contexto_tentado_local_ai",
            "sensor.codex_economia_bruta_validada",
            "sensor.codex_custo_gate_validacao_resultados",
            "sensor.codex_tokens_openai_evitados_estimados",
            "sensor.codex_reducao_de_contexto_local_ai",
        ]
        expected_today = [f"{entity}_hoje" for entity in expected_total]
        expected_today[5] = "sensor.codex_resultados_local_ai_descartados_hoje"
        expected_today[14] = "sensor.codex_economia_bruta_validada_hoje"
        expected_today[15] = "sensor.codex_custo_gate_validacao_resultados_hoje"
        expected_today[16] = "sensor.codex_tokens_openai_evitados_hoje_estimados"
        expected_today[17] = "sensor.codex_reducao_de_contexto_local_ai_hoje"

        self.assertEqual(total_entities, expected_total)
        self.assertEqual(today_entities, expected_today)
        self.assertIn("mesmas etapas, fórmulas e unidades", view)
        self.assertIn("Nenhum deles significa economia de tokens", view)

    def test_semantic_tile_colors_distinguish_dashboard_signals(self):
        view = rtx_view()

        for color in ("blue", "cyan", "purple", "green", "amber", "red"):
            self.assertIn(f"color: {color}", view)
        self.assertRegex(view, r"name: Saldo líquido equivalente\n\s+color: green")
        self.assertRegex(view, r"name: Custo do gate nos validados\n\s+color: amber")
        self.assertRegex(view, r"name: Rejeitados pelo gate\n\s+color: red")

    def test_routing_attention_keeps_only_actionable_signals(self):
        view = rtx_view()

        for entity in (
            "sensor.codex_oportunidades_rtx_perdidas_hoje",
            "sensor.codex_local_ai_indisponivel_hoje",
            "sensor.codex_disponibilidade_rtx_desconhecida_hoje",
            "sensor.codex_falhas_de_roteamento_local_ai_hoje",
        ):
            self.assertIn(f"entity: {entity}", view)
        for contextual_entity in (
            "sensor.codex_decisoes_de_roteamento_hoje",
            "sensor.codex_tarefas_local_ai_elegiveis_hoje",
            "sensor.codex_tarefas_local_ai_elegiveis_e_disponiveis_hoje",
        ):
            self.assertNotIn(f"entity: {contextual_entity}", view)
        self.assertIn("entity: sensor.codex_disponibilidade_nas_tarefas_elegiveis_hoje", view)
        self.assertIn("name: Disponibilidade nas elegíveis", view)
        self.assertIn("**Fluxo avaliado:**", view)

        routing_start = view.index("title: Atenção de roteamento — hoje")
        routing_end = view.index("title: Decisão de roteamento", routing_start)
        routing_block = view[routing_start:routing_end]
        self.assertRegex(
            routing_block,
            r"\n          - type: markdown\n"
            r"            content: >-\n"
            r"(?:.*\n)*?\s+\*\*Fluxo avaliado:\*\*",
        )
