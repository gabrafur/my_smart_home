# MQTT metadata observer — source candidate

This directory contains the fixed Root reader, durable metadata accounting,
socket-activation contract, data-only recovery helpers and native producer.
These sources do not install or activate a service. The Node-RED policy defaults
to `enabled: false`; permanent source access needs separate owner approval.

See [the operational contract](../../../../docs/MQTT_SOURCE_OBSERVER.md) for
data boundaries, build provenance, installation prerequisites, testing,
revocation, recovery and acceptance limits.

Portable protocol and filesystem tests run without privilege:

```sh
python3 -I -S -B -m unittest discover \
  -s scripts/raspberry-mcp/runtime-source/mqtt-observation -p 'test_*.py'
```

Ownership fixtures explicitly skip on an ordinary account. Run them only in
an isolated Root test runner; this command never escalates privileges.
Native broker and Node-RED acceptance uses owned containers without a network
or residential mounts. A green unit suite is not production acceptance.
