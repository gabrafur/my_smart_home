# My Smart Home

Configuration backup for the local smart-home stack:

- Home Assistant
- Node-RED
- Mosquitto
- Zigbee2MQTT
- AppDaemon
- Portainer compose definition

Sensitive runtime files are intentionally ignored, including Home Assistant
secrets/auth/cookies, SQLite databases, backups, Node-RED credentials, Mosquitto
passwords, Portainer state, Zigbee2MQTT network keys, and Tuya/tinytuya
credentials (device local keys and cloud Access ID/Secret).

On a new Raspberry Pi, restore the ignored secrets from a secure backup before
starting the containers.

## Documentation

Per-feature write-ups (design, constraints, gotchas, and the reasoning behind
non-obvious decisions) live in [`docs/`](docs/) — one file per integration/feature.
Highlights:

- [Installation / restore procedure](docs/INSTALACAO_RESTAURACAO_SMART_HOME.md) — full rebuild for a fresh Pi
- [Garage gate — local Zigbee relay](docs/PORTAO_GARAGEM_RELE_LOCAL.md) — replaced the cloud Tuya scene with a local relay pulse to cut trigger latency from seconds to <100 ms
- [Security lighting (Node-RED)](docs/ILUMINACAO_SEGURANCA_NODERED.md) · [External lighting (Node-RED)](docs/ILUMINACAO_EXTERNA_NODERED.md)
- [Moni Mobile / Intelbras alarm](docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md)
- [Kia UVO (Creta) integration](docs/CRETA_KIA_UVO_INTEGRATION.md)
- [Energy control](docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md) · [Bluetooth / Matter](docs/BLUETOOTH_MATTER.md) · [Wake-on-LAN TV](docs/WAKE_ON_LAN_TV_SALA.md)
- [Chat with Claude Code in HA](docs/CHAT_CLAUDE_CODE_HA.md)
