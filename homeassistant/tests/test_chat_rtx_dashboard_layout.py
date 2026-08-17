"""Regression contract for the RTX dashboard's visual reading order."""

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
    def test_sections_follow_row_major_order_from_one_to_eleven(self):
        """Keep desktop sections ordered left-to-right, then top-to-bottom."""
        view = rtx_view()

        self.assertIn("    type: sections\n", view)
        self.assertIn("    max_columns: 3\n", view)
        self.assertIn("    dense_section_placement: false\n", view)
        self.assertEqual(view.count("      - type: grid\n        cards:\n"), 11)
        self.assertEqual(
            re.findall(r"^\s+title: (\d+) ·", view, re.MULTILINE),
            [str(number) for number in range(1, 12)],
        )

    def test_live_section_uses_dedicated_history_entities(self):
        """Keep presentation entities separate from numeric Recorder history."""
        view = rtx_view()

        self.assertIn("title: 2 · Atividade ao vivo", view)
        self.assertIn("entity: binary_sensor.codex_rtx_em_uso", view)
        self.assertIn("entity: sensor.codex_rtx_gpu_historico", view)
        self.assertIn("entity: sensor.codex_rtx_vram_historico", view)
        self.assertIn("entity: sensor.codex_rtx_potencia_historico", view)
