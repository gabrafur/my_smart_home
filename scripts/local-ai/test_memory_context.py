#!/usr/bin/env python3
"""Offline checks for public-memory retrieval and defensible count accounting."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from memory_context import assess_memory_routing, instruction_chain, public_memory_inventory, retrieve_topic  # noqa: E402
from telemetry import TelemetryRecorder  # noqa: E402


class MemoryContextTest(unittest.TestCase):
    def make_root(self, directory: Path) -> tuple[Path, Path]:
        root = directory / "project"
        home = directory / "home"
        (root / ".codex/memories/projeto").mkdir(parents=True)
        (root / ".codex/memories/codex-local-ai").mkdir(parents=True)
        (root / "docs").mkdir()
        home.mkdir()
        (home / "config.toml").write_text(
            "project_doc_max_bytes = 180\n[features]\nmemories = true\n[memories]\nuse_memories = true\n",
            encoding="utf-8",
        )
        (home / "AGENTS.md").write_text("global instruction\n" * 8, encoding="utf-8")
        (root / "AGENTS.md").write_text("repository instruction\n" * 12, encoding="utf-8")
        (root / "MEMORY.md").write_text("# Compat\n", encoding="utf-8")
        (root / ".codex/memories/projeto/indice.md").write_text(
            "# Índice\n\n| Assunto | Arquivo | Quando consultar |\n| --- | --- | --- |\n"
            "| Codex e Local AI | [`local`](../codex-local-ai/codex-e-local-ai.md) | RTX |\n",
            encoding="utf-8",
        )
        (root / ".codex/memories/codex-local-ai/codex-e-local-ai.md").write_text(
            "# Codex Local\n\n## Atual\nA memória pública usa Local AI na RTX.\n\n## Limitação\nNão enviar segredos.\n",
            encoding="utf-8",
        )
        (root / "docs/MEMORIA_VERSIONADA_AGENTES.md").write_text("# Contrato\n", encoding="utf-8")
        return root, home

    def test_instruction_chain_reports_only_observable_sources_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root, home = self.make_root(Path(directory))
            report = instruction_chain(root, home=home)
            self.assertEqual(report["global_instructions_tokens"], None)
            self.assertTrue(report["local_codex_memories_enabled"])
            self.assertTrue(report["estimated"])
            self.assertEqual(report["project_doc_max_bytes"], 180)
            self.assertLessEqual(report["loaded_instruction_bytes"], 180)
            self.assertTrue(any(item["truncated"] for item in report["sources"]))

    def test_public_inventory_and_index_lookup_do_not_require_private_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.make_root(Path(directory))
            inventory = public_memory_inventory(root)
            categories = {item["path"]: item["category"] for item in inventory["files"]}
            self.assertEqual(categories[".codex/memories/projeto/indice.md"], "ROUTING_ONLY")
            self.assertEqual(categories["MEMORY.md"], "REDUNDANT")
            selected = retrieve_topic(root, "local ai", "RTX")
            self.assertEqual(selected["files_found"], 1)
            self.assertEqual(selected["files"][0]["path"], ".codex/memories/codex-local-ai/codex-e-local-ai.md")
            portuguese = retrieve_topic(root, "projeto", "memoria")
            self.assertEqual(portuguese["files_found"], 1)
            self.assertEqual(portuguese["files"][0]["path"], ".codex/memories/codex-local-ai/codex-e-local-ai.md")
            all_memory = retrieve_topic(root, "all")
            self.assertEqual(all_memory["files_found"], 2)

    def test_memory_telemetry_is_idempotent_and_keeps_only_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TelemetryRecorder(path)
            recorder.startup_context({
                "global_agents_tokens": 100, "repo_agents_tokens": 80,
                "nested_agents_tokens": 0, "repo_memory_tokens": 0,
                "auto_loaded_docs_tokens": 0, "observable_startup_context_tokens": 180,
                "total_startup_context_tokens": None, "estimated": True,
            }, 900)
            decision = {
                "id": "memory-used", "timestamp": "2026-08-17T12:00:00Z", "topic": "local-ai",
                "files_found": 3, "memory_tokens_available": 900, "memory_tokens_retrieved": 800,
                "memory_tokens_sent_to_local_ai": 800, "memory_tokens_sent_to_primary_model": 120,
                "memory_tokens_avoided": 680, "decision": "MEMORY_LOCAL_AI_USED",
                "reason": "memory_compressed_locally", "prompt": "must never persist",
            }
            recorder.memory_decision(decision)
            recorder.memory_decision(decision)
            state = json.loads(path.read_text(encoding="utf-8"))
            totals = state["memory"]["totals"]
            self.assertEqual(state["schema_version"], 7)
            self.assertEqual(totals["retrieval_calls"], 1)
            self.assertEqual(totals["memory_tokens_avoided"], 680)
            self.assertEqual(totals["memory_tokens_available"], 900)
            self.assertNotIn("prompt", state["memory"]["latest_decisions"][0])
            self.assertEqual(state["memory"]["startup_context"]["observable_startup_context_tokens"], 180)

    def test_inventory_is_recomputed_without_a_summary_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.make_root(Path(directory))
            first = public_memory_inventory(root)["repository_memory_tokens_available"]
            path = root / ".codex/memories/codex-local-ai/codex-e-local-ai.md"
            path.write_text(path.read_text(encoding="utf-8") + "\nNova decisão pública.\n" * 80, encoding="utf-8")
            second = public_memory_inventory(root)["repository_memory_tokens_available"]
            self.assertGreater(second, first)

    def test_memory_overload_and_canonical_conflict_are_explicit_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "local-ai-telemetry.json"
            recorder = TelemetryRecorder(path)
            recorder.memory_decision({
                "id": "direct-large", "timestamp": "2026-08-17T12:00:00Z", "topic": "architecture",
                "files_found": 4, "memory_tokens_retrieved": 2400,
                "memory_tokens_sent_to_primary_model": 2400, "decision": "MEMORY_RETRIEVED_DIRECT",
                "reason": "canonical_source_preferred", "memory_overload": True,
                "canonical_source_conflict": True,
            })
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["memory"]["totals"]["memory_overload_incidents"], 1)
            latest = state["memory"]["latest_decisions"][0]
            self.assertTrue(latest["canonical_source_conflict"])

    def test_memory_workload_matrix(self):
        cases = [
            ("A typo pequeno", False, 0, 0, True, False, "MEMORY_RETRIEVAL_SKIPPED"),
            ("B arquitetura atual", True, 1, 500, True, False, "MEMORY_RETRIEVED_DIRECT"),
            ("C problema histórico", True, 2, 800, True, False, "MEMORY_RETRIEVED_DIRECT"),
            ("D conjunto grande", True, 5, 12_000, True, False, "MEMORY_LOCAL_AI_ELIGIBLE"),
            ("E sem histórico", False, 0, 0, True, False, "MEMORY_RETRIEVAL_SKIPPED"),
            ("F configuração conhecida", True, 1, 300, True, False, "MEMORY_RETRIEVED_DIRECT"),
            ("G memória antiga conflitante", True, 2, 700, True, True, "MEMORY_RETRIEVED_DIRECT"),
            ("H memória muito extensa", True, 4, 24_000, True, False, "MEMORY_LOCAL_AI_ELIGIBLE"),
            ("fallback sem RTX", True, 4, 24_000, False, False, "MEMORY_LOCAL_AI_UNAVAILABLE"),
        ]
        for name, required, files, tokens, available, conflict, expected in cases:
            with self.subTest(name=name):
                result = assess_memory_routing(
                    history_required=required, files_found=files, retrieved_tokens=tokens,
                    local_ai_available=available, canonical_conflict=conflict,
                )
                self.assertEqual(result["decision"], expected)
                if conflict:
                    self.assertTrue(result["canonical_source_conflict"])


if __name__ == "__main__":
    unittest.main()
