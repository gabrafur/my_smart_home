#!/usr/bin/env python3
"""Deterministic inventory and retrieval helpers for public project memory.

The module deliberately works only with the versioned public memory graph.  It
never scans private session history, generated Codex memories, prompts, or
model output.  Token counts use ``tiktoken`` when available and otherwise a
clearly-labelled conservative character estimate.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    tomllib = None  # type: ignore[assignment]


DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024
MEMORY_DIRECT_CONTEXT_BUDGET_TOKENS = 1200
MEMORY_INDEX = Path(".codex/memories/projeto/indice.md")
MEMORY_COMPATIBILITY_INDEX = Path("MEMORY.md")
MEMORY_CONTRACT = Path("docs/MEMORIA_VERSIONADA_AGENTES.md")


@dataclass(frozen=True)
class CountedText:
    tokens: int
    method: str


def assess_memory_routing(
    *,
    history_required: bool,
    files_found: int,
    retrieved_tokens: int,
    local_ai_available: bool,
    canonical_conflict: bool = False,
) -> dict[str, Any]:
    """Classify retrieval without inference or semantic claims about relevance."""
    if not history_required:
        return {"decision": "MEMORY_RETRIEVAL_SKIPPED", "reason": "no_repository_history_required"}
    if files_found <= 0:
        return {"decision": "MEMORY_RETRIEVAL_SKIPPED", "reason": "no_relevant_public_memory_found"}
    if retrieved_tokens < MEMORY_DIRECT_CONTEXT_BUDGET_TOKENS:
        return {
            "decision": "MEMORY_RETRIEVED_DIRECT",
            "reason": "canonical_source_preferred" if canonical_conflict else "retrieved_memory_within_direct_budget",
            "canonical_source_conflict": canonical_conflict,
        }
    if not local_ai_available:
        return {"decision": "MEMORY_LOCAL_AI_UNAVAILABLE", "reason": "local_ai_unavailable"}
    return {"decision": "MEMORY_LOCAL_AI_ELIGIBLE", "reason": "large_retrieved_memory_expected_context_reduction"}


def count_tokens(text: str) -> CountedText:
    """Count with the local OpenAI tokenizer when installed; otherwise estimate."""
    try:
        import tiktoken  # type: ignore[import-not-found]

        return CountedText(len(tiktoken.get_encoding("o200k_base").encode(text)), "o200k_base")
    except (ImportError, ValueError, OSError):
        return CountedText(math.ceil(len(text) / 4), "estimated_chars_div_4")


def codex_home() -> Path:
    return Path(os.getenv("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()


def load_codex_config(home: Path | None = None) -> dict[str, Any]:
    path = (home or codex_home()) / "config.toml"
    if tomllib is None:
        return {}
    try:
        loaded = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def project_root(default: Path | None = None) -> Path:
    if default is not None:
        return default.resolve()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
            cwd=Path.cwd(),
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).resolve()
    except OSError:
        pass
    return Path(__file__).resolve().parents[2]


def _first_nonempty(candidates: list[Path]) -> Path | None:
    return next((path for path in candidates if path.is_file() and path.stat().st_size > 0), None)


def _configured_fallbacks(config: dict[str, Any]) -> list[str]:
    value = config.get("project_doc_fallback_filenames")
    return [item for item in value if isinstance(item, str) and "/" not in item] if isinstance(value, list) else []


def _project_instruction_file(directory: Path, fallbacks: list[str]) -> Path | None:
    return _first_nonempty([directory / "AGENTS.override.md", directory / "AGENTS.md", *[directory / item for item in fallbacks]])


def _bounded_text(path: Path, byte_limit: int) -> tuple[str, int]:
    raw = path.read_bytes()[:max(0, byte_limit)]
    # Discard a partial multibyte tail instead of manufacturing a character.
    text = raw.decode("utf-8", errors="ignore")
    return text, len(text.encode("utf-8"))


def instruction_chain(root: Path, cwd: Path | None = None, home: Path | None = None) -> dict[str, Any]:
    """Return the observable, size-bounded AGENTS chain without hidden context."""
    home = home or codex_home()
    config = load_codex_config(home)
    limit = int(config.get("project_doc_max_bytes") or DEFAULT_PROJECT_DOC_MAX_BYTES)
    fallback_names = _configured_fallbacks(config)
    global_file = _first_nonempty([home / "AGENTS.override.md", home / "AGENTS.md"])
    selected: list[tuple[str, Path]] = []
    if global_file:
        selected.append(("global_agents", global_file))

    current = (cwd or root).resolve()
    try:
        relative = current.relative_to(root)
        directories = [root]
        cursor = root
        for part in relative.parts:
            cursor = cursor / part
            directories.append(cursor)
    except ValueError:
        directories = [root]
    for directory in directories:
        candidate = _project_instruction_file(directory, fallback_names)
        if candidate:
            scope = "repo_agents" if directory == root else "nested_agents"
            selected.append((scope, candidate))

    used = 0
    entries: list[dict[str, Any]] = []
    counts = {"global_agents_tokens": 0, "repo_agents_tokens": 0, "nested_agents_tokens": 0}
    methods: set[str] = set()
    for scope, path in selected:
        separator = 2 if entries else 0  # Codex joins files with a blank line.
        room = max(0, limit - used - separator)
        total_bytes = path.stat().st_size
        text, included_bytes = _bounded_text(path, min(total_bytes, room))
        counted = count_tokens(text)
        methods.add(counted.method)
        entry = {
            "scope": scope,
            "path": str(path.relative_to(root)) if path.is_relative_to(root) else path.name,
            "configured_bytes": total_bytes,
            "loaded_bytes": included_bytes,
            "tokens": counted.tokens,
            "truncated": included_bytes < total_bytes,
        }
        entries.append(entry)
        counts[f"{scope}_tokens"] += counted.tokens
        used += separator + included_bytes
        if used >= limit:
            break

    local_memory = config.get("memories") if isinstance(config.get("memories"), dict) else {}
    return {
        "sources": entries,
        "project_doc_max_bytes": limit,
        "loaded_instruction_bytes": used,
        **counts,
        "repo_memory_tokens": 0,
        "auto_loaded_docs_tokens": 0,
        "global_instructions_tokens": None,
        "other_startup_context_tokens": None,
        "local_codex_memories_enabled": local_memory.get("use_memories") is True,
        "local_codex_memory_tokens": None,
        "observable_startup_context_tokens": sum(counts.values()),
        "total_startup_context_tokens": None,
        "token_count_method": next(iter(methods), "estimated_chars_div_4") if len(methods) == 1 else "mixed",
        "estimated": any(method.startswith("estimated") for method in methods),
    }


def public_memory_inventory(root: Path) -> dict[str, Any]:
    """Inventory only checked-in memory and its public human-facing contract."""
    paths = [root / MEMORY_COMPATIBILITY_INDEX, root / MEMORY_INDEX]
    memory_dir = root / ".codex/memories"
    if memory_dir.is_dir():
        paths.extend(sorted(path for path in memory_dir.rglob("*.md") if path != root / MEMORY_INDEX))
    paths.append(root / MEMORY_CONTRACT)
    entries: list[dict[str, Any]] = []
    corpus_tokens = 0
    methods: set[str] = set()
    seen: set[Path] = set()
    for path in paths:
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        text = path.read_text(encoding="utf-8")
        counted = count_tokens(text)
        methods.add(counted.method)
        relative = path.relative_to(root)
        if relative == MEMORY_INDEX:
            category, role = "ROUTING_ONLY", "canonical_retrieval_index"
        elif relative == MEMORY_COMPATIBILITY_INDEX:
            category, role = "REDUNDANT", "compatibility_index"
        elif relative == MEMORY_CONTRACT:
            category, role = "RETRIEVAL_ONLY", "human_and_agent_memory_contract"
        else:
            category, role = "RETRIEVAL_ONLY", "thematic_memory"
        entries.append({
            "path": str(relative), "bytes": len(text.encode("utf-8")), "tokens": counted.tokens,
            "category": category, "role": role,
        })
        corpus_tokens += counted.tokens
    return {
        "files": entries,
        "repository_memory_tokens_available": corpus_tokens,
        "token_count_method": next(iter(methods), "estimated_chars_div_4") if len(methods) == 1 else "mixed",
        "estimated": any(method.startswith("estimated") for method in methods),
        "excluded_private_sources": [".agent-history/", ".claude/", "non-memory .codex/ runtime state"],
    }


def _topic_entries(root: Path) -> list[tuple[str, Path]]:
    index = root / MEMORY_INDEX
    try:
        text = index.read_text(encoding="utf-8")
    except OSError:
        return []
    entries: list[tuple[str, Path]] = []
    for line in text.splitlines():
        if not line.startswith("|") or "[" not in line or "](" not in line:
            continue
        match = re.search(r"\|\s*([^|]+?)\s*\|\s*\[[^]]+\]\(([^)]+\.md)\)", line)
        if not match:
            continue
        label, target = match.groups()
        candidate = (index.parent / target).resolve()
        if candidate.is_file():
            entries.append((label.casefold(), candidate))
    return entries


def _search_key(value: str) -> str:
    """Normalize case and accents for deterministic Portuguese/English lookup."""
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def retrieve_topic(root: Path, topic: str, query: str = "") -> dict[str, Any]:
    """Select thematic memory by index labels, then narrow with a deterministic query."""
    needle = _search_key(topic).strip()
    indexed = _topic_entries(root)
    if needle in {"all", "project", "projeto", "repository", "repositorio"}:
        selected = list(indexed)
        contract = root / MEMORY_CONTRACT
        if contract.is_file():
            selected.append(("memory governance contract", contract))
    else:
        selected = [
            (label, path)
            for label, path in indexed
            if needle in _search_key(label) or needle in _search_key(path.stem)
        ]
    if not selected:
        selected = [
            (label, path)
            for label, path in indexed
            if any(token in _search_key(label) for token in needle.split() if len(token) > 2)
        ]
    query_terms = [_search_key(term) for term in re.findall(r"[\w-]{3,}", query)]
    if query_terms:
        filtered = []
        for label, path in selected:
            text = path.read_text(encoding="utf-8")
            searchable = _search_key(f"{label}\n{text}")
            if any(term in searchable for term in query_terms):
                filtered.append((label, path))
        selected = filtered
    files = []
    total_tokens = 0
    methods: set[str] = set()
    for label, path in selected:
        text = path.read_text(encoding="utf-8")
        counted = count_tokens(text)
        methods.add(counted.method)
        total_tokens += counted.tokens
        files.append({"topic": label, "path": str(path.relative_to(root)), "tokens": counted.tokens})
    return {
        "topic": topic,
        "query": query or None,
        "files": files,
        "files_found": len(files),
        "memory_tokens_retrieved": total_tokens,
        "token_count_method": next(iter(methods), "estimated_chars_div_4") if len(methods) == 1 else "mixed",
        "estimated": any(method.startswith("estimated") for method in methods),
    }


def materialize_topic(root: Path, topic: str, query: str = "") -> int:
    """Write selected public memory to stdout for a pipe into Local AI only."""
    selected = retrieve_topic(root, topic, query)
    for item in selected["files"]:
        path = root / str(item["path"])
        print(f"--- BEGIN MEMORY {item['path']} ---")
        print(path.read_text(encoding="utf-8").rstrip())
        print(f"--- END MEMORY {item['path']} ---")
    return 0


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__)
    main.add_argument("--root", type=Path, default=project_root(), help="project root; defaults to Git root")
    subs = main.add_subparsers(dest="command", required=True)
    audit = subs.add_parser("audit", help="report only observable startup context and public memory metadata")
    audit.add_argument("--cwd", type=Path, help="directory whose nested instructions should be included")
    retrieve = subs.add_parser("retrieve", help="deterministically resolve memory files from the canonical index")
    retrieve.add_argument("topic")
    retrieve.add_argument("--query", default="")
    materialize = subs.add_parser("materialize", help="write selected memory to stdout for a Local AI pipe")
    materialize.add_argument("topic")
    materialize.add_argument("--query", default="")
    return main


def main() -> int:
    args = parser().parse_args()
    root = args.root.resolve()
    if args.command == "audit":
        print(json.dumps({"startup_context": instruction_chain(root, args.cwd), "memory_corpus": public_memory_inventory(root)}, ensure_ascii=False, indent=2))
        return 0
    if args.command == "retrieve":
        print(json.dumps(retrieve_topic(root, args.topic, args.query), ensure_ascii=False, indent=2))
        return 0
    return materialize_topic(root, args.topic, args.query)


if __name__ == "__main__":
    raise SystemExit(main())
