# Saída determinística da demo sintética

[English](demo-output.md) · [Português](demo-output.pt-BR.md)

Esta é a saída verificada de `make demo` para a fixture sintética versionada.
`scripts/demo.test.mjs` compara este bloco byte a byte com o formatter; assim, o
exemplo não pode divergir do comportamento executável.

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

Todas as ações são registros lógicos com `simulated: true` e
`dispatched: false`. O passo de restart serializa e recarrega somente o contexto
sintético em memória; ele não inicia, interrompe nem contata um serviço. Veja o
[contrato da demo](BOOTSTRAP_DEMO.md) e a [engine](../demo/engine.mjs).
