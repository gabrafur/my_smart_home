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

Run the offline quality benchmark after the schema benchmark:

```bash
python3 scripts/local-ai/quality_ab.py \
  --model <installed-generator> \
  --quality-gate deterministic-log-anchors-v1 \
  --task summarize-log \
  --repetitions 4 \
  --output .agent-history/local-ai-quality-ab.json
```

It counts token reduction only for candidates accepted by the fidelity gate; a
discarded result is charged the full control context and saves zero. The report
uses four development and four holdout fixtures, separates the deterministic
oracle from the model gate, and reports false accepts/rejects, distributions,
confidence intervals, size bands, and task/split aggregates. It identifies
models, parameters and fixture/prompt/helper/harness hashes, and explicitly
records that it does not execute an end-to-end primary-model A/B. Full reports
are private metadata under `.agent-history/`; stdout is a sanitized summary.

For a completed Code Mode job, build the delivery-aware v6 control/treatment
report without reading prompt or output content:

```bash
python3 scripts/local-ai/quality_ab.py --delivery-job-id <job_id>
```

This mode requires a telemetry-bound `code-mode-orchestrator-v1` receipt. It
compares raw control tokens with the compressed treatment actually delivered,
while keeping final-answer quality explicitly unevaluated.

For the mixed end-to-end GPT workload, use the weighted v8 harness:

```bash
python3 scripts/local-ai/system_ab.py \
  --model gpt-5.6-terra \
  --reasoning medium \
  --output .agent-history/local-ai-system-ab-v8.json
```

It executes two paired fixtures across logs, test output, documentation, diff
review, file triage, structured extraction and explicitly RTX-ineligible work.
The router is evaluated for every treatment task and all fallback traffic stays
in the denominator. The 2026-08-24 run reported 6.4% weighted end-to-end GPT
input-token savings and 30.1% eligible-task savings, with 14/14 functional
passes in both arms. The workload weights are a declared synthetic profile,
not production-traffic telemetry.

For the 100-case benchmark of high-potential activities beyond
`summarize-log`, use the staged targets below. The complete target runs all
stages sequentially and keeps benchmark events separate from operational
telemetry:

```bash
make benchmark-local-ai-high-potential-unit
make benchmark-local-ai-high-potential-integration
make benchmark-local-ai-high-potential-simulated
make benchmark-local-ai-high-potential-dashboard
make benchmark-local-ai-high-potential-recompute
make benchmark-local-ai-high-potential-local-ai
make benchmark-local-ai-high-potential
```

The simulated target writes to `/tmp/local-ai-high-potential-simulated` and
cannot overwrite the canonical measured artifact. The recompute target upgrades
the preserved v1 evidence to schema v2 without a new RTX run.

The dataset contains 70 anonymized repository-derived fixtures and 30
deterministic synthetic fixtures, split into calibration and holdout. GPT
direct context and GPT tokens are simulated/estimated, while Local AI inference,
latency and GPU were measured by the original real target. The v2 audit records
32 critical-category occurrences in 25 unique cases and classifies ground-truth
independence as `INSUFFICIENT_EVIDENCE`; deterministic 100/100 is fixture
consistency, not an independently verified comparison. No activity has an RTX
operational advantage or production enablement. See
[`docs/LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md`](../../docs/LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md).

The quality-first successor compares the current 14B baseline with viable
current challengers per activity, using a frozen 25-case calibration split,
75-case promotion holdout, the full 100-case legacy regression suite per model,
predeclared stability repeats and a separate verifier corpus. Run the stages
sequentially with one shared run id:

```bash
make benchmark-local-ai-quality-bakeoff-unit
make benchmark-local-ai-quality-bakeoff-calibration QUALITY_BAKEOFF_RUN_ID=<uuid>
make benchmark-local-ai-quality-bakeoff-regression QUALITY_BAKEOFF_RUN_ID=<uuid>
make benchmark-local-ai-quality-bakeoff-holdout QUALITY_BAKEOFF_RUN_ID=<uuid>
make benchmark-local-ai-quality-bakeoff-verifier QUALITY_BAKEOFF_RUN_ID=<uuid>
```

The 2026-08-25 run executed 983 inferences. No challenger beat every promotion
gate in any activity, so all five activities kept their existing
`shadow`/`disabled` modes and `production_enabled=false`. The central registry
and `model_registry.py` provide fail-closed per-activity selection behind
`LOCAL_AI_QUALITY_PIPELINE_ENABLED`; invalid, disabled or unpromoted routes go
directly to GPT. `summarize-log` is outside this registry decision and remains
unchanged. See
[`docs/LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md`](../../docs/LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md).

Calibrate a proposed verifier independently before the generator A/B:

```bash
python3 scripts/local-ai/gate_calibration.py \
  --verifier-model <installed-independent-verifier> \
  --repetitions 2
```

The configured generator on the RTX 4070 remains `qwen2.5-coder:14b`. In the
2026-08-24 v4 battery, `qwen3:14b` reduced false rejections compared with
`qwen3:8b`, but both selected the same 2/16 economically useful results and the
same 13.6% offline weighted reduction, with a 0% median. Only the two
`summarize-log` observations in the 3,000–5,999-token band saved context; all
14 smaller observations saved zero. Neither model verifier was promoted. A v5
follow-up restricted to the eligible 3,000–5,999-token log band promoted the
extractive `deterministic-log-anchors-v1` validator: 8/8 accepted and useful,
zero false accepts/rejects, 94.8% median reduction, and a 94.7–94.8% clustered
95% interval. These remain offline compression results, not confirmed
operational savings. The first delivery-aware v6 observation subsequently
confirmed 3,925 useful tokens from a 4,074-token control, or 96.3%; it is one
operational paired observation, not a population estimate.

The current operational policy enables only task profiles with defensible
quality evidence. Every profile except `summarize-log` is routed as
`LOCAL_AI_NOT_BENEFICIAL`; disabled profiles remain available to the benchmark
through diagnostic-only `LOCAL_AI_FORCE=1`. `summarize-log` starts at 3,000
input tokens and uses an extractive gate. The model selects representative
routine line IDs; deterministic code replaces generated prose with exact
signal, stack/path, and selected source lines. Truncation, more than 16 critical
lines, or a non-extractive selector falls back to the raw context. This gate
uses zero model-validation tokens; other profiles still require a verifier
different from the generator.

Operational telemetry schema 19 separates gate-approved compression from
confirmed primary-context replacement. A strict useful result must be a
successful, measured, non-truncated replacement delivered either by
`PostToolUse` or by a `code-mode-orchestrator-v1` receipt bound to the exact MCP
job and source size. It must be approved by an independent validator: either a
verifier model distinct from the generator or the exact promoted log-anchor
gate. CLI, direct MCP, benchmark and legacy
jobs without delivery evidence retain diagnostic/provisional metadata but add
zero to the dashboard's confirmed savings. Aggregates are available by day,
task, generator, and generator/verifier pair. Technical failure rates use only
operational attempts; preflight failures retain the input-context denominator
because the raw context still falls back to the primary model. The dashboard
reports validated OpenAI-context delta, local verifier work, confirmed use and
the conservative net equivalent as distinct indicators because their
tokenizers are not identical.
A faithful candidate discarded because its validation cost eliminates the
minimum reduction is recorded as `insufficient_net_savings`: it counts as a gate
acceptance but saves zero and does not inflate fidelity rejections.

## On-demand endpoint recovery

A machine-private configuration may opt into the reviewed
`recover-endpoint.mjs` helper. It runs only for an invocation marked as MCP;
passive bridge health polling never wakes or mutates the GPU host. The helper
may send Wake-on-LAN and performs at most two bounded attempts to start the
already-installed WSL/Ollama service and reconcile only the configured
exact-address portproxy. It preserves strict SSH host verification and never
installs software, widens firewall scope, creates a wildcard listener, or
reboots the host. After two failures, normal primary-model fallback applies.

The recovery behavior has deterministic coverage in
`recover-endpoint.test.mjs`; private MAC, broadcast, endpoint, user, key, and
host-key values remain outside Git.

## Use

```bash
./scripts/local-ai/local-ai.sh summarize-log /tmp/application.log
git diff | ./scripts/local-ai/local-ai.sh review-diff
pytest 2>&1 | ./scripts/local-ai/local-ai.sh analyze-tests
rg -n "TODO|FIXME" src | ./scripts/local-ai/local-ai.sh inspect-files
```

The CLI default is a 4,096-token context request, while generation and fidelity
verification enforce at least 8,192 tokens. The ordinary input bound is 12,000
characters (24,000 for repository memory) and the output bound is 6,000
characters. Test output, errors and logs are filtered from the full raw body so
signal neighborhoods are retained before the character bound. Diffs, file
inventories and documents above their reliable bound are routed as not
beneficial until the caller partitions them deterministically; head/tail
truncation never counts the unseen middle as useful savings. Change a limit
explicitly only for diagnostics:

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

Treat every local result as untrusted first-pass evidence. The helper validates
task-specific anchors. Most profiles run a second fidelity check with a minimum
score of 90%. The promoted log profile instead permits only exact source
extracts and therefore has no second model call. Rejected output is not returned
as context and records zero useful token savings. For accepted output, useful
savings are net: the gross primary-context delta minus the Ollama prompt and
completion tokens consumed by that output's fidelity checks. Legacy jobs
without a separable validator count retain gross
telemetry but claim zero net savings. Feed only accepted JSON—not raw logs or
diagnostics—back to Codex.

Do not describe status or route checks as RTX usage. A successful
`local_ai_compress_context` result with a non-empty `job_id` and recorded
telemetry proves only that local inference ran. It does not prove that the
primary model consumed the result. Confirmed operational savings additionally
require canonical `PostToolUse` replacement metadata or the metadata-only Code
Mode receipt, an independent validator, measured gate cost, and no bounded
truncation. The Code Mode path finishes with `local-ai confirm-delivery`; it
records no input or output content, and the conversation auditor separately
matches the bounded envelope to the runtime MCP job and result.

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
