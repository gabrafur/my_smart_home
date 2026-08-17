"""Regression contract for locale-safe numeric presentation in dashboards."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DASHBOARDS = ROOT / "homeassistant" / "dashboards"
CODEX_PACKAGE = ROOT / "homeassistant" / "packages" / "codex_usage.yaml"
FORMATTER = ROOT / "homeassistant" / "custom_templates" / "formatting.jinja"
AGENT_RULES = ROOT / "AGENTS.md"

NUMERIC_EXPRESSION_MARKERS = (
    "age_min",
    "odometer",
    "trips | length",
    "window_days",
    "efficiency.km_per_l",
    "efficiency.estimated_",
    "efficiency.trips_",
    "efficiency.search_window_days",
    "trip.distance",
    "trip.duration_min",
    "trip.avg_speed",
    "trip.estimated_km_per_l",
    "trip.estimated_liters",
    "remaining }}",
    "attempt }}",
    "codex_limite_disponivel",
    "codex_limite_usado",
    "remaining_percent",
    "codex_atualizacao_do_limite_em",
    "input_tokens_estimados",
    "economia_esperada_tokens",
    "economia_real_tokens",
    "codex_oportunidades_rtx_perdidas_hoje",
    "potential_tokens_avoidable",
    "expected_tokens_saved",
    "duracao_s",
    "tokens_por_segundo",
    "pico_gpu_percentual",
    "pico_vram_mib",
    "tokens_contexto_",
    "reducao_contexto_percentual",
    "tokens_openai_evitados_estimados",
    "startup.get('",
    "today.get('memory_tokens_",
    "latest.get('files_found')",
    "latest.get('memory_tokens_",
)

DASHBOARD_COUNTERS = (
    "codex_tokens_totais",
    "codex_tokens_em_cache",
    "codex_tokens_de_saida",
    "codex_sessoes_monitoradas",
    "codex_chamadas_local_ai",
    "codex_chamadas_local_ai_hoje",
    "codex_chamadas_local_ai_com_sucesso",
    "codex_falhas_local_ai",
    "codex_fallbacks_local_ai_informados",
    "codex_decisoes_de_roteamento_hoje",
    "codex_tarefas_local_ai_elegiveis_hoje",
    "codex_tarefas_local_ai_elegiveis_e_disponiveis_hoje",
    "codex_rtx_usos_hoje",
    "codex_oportunidades_rtx_perdidas_hoje",
    "codex_local_ai_indisponivel_hoje",
    "codex_disponibilidade_rtx_desconhecida_hoje",
    "codex_chamadas_local_ai_desnecessarias_hoje",
    "codex_falhas_de_roteamento_local_ai_hoje",
    "codex_tokens_potenciais_evitaveis_estimados",
    "codex_tokens_potenciais_evitaveis_hoje_estimados",
    "codex_auditoria_retrospectiva_de_roteamento_rtx",
    "codex_oportunidades_rtx_perdidas_hoje_na_auditoria",
    "codex_recuperacoes_de_memoria_hoje",
    "codex_skips_de_memoria_hoje",
    "codex_sobrecargas_de_memoria_hoje",
    "codex_tokens_openai_evitados_estimados",
    "codex_tokens_openai_evitados_hoje_estimados",
    "codex_tokens_openai_evitados_semana_estimados",
    "codex_tokens_openai_evitados_mes_estimados",
)


class DashboardNumberFormattingTest(unittest.TestCase):
    def test_shared_formatter_implements_ptbr_separators(self):
        formatter = FORMATTER.read_text(encoding="utf-8")

        self.assertIn('"{:,.0f}".format', formatter)
        self.assertIn('replace(",", ".")', formatter)
        self.assertIn('replace("#", ",")', formatter)

    def test_numeric_markdown_expressions_use_shared_formatter(self):
        violations = []
        for path in sorted(DASHBOARDS.glob("*.yaml")):
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for expression in re.findall(r"\{\{(.*?)\}\}", line):
                    if any(marker in expression for marker in NUMERIC_EXPRESSION_MARKERS):
                        if "format_number_ptbr(" not in expression:
                            violations.append(f"{path.name}:{line_number}: {expression.strip()}")

        self.assertEqual(violations, [])

    def test_every_formatted_markdown_block_imports_shared_formatter(self):
        for path in sorted(DASHBOARDS.glob("*.yaml")):
            lines = path.read_text(encoding="utf-8").splitlines()
            for line_number, line in enumerate(lines):
                match = re.match(r"^(\s*)content:\s*[|>]", line)
                if not match:
                    continue

                indent = len(match.group(1))
                block = []
                for candidate in lines[line_number + 1 :]:
                    if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indent:
                        break
                    block.append(candidate)

                rendered_block = "\n".join(block)
                if "format_number_ptbr(" in rendered_block:
                    self.assertIn(
                        "{% from 'formatting.jinja' import format_number_ptbr %}",
                        rendered_block,
                        f"{path.name}:{line_number + 1}",
                    )

    def test_codex_local_activity_is_rendered_in_portuguese_without_frontend_locale(self):
        dashboard = (DASHBOARDS / "chat.yaml").read_text(encoding="utf-8")

        self.assertIn("## Última atividade local", dashboard)
        self.assertIn("agora mesmo.", dashboard)
        self.assertIn("há {{ format_number_ptbr(idade_minutos) }} minuto", dashboard)
        self.assertIn("há {{ format_number_ptbr(idade_horas) }} hora", dashboard)
        self.assertIn("timestamp_custom('%d/%m/%Y às %H:%M', true)", dashboard)
        self.assertNotIn(
            "entity: sensor.codex_ultima_metrica\n                name: Última conversa registrada nesta máquina",
            dashboard,
        )

    def test_native_dashboard_counters_keep_numeric_display_metadata(self):
        config = CODEX_PACKAGE.read_text(encoding="utf-8")

        for unique_id in DASHBOARD_COUNTERS:
            with self.subTest(unique_id=unique_id):
                start = config.index(f"unique_id: {unique_id}")
                end = config.find("\n      - name:", start)
                block = config[start : end if end >= 0 else None]
                self.assertIn("unit_of_measurement:", block)
                self.assertIn("state_class:", block)

    def test_storage_health_confirmation_documents_bounded_cache(self):
        dashboard = (DASHBOARDS / "raspberry_pi_health.yaml").read_text(encoding="utf-8")

        self.assertIn("preserva 2 GB de cache recente", dashboard)
        self.assertIn("entity_id: input_button.storage_health_manual_run", dashboard)

    def test_repository_rules_make_number_formatting_permanent(self):
        rules = AGENT_RULES.read_text(encoding="utf-8")

        self.assertIn("## Formatação numérica dos dashboards", rules)
        self.assertIn("format_number_ptbr", rules)


if __name__ == "__main__":
    unittest.main()
