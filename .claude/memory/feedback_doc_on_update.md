---
name: feedback-doc-on-update
description: "Always create or update a doc in docs/ whenever making a nontrivial update to this smart-home repo (flows, HA config, scripts)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b44a0317-db17-46ee-99ec-b333693e57c5
---

Whenever a nontrivial change is made in this repo (Node-RED flows, Home
Assistant packages/scripts, integrations), create a new doc under `docs/`
or complement an existing one describing what changed and why, in the same
turn as the change — not just as a follow-up if asked.

**Why:** User explicitly asked for this after a fix to the
`iluminacao_seguranca` Node-RED flow, so that the reasoning behind
threshold values (e.g. arrival distance, refresh cadence) and known
constraints (e.g. Kia/Hyundai API rate limits) survive independently of
git commit messages or conversation history. See
[[iluminacao-seguranca-flow]].

**How to apply:** After editing `nodered/flows.json`, HA `packages/*.yaml`,
`custom_components/*`, or `tools/*.py`, check `docs/` for a related file
(match by feature name, e.g. `ILUMINACAO_SEGURANCA_NODERED.md`,
`CONTROLE_ENERGIA_HOME_ASSISTANT.md`, `INTEGRACAO_MONI_MOBILE_INTELBRAS.md`).
If one exists, update it; if not, create one following the existing style
(short sections, entity list, "why" behind non-obvious constants, a
"historico relevante" section for past fixes). Do this proactively, without
waiting for the user to ask again.
