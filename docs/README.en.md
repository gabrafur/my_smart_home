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
| [Installation and restore](INSTALLATION_RESTORE.en.md) | Fresh clones, recovery, and host migration | [Português](INSTALACAO_RESTAURACAO_SMART_HOME.md) |
| [Deterministic restore contract](RESTORE_CONTRACT.en.md) | Manifest, bundle, plan/verify/apply, and AI context | [Português](RESTORE_CONTRACT.md) |
| [Bootstrap, modules, and demo](BOOTSTRAP_DEMO.en.md) | Minimum clone, optional features, and synthetic scenario | [Português](BOOTSTRAP_DEMO.md) |
| [Containers](CONTAINERS.en.md) | Images, ports, volumes, dependencies, and operations | [Português](CONTAINERS.md) |
| [Weekly documentation review](WEEKLY_DOCUMENTATION_REVIEW.en.md) | Schedule, scope, credentials, and recovery | [Português](REVISAO_DOCUMENTACAO_SEMANAL.md) |
| [Native automation boundary](HOME_ASSISTANT_NATIVE_AUTOMATIONS.en.md) | Criteria for keeping automations in Home Assistant or moving them to Node-RED | [Português](AUTOMACOES_NATIVAS_HOME_ASSISTANT.md) |
| [Public-repository security audit](AUDITORIA_SEGURANCA_REPO_PUBLICO.md) | Publishing, rotation, and Git history | Portuguese detailed record |
| [Bluetooth and Matter](BLUETOOTH_MATTER.md) | D-Bus, host networking, and commissioning | summarized in [Containers](CONTAINERS.en.md) |
| [Raspberry Pi health](RASPBERRY_PI_SYSTEM_HEALTH.md) | Host metrics and alerts | Portuguese detailed guide |
| [Storage audit — phase 2](operations/storage-audit-phase-2.md) | Developer tools, cache, PM2, Docker cleanup, and recorder analysis | Portuguese detailed record |
| [Infrastructure monitoring](ZIGBEE_HEALTH_NOTIFICATIONS.en.md) | Zigbee, Tuya, and Internet failure/recovery in Node-RED | [Português](ZIGBEE_HEALTH_NOTIFICATIONS.md) |
| [Home Assistant agent bridge](CHAT_CLAUDE_CODE_HA.md) | Claude Code/Codex in the UI | summarized in [Containers](CONTAINERS.en.md) |
| [Codex + Local AI with RTX 4070](LOCAL_AI_RTX_4070.md) | Local inference, network, telemetry, and fork reproduction | detailed Portuguese guide |
| [Local AI RTX release integration](../local-ai-integration/README.md) | Lock, checksum, immutable install, and rollback | English summary |
| [Deployment-specific Local AI research](../local-ai-research/README.md) | Datasets, harnesses, and historical benchmark limits | English summary |
| [Versioned agent memory](MEMORIA_VERSIONADA_AGENTES.md) | Authority, privacy, maintenance, and validation of AI memory | detailed Portuguese guide |
| [Privacy model](PRIVACY_MODEL.en.md) | Public roles, sanitization, scanning, and public memory | [Português](PRIVACY_MODEL.md) |
| [Public/private boundary](PUBLIC_PRIVATE_BOUNDARY.en.md) | Bindings, bootstrap, safe degradation, and compatibility | [Português](PUBLIC_PRIVATE_BOUNDARY.md) |
| [Testing strategy](TESTING_STRATEGY.en.md) | Levels, discovery, CI, and no-household boundaries | [Português](ESTRATEGIA_DE_TESTES.md) |
| [Dependency provenance](DEPENDENCY_PROVENANCE.en.md) | Vendored code, licenses, deltas, locks, and digests | [Português](DEPENDENCY_PROVENANCE.md) |
| [Licensing decision](LICENSING_DECISION.md) | First-party/vendored inventory, realistic options, and template contradiction | [Português](LICENSING_DECISION.pt-BR.md) |
| [GitHub repository settings](GITHUB_REPOSITORY_SETTINGS.en.md) | Observed state, template, ruleset, and manual checklist | [Português](GITHUB_REPOSITORY_SETTINGS.md) |
| [Commit convention](COMMIT_CONVENTION.en.md) | Format, types, scopes, breaking changes, and validation | [Português](CONVENCAO_COMMITS.md) |
| [Documentation assets](assets/README.en.md) | Mermaid source, SVG, social preview, and reproduction | [Português](assets/README.md) |

## Feature guides

The following detailed operational guides are maintained in Brazilian
Portuguese because that is the system's primary operating language:

- [External lighting in Node-RED](ILUMINACAO_EXTERNA_NODERED.md)
- [House alarm in Node-RED](ALARME_CASA_NODERED.md)
- [Arrival context and security lighting in Node-RED](ILUMINACAO_SEGURANCA_NODERED.md)
- [Security flow state and recovery inventory (Portuguese)](SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md)
- [Alarm disarm on arrival](ALARME_DESARME_CHEGADA_NODERED.md)
- [Moni Mobile / Intelbras integration](INTEGRACAO_MONI_MOBILE_INTELBRAS.md)
- [Hyundai/Kia integration](VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md)
- [Hyundai/Kia safe-update runbook (Portuguese)](VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md)
- [Garage gate: local relay](PORTAO_GARAGEM_RELE_LOCAL.md)
- [Garage gate: pulse button](PORTAO_GARAGEM_BOTAO_PULSO.md)
- [Power control](CONTROLE_ENERGIA_HOME_ASSISTANT.md)
- [TV Wake-on-LAN](WAKE_ON_LAN_TV_SALA.md)

In brief, these guides document failure-safe local control: arrival and alarm
flows include stale-state guards and retries; the garage relay emits a single
bounded pulse and never infers gate position; cloud vehicle/alarm integrations
are treated as optional inputs; power and host-health features expose only
controlled actions and local metrics.

## Historical records

- [Public repository audit](AUDITORIA_SEGURANCA_REPO_PUBLICO.md)
- [Git history cleanup handoff](HANDOFF_LIMPEZA_HISTORICO_GIT.md)

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
