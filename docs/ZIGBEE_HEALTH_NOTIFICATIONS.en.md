# Zigbee network health alerts

[Português (primary)](ZIGBEE_HEALTH_NOTIFICATIONS.md) ·
[English](ZIGBEE_HEALTH_NOTIFICATIONS.en.md)

This guide documents
`homeassistant/packages/zigbee_health_notifications.yaml`. The package alerts
on Zigbee2MQTT bridge failures and on any component whose availability is
published over MQTT.

## Prerequisites

- the MQTT integration loaded in Home Assistant;
- Zigbee2MQTT Home Assistant integration enabled;
- `mqtt.base_topic: zigbee2mqtt` in the private configuration;
- device availability enabled:

```yaml
availability:
  enabled: true
```

Zigbee2MQTT disables availability by default. With its default settings, an
active device is marked offline after 10 minutes without communication and a
passive, typically battery-powered, device after 25 hours. These timers belong
to Zigbee2MQTT, not to the Home Assistant package.

The package also expects
`binary_sensor.zigbee2mqtt_bridge_connection_state`, normally created by MQTT
discovery. Adapt the entity ID when an installation uses a different name.

## Behavior

### Network failure

`zigbee_network_failure_notification` waits for 30 seconds of `off` or
`unavailable`. It also checks the state 30 seconds after Home Assistant starts.
On failure, it:

1. creates or updates `zigbee_network_failure` in persistent notifications;
2. attempts push delivery to the configured `notify.*` entities;
3. waits until the bridge has remained `on` for one minute;
4. dismisses the failure and reports recovery.

Recovery belongs to the same run that recorded the failure. Starting Home
Assistant while the bridge is already online therefore does not produce a
false “network recovered” message.

### Component failure

`zigbee_component_failure_notification` watches for `offline` messages under
`zigbee2mqtt/.../availability`. Its wildcard automatically covers new devices
and hierarchical friendly names such as `kitchen/light`.

For every offline component, the automation creates an alert, attempts push
delivery, and waits for `online` on that exact topic before reporting recovery.
Up to 100 waits may run in parallel; this bounds resource use if the setup is
incorrect.

Availability topics are retained by the broker. Tying recovery to a run that
started with `offline` is deliberate: reloading automations does not turn
retained online states into false recovery alerts, while actually offline
devices recreate their warning.

## Notifications and portability

Persistent notifications are visible to all Home Assistant users. Pushes use
the `notify.*` targets listed in the package; replace them with entities from
the cloned installation.

Push actions set `continue_on_error: true`, so a missing phone cannot prevent
persistent alerts from being created, updated, or dismissed. Entity names are
operational identifiers. Coordinator addresses, MQTT credentials, and physical
device identifiers must not be added to this public file.

## Installation and restore

1. Restore or create `zigbee2mqtt/configuration.yaml` from the example.
2. Confirm `homeassistant.enabled`, the base topic, and `availability.enabled`.
3. Adapt the bridge sensor and `notify.*` targets in the package.
4. Validate the Home Assistant configuration.
5. Restart Home Assistant or reload automations.
6. Confirm that Zigbee2MQTT publishes device `online`/`offline` states.

The package has no database of its own. Relevant persistent state remains in
the private Zigbee2MQTT configuration and database. After a restart, retained
MQTT messages recreate waits for devices that are still offline.

## Safe validation

```bash
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
docker compose logs --tail=100 homeassistant zigbee2mqtt mosquitto
```

For an end-to-end test, use an authenticated MQTT client and a fictional
device topic below `zigbee2mqtt/.../availability`: publish
`{"state":"offline"}` and then `{"state":"online"}` as retained messages,
and delete the test topic afterwards. Do not interrupt a real coordinator just
to test a notification.

## Troubleshooting

- **No component alert:** check `availability.enabled`, the base topic, and
  Home Assistant's MQTT connection.
- **Network alert is always active:** check the bridge entity and
  `zigbee2mqtt/bridge/state`.
- **Persistent alert works but push does not:** replace the `notify.*` targets
  and test `notify.send_message` in Developer Tools.
- **Many devices are offline after long maintenance:** retained offline states
  are expected; let passive devices wake before changing their timeouts.
- **A name is truncated:** use the current package, which preserves friendly
  names containing `/`.

## Official references

- [Zigbee2MQTT device availability](https://www.zigbee2mqtt.io/guide/configuration/device-availability.html)
- [Zigbee2MQTT MQTT topics](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html)
- [Home Assistant MQTT triggers](https://www.home-assistant.io/docs/automation/trigger/#mqtt-trigger)
- [`notify.send_message`](https://www.home-assistant.io/actions/notify.send_message/)
