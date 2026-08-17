# Local AI first-pass helper

`local-ai` delegates bounded, mechanical first-pass analysis to a local Ollama
server. It is deliberately not an autonomous coding agent and never modifies
files. Its stdout is concise JSON suitable for passing to Codex; progress and
metrics go to stderr.

## Setup and health check

No model is selected until Ollama is reachable and it finds a conservative
candidate (a code model at most roughly 8.5 GB on disk). This prevents a silent
choice of a large model that may CPU-offload on a 12 GB GPU.

The command must run on the machine that can reach Ollama. In this workspace,
Codex reads its machine-local configuration from `~/.config/codex/local-ai.json`
(or `LOCAL_AI_CONFIG`). A portable clone must supply its own machine-local
configuration rather than depending on a repository endpoint. For a temporary
override, use:

```bash
export LOCAL_AI_ENDPOINT=http://<ollama-gpu-host>:11435
```

The current operational topology, security boundary, verification evidence, and
fork-reproduction steps are documented in
[`docs/LOCAL_AI_RTX_4070.md`](../../docs/LOCAL_AI_RTX_4070.md).

`AGENTS.md` is recognized by both Codex and Cline, so it is the single routing
policy for this repository. Do not mirror it into `~/.codex/AGENTS.md`, mount it
as a global Codex instruction, or duplicate it in `.clinerules/`; each would
add startup context without adding behavior.

```bash
export PATH="$PWD/scripts/local-ai:$PATH"
local-ai status
local-ai benchmark --model <installed-model>
export LOCAL_AI_MODEL=<installed-model>
```

`benchmark` runs the same four bounded cases for every candidate: a short diff,
failed-test output, file snippets and an application log. It reports schema
adherence, throughput, GPU/VRAM, processor/offload indication and host RAM;
only metadata is retained in `.agent-history/`. Run it once per candidate with
the same settings before changing `LOCAL_AI_MODEL`.

## Use

```bash
./scripts/local-ai/local-ai.sh summarize-log /tmp/application.log
git diff | ./scripts/local-ai/local-ai.sh review-diff
pytest 2>&1 | ./scripts/local-ai/local-ai.sh analyze-tests
rg -n "TODO|FIXME" src | ./scripts/local-ai/local-ai.sh inspect-files
```

The defaults are a 4,096-token context, 12,000 input characters and 6,000
output characters. Adjacent duplicate log lines are removed; oversized input
keeps its beginning and end. Change a limit explicitly when needed:

```bash
LOCAL_AI_MAX_INPUT_CHARS=24000 LOCAL_AI_OUTPUT_TOKENS=1200 local-ai summarize-log app.log
```

## Routing policy

1. Use deterministic tools first: `rg`, `find`, `jq`, `git diff`, parsers,
   linters, type checkers, tests, shell, Python, SQL, and project tools.
2. Before showing a medium or large non-sensitive log, test output, diff, error
   report or file set to Codex, classify it with the task-specific policy. It
   considers task type, estimated tokens, expected compressibility, expected
   savings, deterministic sufficiency, helper support and the latest preflight;
   size alone is insufficient.
   Deterministic sufficiency means the result is final, not merely that `rg`,
   `find`, Git, `jq`, or another deterministic collector ran. Large textual
   output that still needs interpretation may be compressed as a post-processing
   step; scalar output and already-structured JSON remain deterministic.
3. Use local AI only for bounded summarization, classification, repetitive
   transformations, initial log/test/diff analysis, or narrowing candidate
   files that clear their task-specific policy threshold.
4. Keep architecture, multi-system debugging, security, destructive changes,
   trade-offs, integration of evidence and final review with Codex/OpenAI.

Treat every local result as untrusted first-pass evidence. Feed only its JSON
output—not raw logs or diagnostics—back to Codex.

Do not describe status or route checks as RTX usage. Only a successful
`local_ai_compress_context` result with a non-empty `job_id` and recorded
telemetry, or the equivalent canonical PostToolUse replacement metadata, proves
that local inference actually ran.

`route` is metadata-only: it never contacts Ollama and never writes its input.
Use it to preview a candidate or record an explicit skip:

```bash
local-ai route summarize-log --input-chars 36000
local-ai route review-diff --input-chars 24000 --outcome skipped
local-ai route inspect-files --input-chars 80000 --deterministic-sufficient
```

The first command returns `LOCAL_AI_ELIGIBLE` without recording a pending job;
the normal helper command records the eventual `LOCAL_AI_USED` or
`LOCAL_AI_UNNECESSARY_CALL`. Terminal deterministic, small and unavailable
outcomes are recorded immediately. See
[`docs/LOCAL_AI_RTX_4070.md`](../../docs/LOCAL_AI_RTX_4070.md) for thresholds,
coverage metrics, retention and the known hook limitation.

## Repository-memory retrieval

Public, versioned repository memory is storage—not a startup prompt payload.
Use deterministic index/search first; the helper never searches private session
history or generated local Codex memories. Audit what is technically observable
at startup without invoking a model:

```bash
./scripts/local-ai/local-ai memory-audit
./scripts/local-ai/memory_context.py retrieve 'codex local ai' --query 'RTX telemetry'
```

Topic and query matching is case- and accent-insensitive. Use `projeto` (or
`all`, `project`, `repository`, or `repositório`) to select the full indexed
public corpus before applying `--query`.

For a large, non-sensitive result from the canonical index, pipe only those
selected files to the dedicated structured task:

```bash
./scripts/local-ai/memory_context.py materialize 'codex local ai' --query 'RTX telemetry' \
  | ./scripts/local-ai/local-ai summarize-memory --memory-topic 'codex-local-ai' --context-tokens 8192
```

`summarize-memory` preserves current state, decisions, constraints, known bugs,
root causes, configuration values, unresolved issues, warnings and source facts.
It follows the file-triage threshold (1,200 estimated input tokens and 700
expected saved tokens). Small focused notes should be recorded as direct, and a
no-history task as a skip, without inventing an RTX job:

```bash
local-ai memory-route readme-typo --outcome skipped
local-ai memory-route codex-local-ai --files-found 1 --retrieved-tokens 359 --outcome direct
local-ai memory-route architecture --files-found 4 --retrieved-tokens 2400 --outcome direct --canonical-conflict
```

Memory telemetry is metadata only and is separate from ordinary tool-output
compression: `memory_tokens_avoided` is the retrieved-memory input minus the
structured result sent to the primary model. The whole memory corpus is never
counted as avoided merely because it exists on disk.
