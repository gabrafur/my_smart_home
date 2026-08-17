# Infrastructure monitoring in Node-RED

[Português (primary)](ZIGBEE_HEALTH_NOTIFICATIONS.md) ·
[English](ZIGBEE_HEALTH_NOTIFICATIONS.en.md)

The `monitoramento_zigbee` and `monitoramento_internet` flows in
`nodered/flows.json` are the source of availability decisions. Home Assistant
exposes retained MQTT-discovery entities and runs notification services; it no
longer detects, confirms, or closes these incidents. The former
`homeassistant/packages/zigbee_health_notifications.yaml` package was removed.

## Shared architecture and notifications

Both tabs read left to right: trigger, collection, state/confirmation,
failure/recovery, notification, and retained MQTT publication. The shared
`Notificar todos os dispositivos móveis` subflow creates a persistent Home
Assistant notification and sends the same message to
the logical roles `mobile_primary` and `mobile_secondary` through
`public_bindings.call`. Recovery also
dismisses the prior failure alert. Home Assistant calls use the connector's
`all` queue during short HA restarts. That connector queue does not retain a
mobile push merely because the WAN is down.

The input contract, also shown in the subflow's visual documentation, is
`msg.notification = { id, title, message, dismiss_id? }`. The first three
strings are required. The subflow only validates and distributes the message;
state, retry, and deduplication remain in the calling monitor.

### Mobile push during a WAN outage

Node-RED can still call Home Assistant over the LAN, and the independent
persistent-notification branch creates the local alert. If a phone has an active
Home Assistant Companion Local Push/WebSocket connection on the LAN, local
delivery can work without WAN. Otherwise Mobile App delivery requires the
external push service and internet access. Home Assistant waits briefly for a
local acknowledgement before remote fallback; a failed remote request is logged
but is not kept in a durable queue for retry when WAN returns.

Recovery is a new notification. A down push that failed inside Home Assistant
is not later resent, so normally only recovery reaches the remote channel. If an
external provider had already accepted the down message, or the phone delays its
display, user-visible ordering still cannot be guaranteed. The Mobile App
contract provides no display acknowledgement or ordering control, so this is a
documented limitation rather than a custom retry mechanism.

## Internet monitor

Every 30 seconds one locked cycle pings three literal IP addresses in parallel:

- `1.1.1.1` (Cloudflare);
- `8.8.8.8` (Google);
- `9.9.9.9` (Quad9).

At least two replies are required, so DNS and one failed provider do not cause
an outage. Fixed `/bin/ping` arguments, a three-second timeout, and a volatile
execution lock limit concurrency to three processes and prevent overlapping
cycles.

The addresses were checked against the official
[Cloudflare 1.1.1.1](https://developers.cloudflare.com/1.1.1.1/),
[Google Public DNS](https://developers.google.com/speed/public-dns/), and
[Quad9](https://docs.quad9.net/services/) documentation.

The states are `online`, `checking`, `offline`, and `recovering`. Three failed
cycles confirm an outage; two successful cycles confirm recovery. A failure
during recovery returns to offline without another alert. With the current
cadence, confirmation takes about 60–90 seconds and recovery 30–60 seconds.
Checks continue every 30 seconds while offline. One incident produces one down
and one recovery notification, and recovery includes the approximate duration.

MQTT discovery exposes `binary_sensor.internet_connection` and
`sensor.internet_connection_state`, including counters, responding targets,
last valid ping, last outage, last recovery, and outage duration as attributes.

## Zigbee monitor

Bridge health comes directly from `zigbee2mqtt/bridge/state` plus MQTT broker
connection status. The previous criteria are preserved: 30 seconds offline
confirms failure and 60 seconds continuously online confirms recovery. A
retained online value at startup establishes a baseline without a recovery
alert. States are exposed through `binary_sensor.zigbee_network` and
`sensor.zigbee_network_state`.

Retained `zigbee2mqtt/.../availability` messages cover components, including
friendly names containing `/`. The first offline value opens one persisted
incident; duplicate offline values are ignored; the first later online value
produces one recovery; retained online at startup is silent.

Notification identifiers combine a readable slug with a stable hash of the
complete friendly name. Hierarchical names remain readable and distinct names
that normalize to the same slug cannot overwrite each other's alerts.

The legacy implementation alerted immediately after Zigbee2MQTT itself marked
a component offline. This was intentionally preserved. Its known weakness is
the lack of another grace period beyond Zigbee2MQTT availability timeouts
(commonly 10 minutes for active and 25 hours for passive devices). A short
per-device confirmation delay can be considered separately because it changes
alert latency.

Zigbee2MQTT still requires:

```yaml
availability:
  enabled: true
```

## Persistence and restarts

`nodered/settings.js` keeps `default`/`memoryOnly` volatile. Infrastructure
monitors explicitly select the named `persistent` `localfilesystem` store, with
a 30-second flush, for incidents, timestamps, counters, and deduplication.
Execution locks and raw observations recreated by retained MQTT remain in
memory. `nodered/status` has retained birth, clean-close, and last-will values,
making the HA entities unavailable when Node-RED leaves MQTT.

An online startup does not announce recovery. An offline startup is detected
normally. A restart during a persisted incident does not duplicate failure and
can later confirm recovery. Retained discovery/state rebuilds entities after an
HA restart. Zigbee2MQTT startup transients must cross the 30-second threshold.
The residual risk is an abrupt crash within the 30-second context flush window,
which can lose the latest transition and, in the narrow notification-before-
flush case, repeat an alert.

The worst case also includes restoring the previous incident state after a
crash immediately following a transition. A just-opened incident can then be
confirmed/notified again, or a just-closed incident can temporarily reappear,
until new observations repair state. A shorter flush reduces but cannot remove
that window.

## Validation and limitations

```bash
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:test-infrastructure
npm --prefix nodered run flows:test-infrastructure-runtime
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
```

Static automated tests cover quorum, consecutive failures, deduplication,
oscillation, recovery, duration, second outages, persisted restart behavior,
Zigbee startup, 30/60-second thresholds, and component cycles. The isolated
runtime test loads the exact Function bodies into Node-RED containers, exercises
flapping and ping concurrency/error paths, and performs real container restarts
against `localfilesystem`; it never connects to production MQTT or Home
Assistant. A safe end-to-end component test can publish retained offline then
online values to
`zigbee2mqtt/teste_monitor/availability` and clear the retained value afterward.

Physical WAN cuts, router/coordinator restarts, and delivery to both phones
require a controlled on-site window. ICMP filtering by all three targets remains
possible. During the WAN outage, the local persistent alert can be created
immediately. Without active Local Push, the mobile push depends on WAN and may
be dropped; Home Assistant does not guarantee later delivery.

## Partial physical-validation record (2026-08-13)

| Scenario | Test type | Observed result | Evidence summary | Status |
| --- | --- | --- | --- | --- |
| Physical WAN cut | Physical | Not completed | An attempt was invalidated by a host restart and loss of the temporary observer; the user cancelled the repeat to preserve the Codex session's connectivity. | PENDING |
| Real WAN recovery | Physical | Not run | There is no corresponding valid physical outage. | PENDING |
| Real router restart | Physical | Not run | A new window that permits loss of external connectivity is required. | PENDING |
| Real Zigbee2MQTT restart | Physical | Startup transient remained below the threshold, with no incident | `bridge/state` went offline at 19:52:24 UTC and returned online at 19:52:37 UTC (about 13 seconds); the monitor entered `checking`, restored retained state, and remained online for more than 90 seconds without an alert or false recovery. | PASS |
| Delivery to resident_primary's iPhone | Physical/manual | Not observed | No confirmed physical incident crossed its threshold. | PENDING |
| Delivery to resident_secondary's iPhone | Physical/manual | Not observed | No confirmed physical incident crossed its threshold. | PENDING |
| Notification ordering | Physical/manual | Not observed | Requires a valid WAN outage and manual observations from both phones. | PENDING |

The physical deployment also showed that Home Assistant 2026.x prefixed the
device name in suggested entity IDs despite `object_id`. All four discovery
payloads now declare `default_entity_id`; after republishing, the real entities
were registered exactly as `binary_sensor.internet_connection`,
`sensor.internet_connection_state`, `binary_sensor.zigbee_network`, and
`sensor.zigbee_network_state`. An automated test protects these IDs.

This is a partial record. The `PENDING` entries above are not passes, and the
pull request must remain a draft until an observable physical window completes
WAN, router, and mobile-delivery validation.
