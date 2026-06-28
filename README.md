# My Smart Home

Configuration backup for the local smart-home stack:

- Home Assistant
- Node-RED
- Mosquitto
- Zigbee2MQTT
- AppDaemon
- Portainer compose definition

Sensitive runtime files are intentionally ignored, including Home Assistant secrets/auth/cookies, SQLite databases, backups, Node-RED credentials, Mosquitto passwords, Portainer state, and Zigbee2MQTT network keys.

On a new Raspberry Pi, restore the ignored secrets from a secure backup before starting the containers.
