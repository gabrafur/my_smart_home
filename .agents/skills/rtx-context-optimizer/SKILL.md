---
name: rtx-context-optimizer
description: Optimize large non-sensitive documentation, repository-memory retrieval, logs, diffs, test or scanner output, and file-triage context. Use when deterministic preprocessing leaves a large, compressible body that can benefit from Local AI/RTX before the primary model receives it; do not use for secrets, final security or production decisions, migrations, destructive actions, or small/structured data that deterministic tools can resolve.
---

# Route large context through Local AI

Use deterministic discovery, filtering, parsing, and selection first. Prefer
`rg`, Git, parsers, tests, linters, type checkers, SQL, and project scripts.
Do not invoke Local AI merely to create GPU activity or telemetry.

Evaluate this routing rule on every user request after repository instructions
are loaded. This includes a non-sensitive candidate supplied in the prompt,
retrieved from a file, or produced by a tool, but never route the aggregate
prompt by size alone. The project has no `UserPromptSubmit` interceptor, so
prompt text and attachments require this explicit agent decision.

Do not check `local_ai_status` merely because a large candidate exists. Select
the smallest relevant body and apply deterministic extraction first. For
roughly 1,200 OpenAI tokens or 4,800 ordinary text characters and above,
`local_ai_route` may record the policy outcome without source content; under the
current policy it must fall back without calling `local_ai_compress_context`.
Only a future versioned promotion may restore the lazy status check and local
compression call, with at most one retry after an observed failure.

There is currently no promoted generative context-compression profile. The
restricted pivot showed that deterministic log facts were smaller than the
validated local-summary arm, so logs now use deterministic extraction and then
the primary model. The router must return every MCP compression profile to the
primary-model fallback unless later versioned evidence and routing
configuration promote it.

Residual `structured_extraction` is a separate, default-off 10% canary. It is
not a context compressor and cannot be used through this skill: production code
may invoke it only after the deterministic parser returns a residual, with its
independent feature flag and source-anchored validator.

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
result inside the orchestration call until deterministic filtering finishes.
For logs, use the repository's source-anchored fact extractor; emit the bounded
deterministic result only when it preserves every critical signal and clears its
reduction guard, otherwise emit the raw result. Do not call
`local_ai_compress_context` or create a `code-mode-orchestrator-v1` receipt
under the current unpromoted compression policy. Treat the project
`PostToolUse` hook as a complementary deterministic guardrail, not a substitute
for this decision; nested `exec_command` calls are not delivered to that hook.

# Interpret routing and telemetry precisely

Do not claim that inference ran merely because status was available, routing
was evaluated, or a route was eligible. Say the RTX was used only when
`local_ai_compress_context` succeeds with a non-empty `job_id` and
`telemetry_recorded=true`, or equivalent canonical hook metadata reports
`executed=true` and `success=true`.

Keep inference evidence separate from delivery evidence. A successful direct
MCP or CLI call proves local work, but does not prove that its result replaced
context sent to the primary model. Count operational useful reduction only when
the versioned `PostToolUse` hook performs the replacement, or when a
`code-mode-orchestrator-v1` receipt is bound to the successful MCP job, exact
input size, and bounded emitted result. Both historical delivery paths require
measured gate cost, an independent validator, and no bounded truncation. The old
`quality_gate_type=deterministic-log-anchors-v1` observations remain auditable,
but they do not authorize new generative log compression after the restricted
pivot. Retain any direct or forced job as diagnostic or provisional and assign
zero confirmed useful tokens, even if the current conversation manually uses
the result.

For the legacy route field `deterministic_preprocessing_available`, pass `true`
only when deterministic processing completely resolves the result and no LLM
interpretation remains. Deterministic collection alone does not make a large
textual result final.

Treat `OpenAI tokens avoided` as useful only after the task-specific fidelity
gate accepts the result. A rejected or discarded result is equivalent to
passing the original input onward and therefore saves zero tokens. Even an
accepted delta remains measured or explicitly estimated, requires the delivery
evidence above to become operationally confirmed, and does not prove monetary
savings.

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

Use the global `local-ai-rtx` MCP server as the canonical inference interface.
Keep `./scripts/local-ai/local-ai` for diagnostics, tests, and the metadata-only
`confirm-delivery` receipt; it must not perform a second inference. Consult
`docs/LOCAL_AI_RTX_4070.md` before changing the helper, hook, telemetry, or
Codex/RTX dashboard cards; do not broaden the restricted LAN proxy without
confirmation.

After a new clone, Codex client rebuild/update, or `.codex/hooks.json` change,
require interactive `/hooks` review in the same client and state directory
used for prompts. The `ai-bridge` CLI and the VS Code extension have separate
Codex state, so approval in one does not activate the other. For bridge prompts,
use `docker compose exec -w /workspace ai-bridge codex`. For extension prompts,
use `./scripts/local-ai/review-vscode-hooks.sh` on the host, reload the VS Code
window after approval or extension updates, and start a new conversation. Consider
`PostToolUse` enabled only when that client reports `Installed = 1` and
`Active = 1`; never automate or bypass that approval.
