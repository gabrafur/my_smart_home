# Bootstrap, optional modules, and synthetic demo

[Português](BOOTSTRAP_DEMO.md)

## Reproducible bootstrap

The public reviewer path is:

```bash
git clone https://github.com/gabrafur/my_smart_home.git smart-home
cd smart-home
make bootstrap
make validate-public
make demo
make demo-test
```

These commands create only ignored templates in the clone, run the canonical
public contract, and execute the in-memory scenario. They do not start the
Compose stack.

In a clean public clone, validate first:

```bash
make bootstrap-test
node scripts/modules-check.mjs
```

Then, after authorizing private-file creation in the clone:

```bash
make bootstrap
# or
MODULES=core,zigbee,appdaemon make bootstrap
```

`scripts/bootstrap.mjs` reads `bootstrap/bootstrap-manifest.json`, copies only
public templates to ignored destinations, and randomly generates only technical
secrets that are safe to generate automatically. It never invents
operator-selected passwords, coordinates, identities, or service credentials.

Existing files are preserved byte-for-byte and private-destination symlinks are
rejected. Repeated runs are idempotent. Output contains only known paths,
modules, tool availability, and manual gaps — never generated values.

Bootstrap does not start containers. Mosquitto credentials, the Node-RED admin
hash, installation-specific placeholders, and agent authentication remain
manual steps.

## Core and modules

`modules/features.json` defines the minimum core:

```text
core
├── homeassistant
├── nodered
└── mosquitto
```

Optional modules are `zigbee`, `vehicle`, `alarm`, `alexa`, `localtuya`,
`matter`, `portainer`, `appdaemon`, `local-ai`, `agent-bridge`,
`raspberry-specific`, and `automation`. Each declares dependencies, services,
configuration, and safe degradation.

For fresh clones, `compose.modules.yml` adds profiles without changing the
historical behavior of `docker-compose.yml`:

```bash
# validate the core and project structure only
docker compose --env-file .env.example \
  -f docker-compose.yml -f compose.modules.yml config --quiet

# later example, after private state is ready; bootstrap does not run this
docker compose -f docker-compose.yml -f compose.modules.yml \
  --profile zigbee --profile matter up -d
```

The main Compose file still starts the current services when used by itself. In
the overlay, Matter is no longer a hard Home Assistant dependency, so omitting
it does not block core.

Integrations implemented inside Home Assistant/Node-RED use bindings and fail
safely when their module is not configured. The architecture does not rename
entities, edit registries, or migrate state automatically.

## Synthetic demo

```bash
make demo
make demo-test
```

`demo/scenario.json` and `demo/engine.mjs` simulate in memory:

- logical-role presence and arrival;
- a logical security request;
- arrival lighting and timeout;
- storage pressure and recovery;
- Internet and Zigbee failure/recovery;
- alert deduplication without a second notification;
- stale/out-of-order health-event rejection;
- serialization and reload of synthetic state across a simulated restart;
- alerts, recoveries, and observability metrics.

Every generated action has `simulated: true` and `dispatched: false`. The engine
imports no HTTP, network, MQTT, subprocess, or household client; it uses no
credentials, coordinates, or entity IDs. Tests replace `fetch` with a failure,
inspect imports, prove no real route is called, and keep the
[published example output](demo-output.md) byte-identical to the formatter. The
restart is an in-memory model.

## AI context

The canonical prompt is `prompts/restore-smart-home.prompt.md`. After identifying
the correct commit:

```bash
node scripts/ai-context-recovery.mjs --commit <commit>
```

During development, `make context-recovery-check` checks the tracked
worktree/index. Private runtime is never an automatic source. Use
`knowledge_not_versioned` when required knowledge has not yet been converted to
sanitized public documentation.
