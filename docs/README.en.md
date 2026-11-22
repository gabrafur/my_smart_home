# Documentation

[Português (primary)](README.md) · [English](README.en.md)

This index separates current reference documentation from historical records.
Entity and device names in feature guides are identifiers from the versioned
configuration. Real addresses, credentials, coordinates, MAC addresses, and
physical identifiers must appear only as placeholders.

## Start here

| Document | Use it for | Portuguese |
| --- | --- | --- |
| [Technical portfolio tour](ENGINEERING_TOUR.md) | 30-second, 5-minute, and 15-minute evidence paths | [Português](ENGINEERING_TOUR.pt-BR.md) |
| [Reusable components](REUSABLE_COMPONENTS.en.md) | Pieces you can use in other projects, their dependencies, and how to extract them | [Português](REUSABLE_COMPONENTS.md) |
| [Changelog](CHANGELOG.md) | Monthly features and performance changes from commits | bilingual single file |
| [Installation and restore](INSTALLATION_RESTORE.en.md) | Fresh clones, recovery, and host migration | [Português](INSTALACAO_RESTAURACAO_SMART_HOME.md) |
| [Deterministic restore contract](RESTORE_CONTRACT.en.md) | Manifest, bundle, plan/verify/apply, and AI context | [Português](RESTORE_CONTRACT.md) |
| [Bootstrap, modules, and demo](BOOTSTRAP_DEMO.en.md) | Minimum clone, optional features, and synthetic scenario | [Português](BOOTSTRAP_DEMO.md) |
| [Containers](CONTAINERS.en.md) | Images, ports, volumes, dependencies, and operations | [Português](CONTAINERS.md) |
| [Weekly documentation review](WEEKLY_DOCUMENTATION_REVIEW.en.md) | Schedule, scope, credentials, and recovery | [Português](REVISAO_DOCUMENTACAO_SEMANAL.md) |
| [Native automation boundary](HOME_ASSISTANT_NATIVE_AUTOMATIONS.en.md) | Criteria for keeping automations in Home Assistant or moving them to Node-RED | [Português](AUTOMACOES_NATIVAS_HOME_ASSISTANT.md) |
| [Public-repository security audit](AUDITORIA_SEGURANCA_REPO_PUBLICO.md) | Publishing, rotation, and Git history | Portuguese detailed record |
| [Bluetooth and Matter](BLUETOOTH_MATTER.md) | D-Bus, host networking, and commissioning | summarized in [Containers](CONTAINERS.en.md) |
| [Raspberry Pi health](RASPBERRY_PI_SYSTEM_HEALTH.md) | Host metrics, storage read retries, per-occurrence notices, and 30-day Logbook history | Portuguese detailed guide |
| [Home Assistant dashboards](DASHBOARDS.md) | Casa (default, everyone), admin-only Sistema, Creta, Map and Chat: audience, views and design rules | Portuguese detailed guide |
| [Host memory guardian](HOST_MEMORY_GUARDIAN.md) | Bounded memory relief for allowlisted abandoned temporary artifacts and disconnected remote-development sessions | Portuguese detailed guide |
| [Storage audit — phase 2](operations/storage-audit-phase-2.md) | Developer tools, cache, PM2, Docker cleanup, and recorder analysis | Portuguese detailed record |
| [Infrastructure monitoring](ZIGBEE_HEALTH_NOTIFICATIONS.en.md) | Zigbee, Tuya, and Internet failure/recovery in Node-RED | [Português](ZIGBEE_HEALTH_NOTIFICATIONS.md) |
| [Codex remote access recovery](CODEX_REMOTE_RECOVERY.md) | Portuguese runbook for SSH/App Server detection, idempotent automatic recovery, and Tailscale separation | Portuguese source |
| [Raspberry MCP administration and portability](raspberry-mcp/README.md) | Delegated server administration, schemas, installation, client connections and revocation; current acceptance and deployment limits are explicit | Portuguese runbook |
| [Native MQTT metadata observation](MQTT_SOURCE_OBSERVER.md) | Opt-in source candidate: fixed seven-class metadata, visual policy, verified SDK build and data-only recovery; installation and permanent access remain separately approved | Portuguese runbook |
| [Global Node-RED failure notifications](NODERED_GLOBAL_FAILURE_NOTIFICATIONS.en.md) | Flow errors, runtime unavailability, and the optional mobile delivery test | [Português](NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md) |
| [Canonical Node-RED notification hubs](NODERED_NOTIFICATION_HUBS.md) | Portuguese contracts for mobile, Alexa, and HA persistent hubs, fail-closed recipients, and the migration equivalence matrix | Portuguese source |
| [Node-RED ELK layout engine](node-red/ELK_LAYOUT_ENGINE.md) | Portuguese runbook for dry-run planning, the visual-only allowlist, quality gates, idempotency, and safe rollback | Portuguese source |
| [VPN health notifications](VPN_HEALTH_NOTIFICATIONS.md) | Portuguese runbook for sanitized host health, internet-outage suppression, and deduplicated VPN alerts | Portuguese source |
| [Home Assistant agent bridge](CHAT_CLAUDE_CODE_HA.md) | Claude Code/Codex in the UI | summarized in [Containers](CONTAINERS.en.md) |
| [Codex + Local AI with RTX 4070](LOCAL_AI_RTX_4070.md) | Local inference, network, telemetry, and fork reproduction | detailed Portuguese guide |
| [Local AI RTX release integration](../local-ai-integration/README.md) | Lock, checksum, immutable install, and rollback | English summary |
| [Deployment-specific Local AI research](../local-ai-research/README.md) | Datasets, harnesses, and historical benchmark limits | English summary |
| [Versioned agent memory](MEMORIA_VERSIONADA_AGENTES.md) | Authority, privacy, maintenance, and validation of AI memory | detailed Portuguese guide |
| [Codex project memory audit](CODEX_PROJECT_MEMORY_AUDIT.md) | Baseline capture gap, isolated cross-session retrieval, source-validated notes, and a Stop review checkpoint requiring client activation | Detailed Portuguese audit |
| [Privacy model](PRIVACY_MODEL.en.md) | Public roles, sanitization, scanning, and public memory | [Português](PRIVACY_MODEL.md) |
| [Public/private boundary](PUBLIC_PRIVATE_BOUNDARY.en.md) | Bindings, bootstrap, safe degradation, and compatibility | [Português](PUBLIC_PRIVATE_BOUNDARY.md) |
| [Testing strategy](TESTING_STRATEGY.en.md) | Levels, discovery, CI, and no-household boundaries | [Português](ESTRATEGIA_DE_TESTES.md) |
| [Dependency provenance](DEPENDENCY_PROVENANCE.en.md) | Vendored code, licenses, deltas, locks, and digests | [Português](DEPENDENCY_PROVENANCE.md) |
| [Licensing decision](LICENSING_DECISION.md) | First-party/vendored inventory, realistic options, and template contradiction | [Português](LICENSING_DECISION.pt-BR.md) |
| [GitHub repository settings](GITHUB_REPOSITORY_SETTINGS.en.md) | Observed state, template, ruleset, and manual checklist | [Português](GITHUB_REPOSITORY_SETTINGS.md) |
| [Commit convention](COMMIT_CONVENTION.en.md) | Format, types, scopes, breaking changes, and validation | [Português](CONVENCAO_COMMITS.md) |
| [Documentation assets](assets/README.en.md) | Mermaid source, SVG, social preview, and reproduction | [Português](assets/README.md) |

## Node-RED operations

These guides are maintained in Brazilian Portuguese:

- [Daily Git backup](GIT_BACKUP_NODERED.md) — first stage of the nightly chain
- [Recorder retention](RECORDER_RETENTION_NODERED.md) — selective history compaction and purge
- [Resume after a power loss](NODERED_STARTUP_RECOVERY.md) — canonical authorization to resume external tasks
- [Canonical Codex alerts](CODEX_ALERTAS_NODERED.md) — level and delivery of Codex usage alerts
- [Zigbee coordinator recovery](ZIGBEE_COORDINATOR_RECOVERY.md) — validated backup, bounded reconnection, last-good copy
- [Canvas style guide](node-red/CANVAS_STYLE_GUIDE.md) and [visual migration inventory](NODERED_VISUAL_MIGRATION_INVENTORY.md)
- [Manual iCloud re-authentication](ICLOUD_MANUAL_AUTH.en.md) (English) · [Português](ICLOUD_MANUAL_AUTH.md)

## Feature guides

Brazilian Portuguese is the system's primary operating language. The alarm and
garage gate guides below have full English versions; the others are in
Portuguese, summarised in English further down:

- [External lighting in Node-RED](ILUMINACAO_EXTERNA_NODERED.md)
- [House alarm in Node-RED](ALARME_CASA_NODERED.en.md)
- [Arrival context and security lighting in Node-RED](ILUMINACAO_SEGURANCA_NODERED.md)
- [Security flow state and recovery inventory (Portuguese)](SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md)
- [Alarm disarm on arrival](ALARME_DESARME_CHEGADA_NODERED.md)
- [Moni Mobile / Intelbras integration](INTEGRACAO_MONI_MOBILE_INTELBRAS.md)
- [Hyundai/Kia integration](VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md)
- [Hyundai/Kia safe-update runbook (Portuguese)](VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md)
- [Garage gate: local relay](PORTAO_GARAGEM_RELE_LOCAL.md)
- [Garage gate: pulse button](PORTAO_GARAGEM_BOTAO_PULSO.en.md)
- [Power control](CONTROLE_ENERGIA_HOME_ASSISTANT.md)
- [TV Wake-on-LAN](WAKE_ON_LAN_TV_SALA.md)

### Feature summaries

- **House alarm (`alarme_casa`).** The single place that decides, records and
  executes arm/disarm through the logical `security_panel` binding. Voice,
  CarPlay and confirmed-arrival requests converge on it; retry interval,
  warning cadence and attempt limit live in a visible parameter group that
  rejects out-of-range values while keeping the last valid one. Test injects
  use isolated synthetic state and end at a dry-run terminal.
- **Alarm disarm on arrival (`alarme_desarme_chegada`).** Consumes only
  `security.arrival.v1` contracts from the location and vehicle flows (no GPS
  logic of its own), asks for confirmation through an actionable notification,
  and disarms only after someone taps *Disarm*. Producers persist a 10-minute
  dedupe, so a restart never re-creates a confirmation; stale or `unknown`
  snapshots never count as an arrival.
- **Arrival context and security lighting.** Five tabs split people location,
  vehicle context, the joint `anyone_away` policy, resident notifications and
  the floodlight decision, so lighting never sees trackers, coordinates or
  vehicle details.
- **Garage gate pulse.** Node-RED is the only controller of the dry-contact
  relay: one accepted request produces exactly `ON → 700 ms → OFF`, never
  retries `ON`, starts the cooldown before publishing, and only sends `OFF` to
  a relay last reported `ON`. There is no position sensor, so position is never
  inferred and the relay is hidden from every dashboard.
- **Global failure observer (`observabilidade_global`).** A generator adds a
  `catch`/`status` group with a named link to every functional tab. Errors
  alert immediately with six-hour per-signature silencing; Home Assistant and
  MQTT node errors are suppressed while the shared connection is down and for
  90 seconds after reconnection, and only explicit disconnection text opens a
  shared incident. Alerts go through the mobile and persistent notification
  hubs, which resolve logical recipients through private bindings.
- **Nightly chain.** Git backup, then a verified protected off-site backup,
  then separate update subflows (host packages, Home Assistant Core, other
  containers, Codex CLI, vendored integrations audited against upstream, device
  firmware). A failure holds later stages; the host is never rebooted; unknown
  update sources fail closed. Details: [Containers](CONTAINERS.en.md#updates-and-rollback).

Across these guides, cloud vehicle/alarm integrations are optional inputs, and
power and host-health features expose only controlled actions and local metrics.

## Historical records

- [Public repository audit](AUDITORIA_SEGURANCA_REPO_PUBLICO.md)
- [Git history cleanup handoff](HANDOFF_LIMPEZA_HISTORICO_GIT.md)
- [Storage audit — phase 1](operations/storage-audit.md)
- Local AI benchmarks: [2026-08-16](LOCAL_AI_BENCHMARK_2026-08-16.md),
  [high potential](LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md),
  [quality bake-off](LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md), and
  [restricted pivot](LOCAL_AI_RESTRICTED_PIVOT_2026-08-25.md)

These records are sanitized technical cases. They retain the problem, cause,
T0/T+ investigation, fix, validation, and lessons without household chronology,
names, routes, or private identifiers.

## Portfolio

- [Technical portfolio tour — English](ENGINEERING_TOUR.md) ·
  [Português](ENGINEERING_TOUR.pt-BR.md)
- [LinkedIn project — English](portfolio/linkedin-project-en.md) ·
  [Português](portfolio/linkedin-project-pt-BR.md)
- [Technical case study — English](portfolio/technical-case-study-en.md) ·
  [Português](portfolio/technical-case-study-pt-BR.md)
- [Deterministic demo output — English](demo-output.md) ·
  [Português](demo-output.pt-BR.md)

## Maintenance policy

- Brazilian Portuguese remains the primary operating-documentation language;
  the root `README.md` is English so GitHub has an international landing page.
- Every public human document declares its area and strategy in
  [`i18n-manifest.json`](i18n-manifest.json).
- `full pair` documents must change in both languages; `summary pair`,
  `archived`, and `third-party/not-translated` are explicit policies, not
  forgotten translations.
- Port, volume, variable, image, or procedure changes must update both language
  versions in the same change.
- Examples use placeholders or documentation-reserved addresses, never real
  household values.
- `make validate-public` verifies links, required bilingual pairs, public agent
  memory, and mechanically detectable privacy rules.

<!-- mcp-maintenance-docs-index-v1 -->

## Raspberry MCP

The [Raspberry MCP English summary](raspberry-mcp/README.en.md) covers
administration and portability, the remote Claude connector, household tools,
Node-RED administration, notifications, task control, and maintenance records.
The canonical Portuguese guide is [raspberry-mcp/README.md](raspberry-mcp/README.md).
