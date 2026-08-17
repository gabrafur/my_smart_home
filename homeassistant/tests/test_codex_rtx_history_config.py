"""Regression contracts for useful, bounded RTX history in Home Assistant."""

from __future__ import annotations

import unittest
from pathlib import Path


PACKAGE = Path(__file__).resolve().parents[1] / "packages" / "codex_usage.yaml"


class CodexRtxHistoryConfigTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = PACKAGE.read_text(encoding="utf-8")

    def test_live_presentation_entities_are_excluded_from_recorder(self):
        for entity_id in (
            "sensor.codex_rtx_ao_vivo",
            "sensor.codex_rtx_gpu_agora",
            "sensor.codex_rtx_vram_agora",
            "sensor.codex_rtx_potencia_agora",
        ):
            self.assertIn(f"      - {entity_id}\n", self.config)

    def test_live_polling_does_not_overlap_the_normal_helper_window(self):
        start = self.config.index("unique_id: codex_rtx_live_raw")
        block = self.config[start : start + 500]
        self.assertIn("command_timeout: 3", block)
        self.assertIn("scan_interval: 2", block)

    def test_history_entities_have_stable_numeric_contracts(self):
        for unique_id in (
            "codex_rtx_gpu_historico",
            "codex_rtx_vram_historico",
            "codex_rtx_potencia_historico",
        ):
            start = self.config.index(f"unique_id: {unique_id}")
            end = self.config.find("\n      - name:", start)
            block = self.config[start:end]
            self.assertIn("state_class: measurement", block)
            self.assertIn("else 0", block)
            self.assertNotIn("availability:", block)

    def test_signal_and_usage_have_a_five_second_grace_period(self):
        for unique_id in ("codex_rtx_sinal_estavel", "codex_rtx_em_uso"):
            start = self.config.index(f"unique_id: {unique_id}")
            block = self.config[start : start + 500]
            self.assertIn("delay_off:", block)
            self.assertIn("seconds: 5", block)


if __name__ == "__main__":
    unittest.main()
