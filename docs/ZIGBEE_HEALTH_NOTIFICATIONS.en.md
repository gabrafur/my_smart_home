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
`notify.iphone_de_gabriel_furlan` and `notify.iphone_de_valeria`. Recovery also
dismisses the prior failure alert. Home Assistant calls use the connector's
`all` queue during short HA restarts.

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

`nodered/settings.js` uses `localfilesystem` as the default context store with
a 15-second flush, while `memoryOnly` holds execution locks and raw observations
that retained MQTT recreates. `nodered/status` has retained birth, clean-close,
and last-will values, making the HA entities unavailable when Node-RED leaves
MQTT.

An online startup does not announce recovery. An offline startup is detected
normally. A restart during a persisted incident does not duplicate failure and
can later confirm recovery. Retained discovery/state rebuilds entities after an
HA restart. Zigbee2MQTT startup transients must cross the 30-second threshold.
The residual risk is an abrupt crash within the 15-second context flush window,
which can lose the latest transition and, in the narrow notification-before-
flush case, repeat an alert.

## Validation and limitations

```bash
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:test-infrastructure
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
```

Automated tests cover quorum, consecutive failures, deduplication, oscillation,
recovery, duration, second outages, persisted restart behavior, Zigbee startup,
30/60-second thresholds, and component cycles. A safe end-to-end component
test can publish retained offline then online values to
`zigbee2mqtt/teste_monitor/availability` and clear the retained value afterward.

Physical WAN cuts, router/coordinator restarts, and delivery to both phones
require a controlled on-site window. ICMP filtering by all three targets remains
possible. During the WAN outage, the local persistent alert can be created
immediately while the mobile push may only arrive after connectivity returns.
