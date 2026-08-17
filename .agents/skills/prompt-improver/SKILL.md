---
name: prompt-improver
description: Rewrite and strengthen user-supplied prompts while preserving intent, scope, and technical context. Use only when the user explicitly asks to improve, rewrite, structure, clarify, or make a prompt copy-safe for another Codex or ChatGPT conversation; do not trigger for ordinary task execution.
---

# Improve the prompt

Rewrite the original request without executing it. Preserve its intent, scope,
constraints, supplied technical context, and optionality.

Clarify only what materially improves execution, such as:

- objective and expected result;
- current and desired behavior;
- investigation expectations;
- scope and constraints;
- acceptance criteria and validation;
- regression, safety, rollback, and documentation expectations;
- expected final report.

Do not invent repository structure, filenames, entity IDs, branches, APIs,
services, credentials, architecture, business rules, tools, infrastructure, or
technical requirements. Do not convert optional ideas into requirements or
arbitrarily expand the task. Correct terminology when useful without changing
meaning. Improve an already precise request lightly.

For debugging or investigation, prefer this execution flow when applicable:

1. understand the implementation and architecture;
2. confirm or reproduce the behavior;
3. trace the relevant data or execution path;
4. identify the root cause;
5. implement the smallest reliable correction;
6. validate the correction;
7. check regressions;
8. document findings and changes.

For infrastructure, Home Assistant, Node-RED, data engineering, CI/CD, Git,
integrations, networking, containers, operating systems, or production-adjacent
work, require understanding the current architecture before modification,
root-cause fixes, reuse of existing conventions, incremental and reversible
changes, preservation of existing behavior, end-to-end validation when
practical, and safer alternatives to destructive operations.

# Produce copy-safe output

Return the improved prompt inside exactly one outer fenced code block. Put the
actual Markdown source inside the fence so headings, lists, indentation, inline
code, paths, commands, URLs, and meaningful blank lines remain directly
copyable.

Do not use a blockquote as the outer container. Do not split the prompt across
multiple outer fences. Keep commentary, model recommendations, and notes outside
the fence unless they intentionally belong to the task specification.

Choose an outer fence longer than every consecutive backtick sequence inside
the prompt:

```text
outer fence length = longest internal backtick sequence + at least one
```

Prefer four backticks when the prompt contains ordinary three-backtick code
blocks; use five when it contains four consecutive backticks.

# Structure substantial engineering prompts

Use only the sections that clarify the task. Typical sections are:

- `# Objective`
- `# Context`
- `# Current Behavior`
- `# Desired Behavior`
- `# Investigation`
- `# Implementation Requirements`
- `# Validation`
- `# Regression Checks`
- `# Git / Delivery Requirements`
- `# Documentation`
- `# Final Report`

Keep simple prompts compact. Make substantial prompts detailed enough to serve
as the execution specification without reinterpretation.
