# Technical portfolio tour

[English](ENGINEERING_TOUR.md) · [Português](ENGINEERING_TOUR.pt-BR.md)

This tour is a reading path through evidence, not a second overview. It stays
inside the public repository and uses synthetic tests; no household runtime is
needed.

## 30 seconds: system shape

- **Architecture:** Home Assistant, Node-RED, and MQTT form the core. Optional
  modules add Zigbee, Matter, AppDaemon, cloud-backed integrations, and agent
  tooling. The [architecture diagram](assets/smart-home-architecture.svg)
  separates public code, private runtime, physical devices, optional cloud
  services, backup/restore, and the agent/Local-AI boundary.
- **Stack:** Docker Compose, Home Assistant, Node-RED, Mosquitto, Zigbee2MQTT,
  Python, JavaScript, YAML/Jinja, and GitHub Actions.
- **Engineering differentiators:** explicit state/recovery contracts,
  fail-closed bindings, deterministic restore, isolated runtime replays,
  privacy scanners, and a synthetic no-device demo.

## 5 minutes: the engineering argument

1. **State is event-driven and guarded.** Logical roles decouple public logic
   from device IDs. Node-RED replays exercise duplicates, stale snapshots,
   conflicting observations, and restart ordering.
2. **Failure and recovery are observable states.** Internet, Zigbee, storage,
   and arrival/security flows emit bounded incidents, deduplicate notifications,
   and record recovery rather than treating logs as proof.
3. **Public and private data have separate contracts.** Schemas and synthetic
   fixtures are reviewable; bindings, registries, secrets, coordinates, and
   history stay outside Git. Missing bindings fail closed.
4. **Restore is deterministic within an explicit boundary.** A manifest defines
   private components. `plan` and `verify` are read-only; `apply` validates its
   destination, requires a confirmation token, and prepares rollback.
5. **CI and local validation share one entry point.** `make validate-public`
   drives structure, documentation, provenance-adjacent checks, security,
   privacy, runtime replays, restore, bootstrap, and demo tests. GitHub Actions
   invokes that same target.

## 15 minutes: representative implementation

| # | Evidence surface | What to inspect |
| --- | --- | --- |
| 1 | [Architecture source](assets/smart-home-architecture.mmd) | Boundaries and truthful dependency arrows; the SVG is generated from this source. |
| 2 | [Module graph](../modules/features.json) and [Compose overlay](../compose.modules.yml) | Three-service core, optional profiles, declared dependencies, and safe degradation. |
| 3 | [Home Assistant public-binding adapter](../homeassistant/custom_components/public_bindings/__init__.py) and [binding schema](../bindings/public-bindings.schema.json) | Logical-role projection, attribute allowlists, read-only private mount, and unavailable-action failure. |
| 4 | [Security recovery replay](../nodered/tools/test-security-recovery-flow.mjs) against [flows](../nodered/flows.json) | Restart recovery, stale/out-of-order rejection, lifecycle timers, and physical-state reconciliation. |
| 5 | [Infrastructure runtime replay](../nodered/tools/test-infrastructure-monitoring-runtime.mjs) | Isolated Node-RED execution for outage thresholds, notification deduplication, recovery, and bounded subprocess concurrency. |
| 6 | [Privacy scanner](../scripts/privacy-check.mjs) and [synthetic bindings](../bindings/private-bindings.example.json) | Semantic role validation and non-echoing detection of publication risks. |
| 7 | [Restore engine](../scripts/restore.mjs) and [adversarial tests](../scripts/restore.test.mjs) | Manifest validation, dangerous-destination rejection, symlink defense, confirmation, and rollback preparation. |
| 8 | [Synthetic demo engine](../demo/engine.mjs), [fixture](../demo/scenario.json), and [tests](../scripts/demo.test.mjs) | Presence/arrival coordination, health signals, deduplication, stale rejection, restart reload, and proof of no real I/O. |
| 9 | [Canonical validation](../Makefile) and [GitHub workflow](../.github/workflows/public-validation.yml) | One local/CI contract with read-only workflow permissions. |
| 10 | [Agent-context recovery](../scripts/ai-context-recovery.mjs) and [public memory contract](MEMORIA_VERSIONADA_AGENTES.md) | Commit-bound recovery from sanitized public memory, with private transcripts excluded. |

Continue with the [platform-engineering case study](portfolio/technical-case-study-en.md)
for constraints and trade-offs, or run the [safe demonstration](BOOTSTRAP_DEMO.en.md).
