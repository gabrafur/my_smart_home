---
name: rtx-context-optimizer
description: Optimize large non-sensitive documentation, repository-memory retrieval, logs, diffs, test or scanner output, and file-triage context. Use when deterministic preprocessing leaves a large, compressible body that can benefit from Local AI/RTX before the primary model receives it; do not use for secrets, final security or production decisions, migrations, destructive actions, or small/structured data that deterministic tools can resolve.
---

Use deterministic discovery, filtering, parsing, and selection first.

Call `local_ai_route` with task metadata before sending text. If it reports
that the task is eligible and beneficial, call `local_ai_compress_context` with
the smallest relevant non-sensitive body and then use only its structured
result as primary-model context. Use `summarize-memory` only after the project
index and deterministic retrieval select relevant public memory; provide its
logical topic.

If `local_ai_status` or a compression tool fails, continue normally. Local AI
is an optimization, not a dependency. Do not invoke it for small tasks simply
to create GPU activity or telemetry.
