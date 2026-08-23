---
name: rtx-context-optimizer
description: Optimize large non-sensitive documentation, repository-memory retrieval, logs, diffs, test or scanner output, and file-triage context. Use when deterministic preprocessing leaves a large, compressible body that can benefit from Local AI/RTX before the primary model receives it; do not use for secrets, final security or production decisions, migrations, destructive actions, or small/structured data that deterministic tools can resolve.
---

# Route large context through Local AI

Use deterministic discovery, filtering, parsing, and selection first. Prefer
`rg`, Git, parsers, tests, linters, type checkers, SQL, and project scripts.
Do not invoke Local AI merely to create GPU activity or telemetry.

At the first large non-sensitive candidate, check `local_ai_status` lazily if
availability has not yet been established in the conversation. Do not run a
startup preflight. Recheck status only after an observed failure and retry a
failed local request at most once.

Select the smallest relevant body. For roughly 1,200 OpenAI tokens or 4,800
ordinary text characters and above, call `local_ai_route` with metadata before
sending the body to the primary-model context. Call
`local_ai_compress_context` only when the route is eligible and the expected
reduction is material. Use only its bounded structured result when it preserves
the facts needed for the task.

Map evidence to `task_type` as follows:

- `review-diff`: substantial Git diff;
- `summarize-log`: long logs, stack traces, or command output;
- `analyze-tests`: substantial test failures;
- `inspect-files`: bounded candidate-file or derived-inventory triage;
- `classify-error`: repeated or noisy errors;
- `summarize-document`: extensive documentation, contracts, or guides;
- `summarize-memory`: public thematic memory selected by deterministic
  retrieval from the canonical project index.

For cross-file contracts, schemas, or bilingual documentation, prefer a derived
inventory of files, fields, commands, modules, headings, and test names over
repetitive raw code. Discard a local result that omits expected requirements,
files, configuration values, or risks, and continue from deterministic
evidence.

When orchestrating shell tools through code mode, keep a potentially large raw
result inside the orchestration call until routing finishes. Do not deliberately
emit it with `text(...)` first. Treat the project `PostToolUse` hook as a
complementary guardrail, not a substitute for this decision.

# Interpret routing and telemetry precisely

Do not claim that inference ran merely because status was available, routing
was evaluated, or a route was eligible. Say the RTX was used only when
`local_ai_compress_context` succeeds with a non-empty `job_id` and
`telemetry_recorded=true`, or equivalent canonical hook metadata reports
`executed=true` and `success=true`.

For the legacy route field `deterministic_preprocessing_available`, pass `true`
only when deterministic processing completely resolves the result and no LLM
interpretation remains. Deterministic collection alone does not make a large
textual result final.

Treat `OpenAI tokens avoided` as useful only after the task-specific fidelity
gate accepts the result. A rejected or discarded result is equivalent to
passing the original input onward and therefore saves zero tokens. Even an
accepted delta remains measured or explicitly estimated and does not prove
monetary savings.

# Enforce privacy and authority boundaries

Never send `.env` content, credentials, private keys, tokens, passwords,
private runtime, or denylisted project data to Local AI. Local telemetry may
record metadata only; it must not persist prompts, source input, model output,
or secrets.

Treat Local AI output as non-authoritative. Do not delegate final architecture,
security, production, migration, destructive-operation, root-cause, or PR
approval decisions. Do not use RTX for small tasks, word lookup, already-final
structured data, dashboard updates, or production actions.

Use only the configured remote endpoint; never silently fall back to
`127.0.0.1:11434`. `LOCAL_AI_ENABLED=0` disables the route, and
`LOCAL_AI_FORCE=1` is diagnostic only and does not override suitability.

On ordinary failure, fall back to the selected primary model without changing
its model route. A machine may explicitly configure the repository's bounded
MCP recovery helper: only an invocation marked `mcp` may send Wake-on-LAN and
make at most two attempts to start the already-installed WSL/Ollama service and
reconcile the existing exact-address portproxy. This exception never installs
software, broadens firewall/listener scope, reboots a host, or authorizes manual
repair outside that reviewed helper. If both attempts fail, continue with the
primary model.

# Apply repository-specific safeguards

Use the global `local-ai-rtx` MCP server as the canonical interface. Keep
`./scripts/local-ai/local-ai` for project diagnostics and tests only. Consult
`docs/LOCAL_AI_RTX_4070.md` before changing the helper, hook, telemetry, or
Codex/RTX dashboard cards; do not broaden the restricted LAN proxy without
confirmation.

After a new clone, Codex container rebuild, or `.codex/hooks.json` change,
require interactive `/hooks` review from
`docker compose exec -w /workspace ai-bridge codex`. Consider `PostToolUse`
enabled only when it reports `Installed = 1` and `Active = 1`; never automate
or bypass that approval.
