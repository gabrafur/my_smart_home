# Documentation

[Português (primary)](README.md) · [English](README.en.md)

This index separates current reference documentation from historical records.
Entity and device names in feature guides are identifiers from the versioned
configuration. Real addresses, credentials, coordinates, MAC addresses, and
physical identifiers must appear only as placeholders.

## Start here

| Document | Use it for | Portuguese |
| --- | --- | --- |
| [Installation and restore](INSTALLATION_RESTORE.en.md) | Fresh clones, recovery, and host migration | [Português](INSTALACAO_RESTAURACAO_SMART_HOME.md) |
| [Containers](CONTAINERS.en.md) | Images, ports, volumes, dependencies, and operations | [Português](CONTAINERS.md) |
| [Weekly documentation review](WEEKLY_DOCUMENTATION_REVIEW.en.md) | Schedule, scope, credentials, and recovery | [Português](REVISAO_DOCUMENTACAO_SEMANAL.md) |
| [Public-repository security audit](AUDITORIA_SEGURANCA_REPO_PUBLICO.md) | Publishing, rotation, and Git history | Portuguese detailed record |
| [Bluetooth and Matter](BLUETOOTH_MATTER.md) | D-Bus, host networking, and commissioning | summarized in [Containers](CONTAINERS.en.md) |
| [Raspberry Pi health](RASPBERRY_PI_SYSTEM_HEALTH.md) | Host metrics and alerts | Portuguese detailed guide |
| [Zigbee health alerts](ZIGBEE_HEALTH_NOTIFICATIONS.en.md) | Bridge and device failure/recovery alerts | [Português](ZIGBEE_HEALTH_NOTIFICATIONS.md) |
| [Home Assistant agent bridge](CHAT_CLAUDE_CODE_HA.md) | Claude Code/Codex in the UI | summarized in [Containers](CONTAINERS.en.md) |

## Feature guides

The following detailed operational guides are maintained in Brazilian
Portuguese because that is the system's primary operating language:

- [External lighting in Node-RED](ILUMINACAO_EXTERNA_NODERED.md)
- [House alarm in Node-RED](ALARME_CASA_NODERED.md)
- [Arrival context and security lighting in Node-RED](ILUMINACAO_SEGURANCA_NODERED.md)
- [Alarm disarm on arrival](ALARME_DESARME_CHEGADA_NODERED.md)
- [Moni Mobile / Intelbras integration](INTEGRACAO_MONI_MOBILE_INTELBRAS.md)
- [Hyundai/Kia integration](CRETA_KIA_UVO_INTEGRATION.md)
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

Historical sections preserve dated incidents to explain decisions. An old
version or superseded behavior must be clearly marked as historical and point
to the current state.

## Maintenance policy

- Brazilian Portuguese is the primary language.
- The README, index, container guide, installation/restore runbook, weekly review, and
  explicitly bilingual features have complete English versions.
- Port, volume, variable, image, or procedure changes must update both language
  versions in the same change.
- Examples use placeholders or documentation-reserved addresses, never real
  household values.
- `node scripts/docs-check.mjs` verifies relative links and required bilingual
  pairs; run `scripts/security-scan.sh` before publishing.
