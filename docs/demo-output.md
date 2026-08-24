# Deterministic synthetic demo output

[English](demo-output.md) · [Português](demo-output.pt-BR.md)

This is the checked output of `make demo` for the versioned synthetic fixture.
`scripts/demo.test.mjs` compares this block byte for byte with the formatter, so
the example cannot drift from executable behavior.

```text
Synthetic smart-home recovery demo: public-smart-home-recovery-demo
Safety: network=off | devices=off | credentials=none | dispatched_actions=0
Arrival: context=opened | resident_primary=home | security=disarm-requested | exterior_light=off
Resilience: alerts=3 | deduplicated=1 | stale_rejected=1 | restart_restores=1 | recoveries=3
Health: storage=healthy | internet=online | zigbee=online | active_alerts=0
Evidence:
- arrival coordination: arrival-context-opened -> presence-confirmed
- infrastructure degradation: internet-alert-created; zigbee-alert-created
- deduplication: internet-alert-deduplicated
- stale/out-of-order: internet-stale-event-rejected
- restart safety: restart-state-restored
- recovery: internet-recovery-recorded; zigbee-recovery-recorded; storage-recovery-recorded
```

All actions are logical records with `simulated: true` and `dispatched: false`.
The restart step serializes and reloads only the in-memory synthetic context; it
does not start, stop, or contact a service. See the
[demo contract](BOOTSTRAP_DEMO.en.md) and [engine](../demo/engine.mjs).
