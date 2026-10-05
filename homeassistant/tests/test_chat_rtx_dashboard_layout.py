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
    def test_restricted_pivot_sensor_exposes_only_bounded_sections(self):
        package = CODEX_PACKAGE.read_text(encoding="utf-8")
        start = package.index("      - name: Codex Pivot RTX Restrito\n")
        end = package.index("      - name: Codex Canario Extracao Estruturada\n", start)
        sensor = package[start:end]
        for attribute in (
            "schema_version", "benchmark_run_id", "ultima_execucao", "idade_benchmark_s",
            "base_de_medicao", "decisoes", "feature_flags", "extracao_estruturada",
            "resumo_de_logs", "retrieval_reranking", "similaridade_de_erros",
        ):
            self.assertIn(f"          {attribute}:", sensor)
        self.assertNotIn("artifact_hashes", sensor)
        self.assertNotIn("results", sensor)
        self.assertNotIn("operational_calls", sensor)

    def test_structured_canary_sensor_and_card_keep_operational_data_separate(self):
        package = CODEX_PACKAGE.read_text(encoding="utf-8")
        start = package.index("      - name: Codex Canario Extracao Estruturada\n")
        end = package.index("      - name: Codex Chamadas Local AI\n", start)
        sensor = package[start:end]
        for attribute in (
            "schema_version", "decisao", "configuracao", "circuit_breaker", "metricas",
            "ultima_execucao", "idade_ultima_execucao_s", "idade_telemetria_s",
            "amostra_minima", "amostra_atual",
        ):
            self.assertIn(f"          {attribute}:", sensor)
        self.assertNotIn("raw_events", sensor)
        self.assertNotIn("validation_trace", sensor)

        view = rtx_view()
        self.assertIn("title: Fora da contagem operacional", view)
        self.assertIn("Diagnósticos e benchmarks", view)
        self.assertIn("format_number_ptbr", view)

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

    def test_sections_prioritize_current_results_quality_and_history(self):
        view = rtx_view()
        self.assertIn("    max_columns: 3", view)
        headings = re.findall(r"^            heading: (.+)$", view, re.MULTILINE)
        self.assertEqual(headings, ["Agora", "Evolução do contexto", "Resultado de hoje · UTC", "Execuções recentes", "Qualidade e aproveitamento", "Amostras da GPU", "Entenda os dados"])
        self.assertEqual(view.count("      - type: grid\n        cards:\n"), 3)
        self.assertNotIn("Waterfall", view)
        self.assertIn("não uma medição da cobrança OpenAI", view)
        self.assertIn("CPU", view)

    def test_dashboard_only_consumes_canonical_metrics(self):
        view = rtx_view()
        self.assertNotIn("sensor.codex_usage_raw", view)
        self.assertNotIn("sensor.codex_rtx_live_raw", view)
        self.assertNotIn("sensor.codex_rtx_historico_48h_raw", view)
        self.assertNotRegex(view, r"\|\s*(?:float|int)\(0\)|now\(\)|timedelta|namespace\(|\|\s*sum")
        self.assertNotRegex(view, r"\{%[^%]*(?:\s[+*/<>]\s|\s-\s)[^%]*%\}")
        self.assertIn("state_attr('sensor.rtx_painel', 'periods')", view)
        self.assertIn("state_attr('sensor.rtx_painel', 'routing')", view)
        self.assertIn("job.get('result')", view)
        self.assertNotIn("job.get('status')", view)

    def test_numbers_keep_pt_br_and_unknown_is_not_zero(self):
        view = rtx_view()
        self.assertIn("from 'formatting.jinja' import format_number_ptbr", view)
        self.assertIn("else '—'", view)
        self.assertIn("ausência de dados ou de base para a taxa", view)
        package = CODEX_PACKAGE.read_text()
        self.assertIn("      - sensor.rtx_painel\n", package)
        publisher = (CODEX_PACKAGE.parents[2] / "nodered/tools/functions/rtx-metrics-publish.js").read_text()
        self.assertIn('state_class: "measurement"', publisher)
        self.assertIn("unit_of_measurement: unit", publisher)
        self.assertNotIn("toLocaleString", publisher)

    def test_live_graphs_use_numeric_canonical_sensors(self):
        view = rtx_view()
        for sensor in ["gpu", "vram", "potencia"]:
            self.assertIn(f"entity: sensor.rtx_metricas_{sensor}", view)
        self.assertEqual(view.count("stat_types: [max]"), 3)
        self.assertIn("period: 5minute", view)
        self.assertIn("title: Últimas 48 horas", view)


if __name__ == "__main__":
    unittest.main()
