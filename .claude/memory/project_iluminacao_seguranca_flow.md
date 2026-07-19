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

As of 2026-07-10 the repo file is owned by `gabriel` and directly editable
(no `docker cp`/`chown` needed) — earlier notes about a `dietpi`-owned file
requiring a `docker cp` workaround are stale, ownership must have been
fixed since. `/mnt/data/docker/nodered` is bind-mounted straight into the
container at `/data`, so a direct edit to `nodered/flows.json` is
immediately visible inside the container. Node-RED still keeps the flow in
memory once running, so a plain file edit alone does **not** take effect —
`docker restart nodered` is required to make it reload `/data/flows.json`
from disk. Confirm with `docker logs nodered --since 30s` after restart:
look for `Starting flows` / `Started flows` with no errors, and reconnects
to `Home Assistant` and `Zigbee2MQTT`. If a future session hits a
permission error on this file, re-check ownership with `ls -la
nodered/flows.json` before falling back to the old `docker cp` workaround.

**2026-07-10 fix — Gabriel/Valeria have two device_trackers each:**
`device_tracker.iphone_de_{gabriel_furlan,valeria}` (`mobile_app`
integration, real-time push) and a second one from the `icloud` integration
(`device_tracker.iphonegabrielfurlan` for Gabriel,
`device_tracker.iphone_de_valeria_2` for Valeria — note the inconsistent
naming, `icloud` doesn't reuse the `_2` suffix pattern for Gabriel). The
`mobile_app` tracker can get stuck reporting a stale "home" fix when iOS
suspends background updates (confirmed live: Valeria showed ~27m from home
while actually ~5.2km away at work, and the `icloud` tracker had the
correct position). Fixed by merging both trackers in `sec_refresh_anyone_away`
and `sec_prepare_arrival_context` (function `mergeWithIcloudFallback`):
prefer whichever tracker reports the *greater* distance from home when both
have reliable coordinates. See docs/ILUMINACAO_SEGURANCA_NODERED.md
("Fallback de localizacao via iCloud") for the trade-off (arrival detection
can lag slightly since iCloud only polls ~every 30 min).

**2026-07-10 fix — Creta entities stopped updating during HA instability:**
User reported `binary_sensor.creta_engine` not reflecting a same-day drive.
Root cause was *not* the `kia_uvo`/`hyundai_kia_connect_api` integration
(its `/location/park` call legitimately 400s while the car is moving in
the BR region API — already caught/ignored by the lib, doesn't affect the
engine sensor which comes from a separate endpoint). Real cause:
`sec_refresh_anyone_away` set the `sec_kia_last_force_refresh_ts` cooldown
flow var *optimistically*, before the downstream `button.press` service
call ran — so if that call failed (confirmed via Node-RED log:
`[error] [api-call-service:Forcar refresh Creta] ... "Connection lost"`),
the 5-min cooldown was still consumed and blocked retries even though
nothing actually refreshed. That day the `homeassistant` container was
being stopped/started repeatedly (~09:13–09:46, `RestartCount=0` and
`OOMKilled=false` on inspect, i.e. *external* restarts, not a crash loop —
cause unknown, nothing in this repo's cron/scripts restarts it) which is
what triggered the failed call in the first place. Fixed by only marking
the cooldown on confirmed success: new node `sec_creta_refresh_ack` wired
to `sec_force_refresh_creta`'s (previously unwired) output, doing the
`flow.set` there instead of inside `sec_refresh_anyone_away`. See
docs/ILUMINACAO_SEGURANCA_NODERED.md for full writeup. If entities go
stale again, check `docker logs nodered | grep -i "Forcar refresh Creta"`
first — a `Connection lost`/error there means HA was unreachable at that
moment, not a Kia API problem.

**2026-07-10 follow-up — engine history fundamentally can't be reconstructed
from status polling:** even after the ack fix above, `binary_sensor.creta_engine`
*history* still didn't match the Bluelink app. Confirmed empirically:
across two full round-trips on 2026-07-09 (per `device_tracker.creta_location`),
the engine binary_sensor never once recorded "on" — polling is too sparse
(only forced live every 5 min while "away", cached otherwise) and Hyundai's
BR backend likely only reports live status reliably around parking events
(same pattern as the `/location/park` 400-while-driving behavior). Fixing
this by polling more aggressively would fight a losing battle against
account rate-limits for uncertain benefit. Real fix: added
`sensor.garagem_creta_day_trip_info` in
`homeassistant/custom_components/kia_uvo/` (coordinator.py +
`async_refresh_day_trip_info`, button.py + `refresh_trip_info`, sensor.py +
`DayTripInfoEntity`), which calls the `/tripinfo` endpoint — the same data
source the Bluelink app's own trip history uses, entirely independent of
status polling. Node-RED presses that button once per Creta arrival (not on
a timer) via new nodes `sec_creta_trip_refresh_gate` →
`sec_refresh_creta_trip_info`, gated on `arrival_source_type === "creta"`
in `sec_detect_arriving_source`. Full writeup:
[[project-creta-kia-uvo-integration]] (docs/CRETA_KIA_UVO_INTEGRATION.md).

**Ownership note:** unlike `nodered/flows.json` (owned by `gabriel`,
directly editable), `homeassistant/custom_components/kia_uvo/*` is owned by
`root` (HA container runs as root, host has no user-namespace remapping) —
the plain host user can't write it directly. Workaround used: write a
small Python patch script to a writable scratch path, `docker cp` it into
the container, then `docker exec -u 0 homeassistant python3 <script>` to
apply it as root (the bind mount means this writes straight back to the
repo path). Verify with `docker exec homeassistant python3 -m py_compile
<file>` before restarting. New entities in this integration get their
entity_id auto-prefixed with the device's area (`garagem_creta_...`) since
the `garagem` area was set on the Creta device after the original entities
were created — older entities kept their short `creta_*` IDs. Didn't touch
the entity registry to reconcile this; just used the real (prefixed)
entity_ids going forward.
