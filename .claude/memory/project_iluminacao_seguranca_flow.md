---
name: iluminacao-seguranca-flow
description: Design and constraints of the iluminacao_seguranca Node-RED flow (car-arrival security light)
metadata: 
  node_type: memory
  type: project
  originSessionId: b44a0317-db17-46ee-99ec-b333693e57c5
---

The `iluminacao_seguranca` tab in `nodered/flows.json` (documented in
[docs/ILUMINACAO_SEGURANCA_NODERED.md](../../mnt/data/docker/docs/ILUMINACAO_SEGURANCA_NODERED.md))
turns on `switch.refletor_portao_carros` when Gabriel, Valeria or the Creta
(car) arrive home in the dark, for visibility against intruders near the
garage/gate.

**Why it needed fixing (2026-07):** arrival distance threshold was
inconsistent across the flow (one node had an uncommitted change from 50m
to 300m, others still at 50m) because iPhone/Kia GPS wasn't precise enough
at 50m. Also, location refresh was slow (every 5 min) causing the light to
lag behind the car's actual arrival.

**Key constraint:** the Creta's location/engine data comes from the
`kia_uvo` integration (cloud polling of Kia/Hyundai Connect API), which
lags and can hit API rate limits or drain the 12V battery if force-refreshed
too often. The fix accelerates refresh to 1 min only when the Creta is
already within 1500m of home, keeping the 5-min cadence otherwise — avoids
account lockout while still getting fresh data exactly when arrival
detection needs it.

**How to apply:** Before changing any distance/timing constant in this flow,
check all three places that must stay in sync: `sec_detect_arriving_source`,
`sec_prepare_arrival_context` (creta_home), and `sec_update_arming_context`
(clear-on-home). Also update the `sec_comment_arrival_light` comment node's
info/name text — it's easy to update the code but forget the doc/comment
text on the canvas itself, which happened here. See [[feedback-doc-on-update]].

The repo file is owned by `dietpi` (Node-RED's host user), not `gabriel` —
edits to `nodered/flows.json` must go through `docker cp` into the
`nodered` container plus `docker exec -u 0 nodered chown node-red:node-red
/data/flows.json`, then `docker restart nodered` to load them (Node-RED
keeps flows in memory and would overwrite disk edits on next UI deploy
otherwise).
