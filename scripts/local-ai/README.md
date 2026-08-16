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
(or `LOCAL_AI_CONFIG`); the current remote endpoint is
`http://192.168.0.153:11435`. A portable clone must supply its own machine-local
configuration rather than depending on this endpoint. For a temporary override,
use:

```bash
export LOCAL_AI_ENDPOINT=http://<ollama-gpu-host>:11435
```

`AGENTS.md` is recognized by both Codex and Cline, so it is the single routing
policy for this repository; a duplicate `.clinerules/` file would add context
without adding behavior.

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
2. Use local AI only for bounded summarization, classification, repetitive
   transformations, initial log/test/diff analysis, or narrowing candidate
   files.
3. Keep architecture, multi-system debugging, security, destructive changes,
   trade-offs, integration of evidence and final review with Codex/OpenAI.

Treat every local result as untrusted first-pass evidence. Feed only its JSON
output—not raw logs or diagnostics—back to Codex.
