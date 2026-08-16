## Model Routing, Prompt Improvement, and Cost Policy

For the first user request in a new conversation, perform only three preliminary actions:

1. suggest a concise title for the conversation;
2. improve the user's original prompt into a clearer and more actionable task specification;
3. recommend the cheapest GPT-5.6 model and reasoning level with a high probability of completing the improved task correctly.

Do not inspect the project, search files, run task-related commands, edit files, change Git, debug, research the repository, query services, execute tests, or execute the requested task before the user confirms.

Interpreting the request only to understand intent, improve the prompt, classify complexity, identify likely risks, and recommend a model is allowed.

This first-request gate applies once per conversation.

After the user confirms with `continue`, `pode continuar`, or an equivalent confirmation, proceed normally using the improved prompt as the working task specification.

If the user edits, corrects, expands, or replaces the improved prompt before confirming, use the latest user-approved version instead.

Follow-up messages in the same conversation do not restart the gate unless the user explicitly asks for another model recommendation, another prompt improvement, or starts a materially unrelated task.

Use the conversation history to avoid loops after a model switch.

---

## Prompt Improvement Policy

Rewrite the user's original request into a stronger prompt while preserving the original intent, scope, concrete details, URLs, identifiers, examples, constraints, terminology, commands, code snippets, error messages, paths, entity names, branch names, and other relevant technical context.

Improve the prompt where useful by clarifying:

* objective;
* current or observed behavior;
* desired behavior;
* investigation expectations;
* scope;
* constraints;
* acceptance criteria;
* validation steps;
* regression checks;
* safety expectations;
* reversibility or rollback expectations;
* documentation expectations;
* expected final report.

For debugging or investigation tasks, prefer an execution flow such as:

1. understand the existing implementation and architecture;
2. confirm or reproduce the reported behavior;
3. trace the relevant data or execution path;
4. identify the root cause;
5. implement the smallest reliable correction;
6. validate the correction;
7. check for regressions;
8. document findings and changes.

For implementation tasks, make the desired result and validation criteria explicit.

For infrastructure, Home Assistant, Node-RED, data engineering, CI/CD, Git, integrations, networking, containers, operating systems, or production-adjacent work, favor:

* understanding the current architecture before modifying it;
* root-cause fixes instead of symptom masking;
* reuse of existing components and conventions;
* incremental and reversible changes;
* preservation of existing behavior unless explicitly requested otherwise;
* validation after modifications;
* testing the complete affected execution path when practical;
* avoiding destructive operations when a safer alternative exists.

Do not arbitrarily expand the task.

Do not invent repository structure, filenames, entity IDs, branches, APIs, services, credentials, architecture, business rules, tools, infrastructure, or technical requirements that are not provided or reasonably implied.

Do not convert optional ideas into mandatory requirements.

When useful improvements beyond the original request are identified, keep them clearly separated as optional suggestions.

Correct technical terminology when useful without changing the user's intended meaning.

If the original request is already precise, improve it lightly instead of making it unnecessarily verbose.

The improved prompt should be detailed enough that, after confirmation, it can be treated as the execution specification without needing to reinterpret the original request.

---

## Copy-Safe Improved Prompt Output Policy

The improved prompt must be easy to copy directly from the Codex response and paste into another Codex or ChatGPT conversation without losing its Markdown structure.

Always output the complete improved prompt inside exactly one fenced code block.

The content inside that block must contain the actual Markdown source of the improved prompt, not rendered Markdown.

This means that Markdown syntax such as:

* `#` and `##` headings;
* numbered lists;
* bullet lists;
* checklists;
* indentation;
* inline code;
* paths;
* commands;
* code blocks;
* URLs;
* quoted values;

must remain visible literally inside the copyable block.

Do not use blockquotes (`>`) as the outer container for the improved prompt.

Do not split the improved prompt across multiple outer code blocks merely for presentation.

Do not put explanations, model recommendations, notes, or commentary inside the improved-prompt block unless they are intentionally part of the task specification.

Do not escape normal Markdown characters merely to make the rendered response look different.

Preserve meaningful blank lines and indentation.

### Fence safety

The outer fence used for the improved prompt must be longer than any consecutive backtick sequence contained inside the improved prompt.

Prefer four backticks for the outer fence:

````text
# Objective

Investigate the reported issue.

## Validation

Run the relevant tests.

```bash
pytest tests/
```
````

If the improved prompt itself contains a four-backtick sequence, use five backticks for the outer fence instead.

In general:

> outer fence length = longest internal backtick sequence + at least one

Use `markdown` or `text` as the outer code-block language when useful.

The content copied from the block must be immediately usable as a new chat prompt without cleanup.

### Prompt structure

For substantial engineering tasks, prefer a structure similar to:

# Objective

Describe the result that must be achieved.

# Context

Preserve relevant information supplied by the user.

# Current Behavior

Describe the observed issue when applicable.

# Desired Behavior

Describe the expected outcome.

# Investigation

Explain what should be inspected or verified before modifications.

# Implementation Requirements

Describe required changes and constraints.

# Validation

Describe tests and checks that must demonstrate correctness.

# Regression Checks

Describe existing behavior that must remain functional.

# Git / Delivery Requirements

Include branch, commit, PR, or repository requirements only when relevant or requested.

# Documentation

Describe documentation expectations when relevant.

# Final Report

Describe what the executing agent should report when finished.

Do not mechanically add every section.

Use only sections that make the task clearer.

For simple tasks, keep the improved prompt compact.

---

## Chat Title Policy

Suggest one concise title for the new conversation.

The title should:

* describe the actual task;
* normally use 3 to 8 words;
* be easy to identify later in conversation history;
* use the same language as the user's request unless there is a strong reason not to.

Prefer specific titles such as:

* `Corrigir bateria e consumo do Creta`
* `Refatorar contexto de segurança Node-RED`
* `Investigar crescimento de storage Raspberry`
* `Adicionar observabilidade ao pipeline Grow`

Avoid generic titles such as:

* `Fix issue`
* `New task`
* `Code changes`
* `Investigation`

Do not attempt to rename the conversation automatically.

The title is only a suggestion so the user can rename the Codex chat manually.

---

## Model Routing Policy

Use the cheapest option with a high probability of completing the improved task correctly, considering deterministic tools and local scripts before model escalation.

### GPT-5.6 Luna (`gpt-5.6-luna`)

Use for:

* clear and small tasks;
* localized changes;
* repetitive or mechanical work;
* easily validated transformations;
* extraction;
* simple documentation;
* small code changes;
* boilerplate;
* simple tests.

Prefer `low`.

Use `medium` for ordinary bounded work.

Use `high` only with concrete justification.

### GPT-5.6 Terra (`gpt-5.6-terra`)

Use for:

* substantial engineering;
* multi-file changes;
* debugging;
* implementation plus tests;
* refactoring;
* repository exploration;
* Git;
* CI/CD;
* infrastructure;
* integrations;
* moderate architecture;
* PR analysis.

Prefer `medium`.

Use `high` for multi-step debugging or architecture.

Use `xhigh` only for unusually difficult problems.

### GPT-5.6 Sol (`gpt-5.6-sol`)

Use for:

* materially difficult or ambiguous work;
* unresolved complex debugging;
* broad repository analysis;
* high-risk migrations;
* security-sensitive reasoning;
* complex architecture;
* multi-system root-cause investigation;
* cases where Terra has demonstrated limitations.

Prefer `medium` for substantial but clear work.

Use `high` for complex work.

Use `xhigh` for very difficult work.

Use `max` only exceptionally.

Do not select a stronger model merely because a task:

* involves code;
* has a long prompt;
* references a large repository;
* may touch many files.

For large but deterministic extraction or transformation, keep the cheapest sufficient option.

Consider deterministic tools, local scripts, and local AI/Ollama when available before Luna, Terra, or Sol.

Do not create, repair, install, restart, or reconfigure Ollama infrastructure as part of model routing.

---

## Initial Response Policy

The initial response must remain concise enough to review easily, although the improved prompt itself may be detailed when the task benefits from additional structure.

Use exactly this high-level response structure:

### SUGGESTED CHAT TITLE

`<concise suggested title>`

### IMPROVED PROMPT

Place the complete improved prompt in one copy-safe fenced block according to the `Copy-Safe Improved Prompt Output Policy`.

Example:

```markdown
# Objective

<clear objective>

# Context

<relevant context>

# Requirements

- <requirement>
- <requirement>

# Validation

- <validation step>
- <regression check>
```

### MODEL RECOMMENDATION

Model: GPT-5.6 `<Luna | Terra | Sol>`
Reasoning: `<Low | Medium | High | Extra High | Max>`
Confidence: `<High | Medium | Low>`

Reason: `<short explanation>`

Why not cheaper:
`<short explanation or "Luna is sufficient">`

Why not stronger:
`<short explanation or "Sol is not justified">`

### NEXT STEP

Tell the user to switch to the recommended model and reasoning level using `/model` or the equivalent supported UI, then reply with:

`continue`

Do not claim that the model was switched automatically.

Do not execute the requested task in this initial response.

---

## Confirmation and Continuation Policy

When the user replies with `continue`, `pode continuar`, or an equivalent confirmation, consider the initial gate complete and execute the task normally using the improved prompt as the working specification.

Do not repeat the model recommendation after confirmation.

Do not regenerate the improved prompt after confirmation unless explicitly requested.

Do not ask the user to confirm the same task again.

If the user adds requirements before confirmation, incorporate those requirements into the working specification.

A subsequent `continue` approves the latest version.

If the user pastes an edited version of the improved prompt and then confirms, the user-edited version takes precedence.

After confirmation, continue naturally from the conversation context rather than restarting the workflow.

To disable this policy for this repository, remove this section from this
`AGENTS.md` and restart new conversations.

The default model and reasoning remain independently controlled by `~/.codex/config.toml`.

---

## Local AI / RTX Context Compression Policy

After the user has selected a recommended model and explicitly confirms with `continue`, the global `UserPromptSubmit` hook runs one cheap Local AI preflight.

It records one of:

* `LOCAL_AI_AVAILABLE`
* `LOCAL_AI_DEGRADED`
* `LOCAL_AI_UNAVAILABLE`
* `LOCAL_AI_DISABLED`

for that session.

Do not run the full SSH/WSL/GPU preflight again in the same conversation unless:

* a Local AI request fails;
* it times out;
* the endpoint refuses a connection;
* the selected local model becomes unavailable.

At most once, revalidate and retry the failed local request.

After that, fall back normally without loops or repair attempts.

When available, machine-local configuration supplies the remote Ollama endpoint and default model.

Never silently use `127.0.0.1:11434` in this environment.

The configured endpoint is the only default, while explicit CLI options and `LOCAL_AI_ENDPOINT` / `LOCAL_AI_MODEL` remain overrides.

`LOCAL_AI_ENABLED=0` disables Local AI for a session.

`LOCAL_AI_FORCE=1` is diagnostic only and does not authorize unsuitable delegation.

The machine-local preflight command configured in `LOCAL_AI_CONFIG` is the
manual health check. `./scripts/local-ai/local-ai status` is the portable
repository health check.

Keep deterministic tools first, including:

* `rg`;
* Git;
* parsers;
* tests;
* linters;
* type checkers;
* SQL;
* project scripts.

Use `./scripts/local-ai/local-ai` for Local AI tasks. Use Local AI only when bounded first-pass work will materially compress a large context or cheaply classify it, such as:

* long logs or test output;
* large diffs;
* repetitive extraction;
* relevant-file triage;
* strict structured JSON generation.

### Automatic local delegation

When the Local AI preflight for the current conversation is `LOCAL_AI_AVAILABLE`,
make this routing decision automatically. Do not ask the user to enable Local AI,
repeat a special prompt, select a model, or run a helper command.

Before placing a large, non-sensitive body of text into the OpenAI/Codex context,
use `./scripts/local-ai/local-ai` to produce a bounded structured first
pass when it will reduce the context materially. Treat roughly 1,500 OpenAI
tokens (about 6,000 ordinary text characters) as the normal lower bound, unless
the content is already clearly structured and small enough to inspect directly.

Choose the helper task from the evidence at hand:

* `review-diff` for a substantial Git diff;
* `summarize-log` for long logs, stack traces, or command output;
* `analyze-tests` for substantial test failures;
* `inspect-files` for a bounded set of candidate source files;
* `classify-error` for repeated or noisy errors.

Pass only the relevant bounded input to the helper, consume its concise JSON
result, and continue the primary task from that result. Do not paste the full
raw input into the primary-model context when the local result is sufficient.
This is the default behavior for every eligible task after confirmation; it
requires no extra wording from the user.

For short requests or evidence that deterministic tools can answer directly,
skip inference. Never create dummy GPU work merely to change dashboard state.
The telemetry-backed dashboard is updated automatically whenever a local job is
actually useful and runs.

Return only concise, relevant, structured results to the selected GPT-5.6 model.

Treat Local AI as non-authoritative.

Do not delegate to Local AI:

* final architecture decisions;
* security or authentication decisions;
* secrets;
* destructive or irreversible operations;
* production decisions;
* migrations;
* final RCA;
* final PR approval.

Redact or exclude:

* credentials;
* private keys;
* tokens;
* passwords;
* unnecessary `.env` content;

before calling Local AI.

If Local AI is unavailable, keep the selected Luna/Terra/Sol routing unchanged and continue normally.

Never automatically:

* install;
* restart;
* wake;
* repair;
* reconfigure;

Local AI infrastructure.

The Local AI helper records metadata-only private telemetry when present.

It must not persist:

* prompts;
* source input;
* model output;
* secrets.

`OpenAI tokens avoided` means the measured or explicitly estimated reduction between input context processed locally and the concise result passed onward.

It is not a claim that local inference tokens equal OpenAI tokens or money saved.

--- project-doc ---

# Shared Home Assistant agent history

## Project memory

`MEMORY.md` in this repository root is the canonical long-term project-memory
entry point. Read it with this file before non-trivial work. Keep it concise,
verified against the versioned configuration and documentation, and free of
secrets or time-limited authorizations.

Prompts sent to Claude Code or Codex through Home Assistant are stored at
`.agent-history/turns.jsonl`. The directory contains private runtime data and
must never be committed.

When the user asks to review or continue a Home Assistant conversation:

1. Run `node scripts/agent-history.mjs list` to locate the conversation.
2. Run `node scripts/agent-history.mjs show <conversation_id> [claude|codex]`
   to load its transcript.
3. Use that transcript as context in the current chat. Do not reproduce secrets
   from the transcript unless the user explicitly requests them.

## Local AI routing

Prefer deterministic local tools over any LLM whenever they can answer the
question reliably: `rg`, `find`, `jq`, Git, parsers, linters, type checkers,
tests, shell, Python, SQL, and project-specific tools.

For inexpensive, well-scoped first-pass AI work, use the repository-local
Ollama helper when it is available: `./scripts/local-ai/local-ai` (or
`local-ai` after adding `scripts/local-ai` to `PATH`). Suitable tasks include
summarizing logs or test output, classifying errors, initial diff review,
repetitive transformations, and narrowing potentially relevant files. Keep its
input and JSON output bounded; pass the structured result, not raw large output,
to the primary model.

Local-model output is non-authoritative evidence. Architecture, complex
multi-system debugging, security-sensitive or destructive decisions, trade-offs,
integration of evidence, and final review remain the responsibility of the
primary Codex/OpenAI model.
