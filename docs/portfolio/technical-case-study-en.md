# Technical case study — self-hosted smart-home platform

[Português](technical-case-study-pt-BR.md) · [English](technical-case-study-en.md)

## Problem

A useful smart home accumulates local and cloud integrations, stateful flows,
device identities, and operational procedures. The goal was to make that
engineering publicly reviewable without publishing the household or turning a
clone into automatic real-world operation.

## Constraints

- events can be duplicated, delayed, or out of order;
- integrations and devices restart in different sequences;
- physical actions require fresh context and proven ownership;
- cloud services introduce latency, rate limits, and outages;
- registries, keys, coordinates, and history must not ship with code;
- restore must be useful while rejecting dangerous bundles and destinations.

The system runs continuously on resource-constrained residential hardware, so
validation and maintenance must not compete with Home Assistant, MQTT, SSH, or
automations. Public evidence must also remain useful without real devices.

## Architecture

[The versioned diagram](../assets/smart-home-architecture.svg) separates the
Home Assistant/Node-RED/MQTT core, optional modules, private bindings/state,
observability, and restore. The minimum Compose graph has three services;
profiles add capabilities without portraying them as mandatory.

## Failure modes

- duplicated, delayed, or out-of-order state can repeat a physical effect;
- Home Assistant and Node-RED can restart in either order with incomplete
  snapshots;
- cloud APIs can rate-limit, time out, or return cached state;
- Internet, Zigbee, storage, or individual devices can degrade independently;
- an incomplete restore can be more damaging than a controlled outage;
- publication can accidentally turn identifiers or history into sensitive data.

## State and recovery design

Home Assistant normalizes state and exposes services. MQTT decouples producers
and consumers. Node-RED implements state machines, readiness gates,
deduplication, and persistent timers. Logical roles such as `resident_primary`
and `exterior_light` replace installation-specific IDs.

Flows handle `unknown`, `unavailable`, future/old timestamps, conflicting
snapshots, and restarts during transitions. Side effects fail closed until
reconciliation. External calls use cooldowns, bounded retry, backoff, and the
last known state without promoting cached data to new truth. The
[security recovery replay](../../nodered/tools/test-security-recovery-flow.mjs)
exercises these rules directly against the versioned flow functions.

## Disaster recovery

Recoverable public state lives in code, tests, and configuration. Private state
follows a versioned manifest and encrypted bundle. `plan` and `verify` are
read-only; `apply` validates destination, permissions, and symlinks, requires
an explicit confirmation token, and prepares rollback. Agent context is rebuilt
from the commit and public memory, never automatic private transcripts.

## Privacy model

The repository publishes schemas, examples, and synthetic roles. Secrets,
registries, backups, flow credentials, maps, and physical state are ignored.
Security and privacy scanners inspect tracked/staged content without echoing a
finding's value. Vendored integrations record versions, origins, licenses, and
local modifications. The [binding schema](../../bindings/public-bindings.schema.json)
and [privacy scanner](../../scripts/privacy-check.mjs) make that boundary
reviewable without a registry export.

## Testing strategy

`make validate-public` is the single contract. It validates Compose, JSON/YAML,
shell, links/i18n/assets, security, privacy, memory, isolated Node-RED runtime,
the bridge, Local AI, modules, restore, bootstrap, and demo. Replays cover happy
paths and adversarial recovery without household I/O.

## Observability

Flows publish explicit outage/recovery phases, incident duration, and
notification deduplication. Host and storage metrics remain local. Local AI
telemetry records decisions and counts only—not prompts or content.

## AI tooling

An optional bridge connects coding agents to Home Assistant, and an RTX helper
can compress large public context. Both are bounded: they receive no secrets,
do not make destructive decisions, and do not replace deterministic validation or
human approval.

## Operational trade-offs

- Realistic configuration adds engineering value but requires scanners and
  bindings.
- Vendoring integrations preserves local compatibility but creates update debt
  and license duties.
- Persistence improves recovery but needs schemas, expiry, and fail-closed
  behavior.
- Full restore depends on a private bundle; the repository alone guarantees
  only the platform, tests, and synthetic demo.

## What I learned and would change at larger scale

1. Safe automation is primarily state and failure engineering.
2. Reproducibility must state what cannot live in Git.
3. Every public capability should link to executable evidence.
4. AI is useful in editorial and operational paths when its limits are explicit
   and final decisions remain human or deterministic.

At larger scale, I would introduce versioned event schemas across producers,
move high-cardinality observability to a dedicated telemetry stack, run broad
validation on isolated workers, and replace most vendored integrations with a
verified patch/fetch pipeline. I would also separate household policy from
device adapters more aggressively so multiple installations could share the
same state machines without inheriting one deployment's operational choices.
