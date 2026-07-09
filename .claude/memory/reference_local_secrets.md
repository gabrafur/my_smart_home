---
name: reference-local-secrets
description: "Where locally-generated secrets/tokens for this host (not in git) are stored, e.g. the Home Assistant long-lived access token"
metadata: 
  node_type: memory
  type: reference
  originSessionId: f3d008f0-f5ec-4a7f-a273-343ccb912132
---

`/mnt/data/docker/.local-secrets/` (mode 700, gitignored via `.local-secrets/`
in `.gitignore`) holds secrets that shouldn't go in `.env` or in the repo:
MQTT/Node-RED admin passwords, Moni capture logs, and — as of 2026-07-09 — a
Home Assistant long-lived access token at `ha-long-lived-token.txt` (mode
600). Use that token for HA REST API calls (`Authorization: Bearer $(cat
...)`) when a task needs to drive `config_entries`/services beyond what the
UI conveniently exposes. See [[project_power_matter_bluetooth]] for an
example (finishing Bluetooth/Matter setup via `/api/config/config_entries/flow`).
