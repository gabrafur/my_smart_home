---
name: project-creta-kia-uvo-integration
description: kia_uvo custom_component internals (coordinator refresh semantics, BR API quirks, new trip-log sensor)
metadata:
  type: project
  originSessionId: ae3381ba-65f3-41b3-83d6-ffbd439ed626
---

`homeassistant/custom_components/kia_uvo/` is a local fork (not stock
HACS) wrapping `hyundai_kia_connect_api`'s `HyundaiBlueLinkApiBR` for the
Creta. Full technical writeup: docs/CRETA_KIA_UVO_INTEGRATION.md. See also
[[iluminacao-seguranca-flow]] for how the Node-RED side consumes these
entities.

**Refresh semantics (why data can be stale even when "working"):** the
coordinator (`coordinator.py`) does a genuinely live poll automatically
only once per 24h by default (`DEFAULT_FORCE_REFRESH_INTERVAL = 1440` min,
config entry `options: {}` = all defaults); every other poll
(`DEFAULT_SCAN_INTERVAL = 30` min) just reads Hyundai's server-side cache.
Real-time-ish data only comes from `button.creta_force_refresh`
(`async_force_refresh_vehicle`), which Node-RED presses on its own 1-5 min
cadence gated by "someone away" (see [[iluminacao-seguranca-flow]]).

**Why: engine on/off can't be reliably reconstructed from polling.**
Confirmed live 2026-07-10: `binary_sensor.creta_engine` never once recorded
"on" across two confirmed round-trips. The BR backend's
`/location/park` endpoint hard-400s while the car is moving (caught
silently by the lib) — same pattern likely applies to live status in
general, i.e. Hyundai's BR API may only reliably report fresh state around
parking events, not continuously while driving. Chasing this with tighter
polling risks account rate-limits/12V drain for uncertain payoff. Don't
try to fix engine-state history by polling harder — see the trip-log
sensor below instead.

**Fix — `sensor.garagem_creta_day_trip_info`:** wired the library's
already-implemented but previously-unused `/tripinfo` endpoint
(`update_day_trip_info` in both `HyundaiBlueLinkApiBR.py` and
`VehicleManager.py`) into a new entity. This is the *same data source* the
Bluelink app's own trip history uses (start time, distance, avg/max speed,
drive/idle time per trip) — independent of the sparse status polling
above, so it matches the app by construction rather than by luck. New
button `button.garagem_creta_refresh_trip_info` fetches today's trip list
on press; Node-RED presses it once per Creta arrival (not on a timer) via
`sec_creta_trip_refresh_gate` → `sec_refresh_creta_trip_info`, gated on
`msg.payload.arrival_source_type === "creta"` from
`sec_detect_arriving_source`. Deliberately not polled on the same cadence
as location/status — trip data only changes when a trip *ends*, so tying
it to the arrival event (not a timer) avoids extra Kia API load for no
benefit.

**Ownership / edit workflow for this directory specifically:**
`custom_components/kia_uvo/*` is owned by `root` (HA container runs as
root, no host UID remapping) — direct `Edit`/`Write` from the host user
fails with EACCES. Workflow that worked: write a Python patch script
(explicit old-string/new-string replacements, same shape as `Edit` calls)
to the scratch dir, `docker cp` it into the container, then
`docker exec -u 0 homeassistant python3 /tmp/<script>.py` to apply as root
— the bind mount (`./homeassistant:/config`) means this writes straight
back to the repo path, same as any other edit. Always
`docker exec homeassistant python3 -m py_compile <file>` before
restarting to catch syntax errors early. (This is a different situation
from `nodered/flows.json`, which — as of 2026-07-10 — turned out to be
directly `gabriel`-owned; see [[iluminacao-seguranca-flow]].)

**Entity ID quirk:** the Creta device has `area_id: garagem` in
`core.device_registry`. New entities created after that area was set get
their entity_id auto-prefixed with it (`garagem_creta_refresh_trip_info`,
`garagem_creta_day_trip_info`), while entities created earlier kept short
IDs (`creta_force_refresh`, `creta_engine`, etc.) since HA doesn't rename
existing registry entries when the device's area changes later. Didn't
reconcile this (would mean editing the live entity registry) — just used
whatever entity_id HA actually assigned. Check
`core.entity_registry`/`core.device_registry` for the real current ID
before wiring any new automation to a `kia_uvo` entity; don't assume the
`creta_*` short-name convention holds for anything created after
2026-07-10.
