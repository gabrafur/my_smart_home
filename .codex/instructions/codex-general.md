# Políticas gerais do Codex

## Prompt processing and model routing

Execute each user request directly. Do not require an initial confirmation or automatically rewrite the prompt.

## Prompt improvement

Do not rewrite prompts automatically. When the user explicitly asks to improve,
rewrite, structure, or make a prompt copy-safe, use the repository skill
`.agents/skills/prompt-improver/SKILL.md`. Preserve the request's intent, scope,
constraints, technical context, and optionality.

## Chat Title Policy

Only when explicitly asked, suggest one specific, easy-to-find title of normally
3 to 8 words in the user's language. Describe the actual task; avoid generic
titles such as `Fix issue` or `New task`. Never rename the conversation; the
title is only a suggestion for the user.

## Model Routing Policy

Use the cheapest option with a high probability of completing the task correctly, considering deterministic tools and local scripts before model escalation.

### GPT-5.6 Luna (`gpt-5.6-luna`)

Use for clear, small or localized changes, mechanical or easily validated
transformations, extraction, simple documentation, boilerplate and tests.
Prefer `low`; use `medium` for ordinary bounded work and `high` only with
concrete justification.

### GPT-5.6 Terra (`gpt-5.6-terra`)

Use for substantial or multi-file engineering, debugging, implementation plus
tests, refactoring, repository/Git/CI work, infrastructure, integrations,
moderate architecture and PR analysis. Prefer `medium`; use `high` for
multi-step debugging or architecture and `xhigh` only when unusually difficult.

### GPT-5.6 Sol (`gpt-5.6-sol`)

Use for materially difficult or ambiguous work, unresolved complex debugging,
broad analysis, high-risk migrations, security-sensitive reasoning, complex
architecture, multi-system RCA or demonstrated Terra limitations. Prefer
`medium` for substantial but clear work, `high` for complex work, `xhigh` for
very difficult work and `max` only exceptionally.

Do not select a stronger model merely because a task involves code, a long
prompt, a large repository or many files.

For large but deterministic extraction or transformation, keep the cheapest sufficient option.

Consider deterministic tools, local scripts, and local AI/Ollama when available before Luna, Terra, or Sol.

Do not create, repair, install, restart, or reconfigure Ollama infrastructure as part of model routing.

The pinned `local-ai-rtx` `recover-endpoint.mjs` is the only exception. If
machine-private configuration enables it, an MCP invocation may send
Wake-on-LAN and perform at most two idempotent attempts to start the existing
WSL/Ollama service and reconcile the exact configured `11435` portproxy. It
must preserve strict SSH host verification and the existing firewall scope;
it never installs software, binds a wildcard listener, reboots the host or
runs for passive dashboard health polling. After two failures, use the normal
OpenAI fallback. Do not reproduce these recovery mutations manually as part of
ordinary model routing.

## Confirmation and Continuation Policy

Do not impose an initial confirmation gate. Treat `continue` as ordinary user input unless confirmation is independently needed for a risky action.

## Commit message policy

Use Conventional Commits in English for every commit created by Codex, following
the style of `fix: make Codex card loading deterministic`:

```text
<type>[(optional-scope)][!]: <imperative description>
```

- Use one of `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`,
  `perf`, or `revert`.
- Start the description with a lowercase word, use the imperative mood, keep the
  complete subject to at most 72 characters, and do not end it with punctuation.
- Add a lowercase scope only when it makes the affected subsystem materially
  clearer. Use `!` and a `BREAKING CHANGE:` footer for breaking changes.
- Keep the subject focused on one change. Put motivation, migration notes, and
  verification details in the body when they are useful.
- Before committing, run `node scripts/commit-message-check.mjs --subject
  '<subject>'`. After committing, `make validate-commit-message` validates
  `HEAD` and `make validate-public` includes the same check.
- Keep the versioned hooks enabled with `make install-git-hooks`. Never bypass
  the `commit-msg` hook with `--no-verify` for a commit created by Codex.

Do not imitate legacy commit subjects that predate this policy. Automated
commits made by repository scripts must follow the same format.
