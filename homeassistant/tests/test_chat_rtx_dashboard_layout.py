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
            25,
        )
        for title in ("Atenção de roteamento — hoje", "Decisão de roteamento", "Diagnóstico detalhado"):
            self.assertIn(f"title: {title}", columns[0])
        for title in ("Última atividade", "Economia acumulada (estimativa)", "Totais acumulados"):
            self.assertIn(f"title: {title}", columns[1])
        for title in ("Contexto e memória — hoje", "Última decisão de memória", "Economia — últimos 7 dias"):
            self.assertIn(f"title: {title}", columns[2])
        self.assertIsNone(re.search(r"^\s+title: \d+ ·", view, re.MULTILINE))

    def test_live_section_preserves_activity_history_and_metric_peaks(self):
        """Keep binary activity history and line charts with five-minute maxima."""
        view = rtx_view()

        self.assertIn("title: Atividade ao vivo", view)
        self.assertIn(
            "          - type: history-graph\n"
            "            title: RTX em uso — últimas 48 horas\n"
            "            hours_to_show: 48\n"
            "            grid_options:\n"
            "              columns: full\n"
            "              rows: auto\n"
            "            entities:\n"
            "              - entity: binary_sensor.codex_rtx_em_uso\n"
            "                name: RTX em uso",
            view,
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
        self.assertNotIn("- mean", view)
