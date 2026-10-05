# Local AI e compressão de contexto

## Local AI / RTX context compression

Use deterministic tools first; never run Local AI pre-analysis/status at startup.
For a remaining non-sensitive, compressible candidate of roughly 1,200 tokens
or more, use `.agents/skills/rtx-context-optimizer/SKILL.md` and global MCP
`local-ai-rtx`, without routing confirmation.

Reassess every request using the smallest candidate. No generative compression
profile is promoted; MCP compression fails closed until versioned evidence and
routing promote one. For logs, use the versioned deterministic fact extractor;
fall back to raw context if fidelity or reduction fails. `PostToolUse` can
replace large Bash logs, not prompts. Nested Code Mode coverage is client-specific;
hook feedback does not prove JavaScript received reduced output. Never re-emit
raw output after an accepted reduction.

For large Node TAP suites, use `python3 scripts/local-ai/run.py -- COMMAND [ARG ...]`
with the existing resource-safe wrapper. The skill documents its lossless format.

The residual `structured_extraction` canary is not context compression. It is
off by repository defaults (`false`/`0`); only private runtime may activate its
stable 10%. It requires both flags, a supported-schema parser residual, expected
model digest, metadata telemetry, source anchors and breaker `CLOSED`; otherwise
use GPT directly without a local retry.

Never send secrets or private runtime to Local AI and never delegate final
architecture, security, production, migration, destructive-operation, RCA, or
PR approval decisions. Use only the configured endpoint; never silently use
`127.0.0.1:11434`. On failure, revalidate and retry at most once, then continue
with the selected primary model without repairing, restarting, installing, or
reconfiguring Local AI infrastructure.

Do not expose a large raw tool result before routing finishes. Claim actual RTX
use only after successful compression returns the required execution and
telemetry metadata. Local telemetry is metadata-only and must never persist
prompts, source input, model output, or secrets.

MCP/CLI success proves inference only. Historical operational claims require
`PostToolUse` replacement or a `code-mode-orchestrator-v1` receipt matching
`job_id` and input size. No new receipts while generative profiles are unpromoted.

Useful reduction requires the task-specific fidelity gate. Rejected/discarded
Local AI output falls back to original context and counts zero tokens avoided,
regardless of its size.

## Local AI do projeto

O procedimento canônico fica em
`.agents/skills/rtx-context-optimizer/SKILL.md`; não mantenha cópia em
`~/.agents/skills/`. O MCP global `local-ai-rtx` é a interface de inferência e
o runtime fixado permanece só para diagnóstico e testes.

Revise o hook interativamente após clone, instalação, reconstrução do cliente
Codex ou mudança em `.codex/hooks.json`. A confiança é específica por cliente:
aprovar pelo CLI do `ai-bridge` não ativa o hook na extensão do VS Code, nem o
inverso. Execute `/hooks` no cliente que recebe os prompts e exija
`PostToolUse` com `Installed = 1` e `Active = 1`. No bridge, use
`docker compose exec -w /workspace ai-bridge codex`. Na extensão, use
`./local-ai-integration/review-vscode-hooks.sh` no host; após aprovar ou atualizar,
execute `Developer: Reload Window` e abra uma conversa nova. Nunca automatize
nem contorne essa aprovação.

Consulte `docs/LOCAL_AI_RTX_4070.md` antes de alterar helper, hook, telemetria
ou cards Codex/RTX. A publicação LAN tem porta proxy restrita e não deve ter
seu escopo ampliado sem confirmação.
