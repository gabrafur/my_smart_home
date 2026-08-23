"""Regression contract for the RTX dashboard's compact priority layout."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


DASHBOARD = Path(__file__).resolve().parents[1] / "dashboards" / "chat.yaml"


def rtx_view() -> str:
    """Return only the RTX view so other dashboard layouts do not affect the test."""
    content = DASHBOARD.read_text(encoding="utf-8")
    start = content.index("  - title: RTX 4070\n")
    end = content.index("  - title: Assistentes\n", start)
    return content[start:end]


class RtxDashboardLayoutTest(unittest.TestCase):
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
            "Resultado e qualidade — hoje",
            ],
        )
        self.assertEqual(
            sum(len(re.findall(r"^          - type:", column, re.MULTILINE)) for column in columns),
            30,
        )
        for title in ("Atenção de roteamento — hoje", "Decisão de roteamento", "Diagnóstico da última execução", "Contexto inicial e memória — hoje"):
            self.assertIn(f"title: {title}", columns[0])
        for title in ("Última atividade", "Economia acumulada (estimativa)", "Waterfall acumulado — até o resultado útil"):
            self.assertIn(f"title: {title}", columns[1])
        for title in ("Economia útil diária — últimos 7 dias", "Taxa média diária de falhas técnicas — últimos 7 dias", "RTX em uso — últimas 48 horas"):
            self.assertIn(f"title: {title}", columns[2])
        self.assertNotIn("title: Última decisão de memória", view)
        self.assertIsNone(re.search(r"^\s+title: \d+ ·", view, re.MULTILINE))

    def test_live_section_preserves_quality_history_table_and_metric_peaks(self):
        """Keep the quality-aware job table and line charts with five-minute maxima."""
        view = rtx_view()

        self.assertIn("title: Atividade ao vivo", view)
        self.assertNotIn("entity: binary_sensor.codex_rtx_em_uso", view)
        self.assertIn("title: RTX em uso — últimas 48 horas", view)
        self.assertIn("state_attr('sensor.codex_rtx_historico_48h_raw', 'jobs')", view)
        self.assertIn("Tokens úteis líquidos", view)
        self.assertLess(
            view.index("title: Taxa média diária de falhas técnicas — últimos 7 dias"),
            view.index("title: RTX em uso — últimas 48 horas"),
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
            view.index("title: Waterfall acumulado — até o resultado útil"),
            view.index("title: GPU — últimas 48 horas"),
        )

    def test_quality_rejection_is_not_duplicated_and_useful_reduction_is_explicit(self):
        view = rtx_view()

        self.assertEqual(view.count("name: Descartados por qualidade"), 1)
        self.assertNotIn("today.get('quality_rejected_tasks', 0)", view)
        self.assertIn("name: Redução útil líquida", view)
        self.assertIn("*Redução útil líquida* segue o A/B", view)

    def test_failure_graph_separates_technical_and_quality_outcomes(self):
        view = rtx_view()

        self.assertIn("entity: sensor.codex_taxa_de_falhas_local_ai_hoje", view)
        self.assertNotIn("entity: sensor.codex_taxa_de_falhas_local_ai\n", view)
        self.assertNotIn("entity: sensor.codex_taxa_de_falhas_qwen_2_5_coder_14b", view)
        for stale_model in (
            "sensor.codex_taxa_de_falhas_qwen_2_5_coder_7b",
            "sensor.codex_taxa_de_falhas_qwen_3_8b",
            "sensor.codex_taxa_de_falhas_qwen_2_5_coder_1_5b",
        ):
            self.assertNotIn(f"entity: {stale_model}", view)
        self.assertIn("resultados não aproveitados", view)
        self.assertIn("quality_rejected_calls", view)
        self.assertIn("seguindo o teste A/B", view)

    def test_savings_graph_uses_daily_quality_validated_bars(self):
        view = rtx_view()

        self.assertRegex(
            view,
            r"type: statistics-graph\n"
            r"\s+title: Economia útil diária — últimos 7 dias\n"
            r"\s+chart_type: bar\n"
            r"\s+period: day\n"
            r"\s+days_to_show: 7\n"
            r"\s+stat_types:\n"
            r"\s+- max\n"
            r"\s+entities:\n"
            r"\s+- entity: sensor\.codex_economia_util_liquida_validada_hoje",
        )
        self.assertIn("entity: sensor.codex_economia_util_liquida_validada_hoje", view)
        self.assertIn("name: Economia útil líquida · hoje", view)
        self.assertIn("cujo delta supera o custo local do gate", view)
        self.assertIn("descartes,", view)
        self.assertIn("falhas, benchmarks e legado sem custo separável valem zero", view)
        self.assertIn("entity: sensor.codex_resultados_local_ai_validados_hoje", view)
        self.assertNotIn("entity: sensor.codex_rtx_usos_hoje", view)

        self.assertRegex(
            view,
            r"type: statistics-graph\n"
            r"\s+title: Taxa média diária de falhas técnicas — últimos 7 dias\n"
            r"\s+chart_type: bar\n"
            r"\s+period: day\n"
            r"\s+days_to_show: 7\n"
            r"\s+stat_types:\n"
            r"\s+- mean\n"
            r"\s+entities:\n"
            r"\s+- entity: sensor\.codex_taxa_de_falhas_local_ai_hoje",
        )

    def test_indicator_groups_explain_how_to_read_their_metrics(self):
        view = rtx_view()

        self.assertEqual(view.count("**Como ler:**"), 14)
        definitions = re.findall(
            r"\*\*Como ler:\*\*(.*?)(?:\n\s*\n|$)",
            view,
            re.DOTALL,
        )
        self.assertEqual(len(definitions), 14)
        for definition_text in definitions:
            self.assertNotIn("{{", definition_text)
            self.assertNotIn("{%", definition_text)
        for definition in (
            "*elegível* significa",
            "*economia esperada* é",
            "*job* é uma tentativa",
            "*economia bruta* é",
            "*tokens úteis líquidos* é",
            "*startup observável* são",
            "`failed / chamadas` dentro do dia UTC",
            "*utilizado* passou pelo gate",
        ):
            self.assertIn(definition, view)

    def test_memory_section_reconciles_direct_retrievals(self):
        view = rtx_view()

        self.assertIn("today.get('retrieval_calls', 0)", view)
        self.assertIn("today.get('files_found', 0)", view)
        self.assertIn("today.get('memory_tokens_available', 0)", view)
        self.assertIn("de arquivos* soma seleções", view)
        self.assertIn("**zero contexto evitado é esperado**", view)

    def test_accumulated_waterfall_reconciles_every_quality_stage(self):
        view = rtx_view()

        for field in (
            "totals.get('failed_calls', 0)",
            "totals.get('quality_rejected_calls', 0)",
            "totals.get('quality_validated_calls', 0)",
            "totals.get('quality_validation_unmeasured_calls', 0)",
        ):
            self.assertIn(field, view)
        for entity in (
            "sensor.codex_chamadas_local_ai",
            "sensor.codex_chamadas_local_ai_com_sucesso",
            "sensor.codex_resultados_local_ai_com_gate",
            "sensor.codex_resultados_local_ai_validados",
            "sensor.codex_economia_bruta_validada",
            "sensor.codex_custo_gate_validacao_resultados",
            "sensor.codex_tokens_openai_evitados_estimados",
            "sensor.codex_reducao_de_contexto_local_ai",
        ):
            self.assertIn(f"entity: {entity}", view)
        self.assertNotIn("| Etapa | Restante |", view)
        self.assertIn("economia bruta aprovada − tokens locais", view)
        self.assertNotIn("entity: sensor.codex_fallbacks_local_ai_informados", view)

    def test_semantic_tile_colors_distinguish_dashboard_signals(self):
        view = rtx_view()

        for color in ("blue", "cyan", "purple", "green", "amber", "red"):
            self.assertIn(f"color: {color}", view)
        self.assertRegex(view, r"name: Tokens úteis líquidos\n\s+color: green")
        self.assertRegex(view, r"name: Custo do gate nos validados\n\s+color: amber")
        self.assertRegex(view, r"name: Descartados por qualidade\n\s+color: red")

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
        self.assertIn("**Disponibilidade nas elegíveis**", view)
        self.assertIn("**Fluxo avaliado:**", view)
