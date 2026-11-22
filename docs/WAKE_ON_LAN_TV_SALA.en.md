# Explicit Wake-on-LAN for the living room TV (Samsung QN90BA)

[Português (principal)](WAKE_ON_LAN_TV_SALA.md) · [English](WAKE_ON_LAN_TV_SALA.en.md)

## Background

Home Assistant's `samsungtv` integration used to send a Wake-on-LAN magic packet whenever something called `media_player.turn_on` for a Samsung TV with a known MAC address. Home Assistant deprecated this implicit behavior in 2026.2 and removed it in the 2026.8 release series (repair issue `implicit_wake_on_lan`).

For the living room TV (`media_player.samsung_qn90ba_50_qn50qn90bagxzd`), dashboards, Alexa, Google Home, and automations that call `media_player.turn_on` now need an explicit automation to wake the TV.

## Configuration

1. In `homeassistant/configuration.yaml`, enable `wake_on_lan:` to make the `wake_on_lan.send_magic_packet` service available. This setup's `default_config:` did not include it.
2. In `homeassistant/automations.yaml`, the `Wake TV Sala via Wake-On-LAN` automation listens for the integration's native `samsungtv.turn_on` trigger on the TV entity. It sends the magic packet to the TV's MAC address, stored as `tv_sala_mac` in `secrets.yaml`. Keep that file outside this public repository.

```yaml
- id: "1783799940000"
  alias: Wake TV Sala via Wake-On-LAN
  triggers:
    - trigger: samsungtv.turn_on
      entity_id: media_player.samsung_qn90ba_50_qn50qn90bagxzd
  actions:
    - action: wake_on_lan.send_magic_packet
      data:
        mac: !secret tv_sala_mac
  mode: single
```

> **Edit this automation directly in YAML.** Saving in the Home Assistant automation editor rewrites the entire `automations.yaml` file and replaces `!secret` with the actual MAC address, exposing it in the version-controlled file.

## Why use this trigger?

The `samsungtv.turn_on` trigger fires whenever something asks Home Assistant to turn on the `media_player` entity. The integration provides this trigger as the supported replacement for implicit Wake-on-LAN. A `state` trigger would miss the request because a powered-off TV stays in the same state until something wakes it.

## Apply the change

**Restart the `homeassistant` container** after adding `wake_on_lan:`. Home Assistant loads the integration at startup. Developer Tools can reload the automation, but the `wake_on_lan.send_magic_packet` service becomes available only after the restart.

The original configuration check completed without errors:

`docker exec homeassistant python3 -m homeassistant --script check_config -c /config`

## References

- The device MAC address was verified in the `samsungtv` entry in `.storage/core.config_entries` (host placeholder: `IP_DA_TV`).
- https://www.home-assistant.io/integrations/wake_on_lan/
- https://www.home-assistant.io/integrations/samsungtv/
