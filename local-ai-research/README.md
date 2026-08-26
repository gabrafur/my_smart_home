# Local AI deployment research

This directory preserves the frozen datasets, benchmark harnesses, and
historical evaluation tooling created specifically for this Home Assistant
deployment. It is not the reusable runtime.

The runtime comes from the immutable version pinned in
[`../local-ai-integration/local-ai-rtx.lock.json`](../local-ai-integration/local-ai-rtx.lock.json)
and defaults to `$HOME/.local/share/local-ai-rtx/current`. Override
`LOCAL_AI_RUNTIME_DIR` only to evaluate another already-verified installation.

The research targets remain sequential and resource-limited because the
checkout runs on the active residential host. Unit checks may run offline;
GPU benchmarks require the existing resource preflight and canonical Make
targets. Generated private artifacts stay under `.agent-history/`.

The methods and limitations are documented in the dated Local AI reports under
the [`../docs/` index](../docs/README.md). Historical fixture strings may retain former source
paths so frozen hashes and provenance remain reproducible.
