# Smart-home installation and restore

[Português (primary)](INSTALACAO_RESTAURACAO_SMART_HOME.md) · [English](INSTALLATION_RESTORE.en.md)

This runbook rebuilds the stack on a Linux host from versioned content and,
when available, a private backup. It assumes no specific username, IP address,
or absolute checkout path.

## Canonical deterministic workflow

The private-state inventory, bundle format, checksums, order, and rollback are
defined in [RESTORE_CONTRACT.en.md](RESTORE_CONTRACT.en.md). For fresh clones,
modules, and the demo, see [BOOTSTRAP_DEMO.en.md](BOOTSTRAP_DEMO.en.md).

```bash
make backup-plan
make restore-test
make bootstrap-test
make demo-test
```

With an external bundle, run `restore-plan` and `restore-verify` before asking
for authorization for any apply. These commands do not start containers.

## 1. What a clone can restore

There are two possible outcomes:

- **Fresh installation:** containers start and declarative configuration is
  loaded, but users, devices, credentials, and networks must be enrolled again.
- **Restore:** the clone is combined with a secure private backup, preserving
  compatible identities and runtime state.

Git is never a complete house backup. An existing Zigbee network depends on its
original key, PAN IDs, database, and coordinator backup; a Matter fabric
depends on `matter-server/`; and Home Assistant relies on `.storage/` for users,
registries, and UI-configured integrations.

## 2. Requirements

- A recent Debian, DietPi, or Raspberry Pi OS Linux host;
- Docker Engine 23 or newer and the Docker Compose plugin;
- Git, Node.js, npm, OpenSSL and, for diagnostics, `jq`, ripgrep, and Mosquitto
  clients;
- internet access to pull images and build the bridge;
- `/usr/bin/vcgencmd` for Raspberry Pi host metrics;
- D-Bus plus working IPv6/mDNS for Bluetooth/Matter.

Home Assistant Container does not include Supervisor or apps/add-ons. Services
that would be add-ons on Home Assistant OS are explicitly managed by this
repository's Compose stack.

On Debian, install the basic packages:

```bash
sudo apt-get update
sudo apt-get install -y git nodejs npm openssl jq ripgrep mosquitto-clients
```

Install Docker from the official repository for your distribution and verify:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Add the operational user to the Docker group, then open a new session:

```bash
sudo usermod -aG docker "$USER"
```

> Docker socket access grants administrative capability on the host. Limit the
> `docker` group, Portainer, and the bridge to trusted users.

## 3. Clone

Choose a persistent path with enough space for databases and backups:

```bash
git clone REPOSITORY_URL smart-home
cd smart-home
export REPO_DIR="$PWD"
```

Compose mounts and operational scripts are repository-relative;
`/mnt/data/docker` is no longer required.

On non-Raspberry Pi hardware, remove or comment the `/usr/bin/vcgencmd` bind in
the `homeassistant` service and disable sensors that depend on it.

## 4. Private files

| Path | Fresh installation | Restore |
| --- | --- | --- |
| `.env` | copy the example and generate values | restore or review backup |
| `homeassistant/secrets.yaml` | copy and fill the example | restore |
| `homeassistant/.storage/` | created by onboarding | restore as a whole while HA is stopped |
| `.local-secrets/appdaemon-secrets.yaml` | copy the example | restore |
| `mosquitto/config/password.txt` | create with `mosquitto_passwd` | restore or rotate |
| `zigbee2mqtt/configuration.yaml` | copy the example | restore with existing network |
| Zigbee2MQTT database and coordinator backup | service-created | restore |
| `nodered/flows_cred.json` | created when credentials are configured | restore with the same credential secret |
| `matter-server/` | service-created | restore whole volume |
| `portainer/` | new onboarding | restore whole volume |

All these paths are Git-ignored. Verify before continuing:

```bash
git check-ignore .env homeassistant/secrets.yaml .local-secrets/appdaemon-secrets.yaml
git check-ignore nodered/flows_cred.json zigbee2mqtt/configuration.yaml
```

## 5. Prepare `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Edit:

- `HOST_LAN_IP`: a stable LAN address. Keep it empty or use `127.0.0.1` while
  preparing a host that should not yet be reachable on the LAN;
- `DOCKER_GID`: output of `stat -c '%g' /var/run/docker.sock`;
- `TZ`: an IANA time zone;
- arrival-flow coordinates only when that automation is used;
- bridge tokens only when the feature is enabled;
- for the weekly review, the checkout owner's `REPO_UID`/`REPO_GID` and
  absolute paths to a dedicated repository-scoped push key and `known_hosts`.

Generate the shared bridge token, then paste it into
`CLAUDE_BRIDGE_TOKEN` without printing `.env` afterward:

```bash
openssl rand -hex 32
```

For subscription-based Claude Code, generate OAuth credentials as described in
the Portuguese [agent bridge guide](CHAT_CLAUDE_CODE_HA.md). No
`ANTHROPIC_API_KEY` needs to remain in `.env`.

Prepare Node-RED authentication:

```bash
node scripts/setup-node-red-security.mjs
```

The script supports a fresh clone: it creates the credential secret, bcrypt
hash, and admin password when no previous runtime exists. The readable password
is stored only in `.local-secrets/node-red-admin-password.txt`.

When conventional SSH files exist, the same helper fills their paths and the
checkout UID/GID without copying credentials into the repository. Authenticate
Codex in the bridge volume before enabling the scheduler. See the complete
[weekly documentation review guide](WEEKLY_DOCUMENTATION_REVIEW.en.md).

## 6. Home Assistant and AppDaemon

```bash
cp homeassistant/secrets.yaml.example homeassistant/secrets.yaml
cp templates/appdaemon/secrets.yaml.example .local-secrets/appdaemon-secrets.yaml
chmod 600 homeassistant/secrets.yaml .local-secrets/appdaemon-secrets.yaml
```

Fill coordinates and integrations actually in use. Disable the Moni Mobile
package when that provider is not used; `CHANGE_ME` values identify incomplete
setup and are not production values.

AppDaemon coordinates belong in `.local-secrets/appdaemon-secrets.yaml`.
Compose mounts that file and `templates/appdaemon/appdaemon.yaml` read-only on
top of the runtime volume, avoiding both disclosure and ownership problems.

During a restore, copy `.storage/` and the database only while Home Assistant
is stopped. Preserve ownership and permissions from the backup.

## 7. Mosquitto

Anonymous access is disabled, and the broker needs a password file. For a fresh
installation, use the same username as `MQTT_USER`:

```bash
mkdir -p mosquitto/data mosquitto/log
docker run --rm -it --user root \
  -v "$PWD/mosquitto/config:/mosquitto/config" \
  eclipse-mosquitto@sha256:6f8d8a947c506f8a2290ec65cd4bd2bc7cb4d43fb5f6271f861cb013e2ef9797 \
  mosquitto_passwd -c /mosquitto/config/password.txt smart_home
chmod 600 mosquitto/config/password.txt
```

Replace `smart_home` when using a different `MQTT_USER`. Configure the same
username/password in Zigbee2MQTT, Home Assistant, and Node-RED MQTT nodes.

For a restore, prefer copying `password.txt`. Run
`scripts/rotate-mqtt-password.mjs` only after restoring every consumer it
updates; it is not a bootstrap tool for an empty clone.

## 8. Zigbee2MQTT

```bash
cp zigbee2mqtt/configuration.example.yaml zigbee2mqtt/configuration.yaml
chmod 600 zigbee2mqtt/configuration.yaml
```

Edit MQTT credentials, `serial.port`, `serial.adapter`, channel, and transmit
power. For a **new** network, keep `network_key`, `pan_id`, and `ext_pan_id` set
to `GENERATE`; Zigbee2MQTT writes random values at first startup. For an
**existing** network, restore the original values and coordinator backup.
Changing them can require pairing every device again.

`192.0.2.10` is documentation-reserved and must be replaced. Network adapters
need a stable address; USB adapters should use `/dev/serial/by-id/...` and a
Compose `devices:` mapping.

The `monitoramento_zigbee` flow assumes the `zigbee2mqtt` base topic and
requires availability in the private configuration:

```yaml
availability:
  enabled: true
```

Also confirm the targets in the `Notificar todos os dispositivos móveis`
subflow and run `npm --prefix nodered run flows:test-infrastructure`.
`binary_sensor.internet_connection` and `binary_sensor.zigbee_network` are
discovered through MQTT after Node-RED starts. See the
[infrastructure monitoring guide](ZIGBEE_HEALTH_NOTIFICATIONS.en.md).

## 9. Node dependencies

```bash
npm --prefix nodered ci
npm --prefix nodered run flows:validate
npm --prefix nodered run test:all
npm --prefix ia-bridge test
```

`node_modules/` is not versioned and is rebuilt with `npm ci`.

## 10. Validate and build

Expanded `docker compose config` output can include `.env` values. Prefer the
quiet form, especially in shared logs:

```bash
docker compose config --quiet
scripts/security-scan.sh
node scripts/docs-check.mjs
docker compose pull
docker compose build --pull claude-bridge
```

The first bridge build downloads APT and npm packages. Its base image and CLIs
are pinned; the Docker socket GID is applied at runtime through `group_add`.

## 11. Start and inspect

```bash
docker compose up -d
docker compose ps
```

`depends_on` does not wait for readiness. Review initial logs:

```bash
docker compose logs --tail=100 mosquitto zigbee2mqtt
docker compose logs --tail=100 homeassistant matter_server
docker compose logs --tail=100 nodered appdaemon
docker compose logs --tail=100 portainer claude-bridge
```

| Service | URL |
| --- | --- |
| Home Assistant | `http://HOST_IP:8123` |
| Node-RED | `http://HOST_IP:1880` |
| Zigbee2MQTT | `http://HOST_IP:8080` |
| Portainer | `http://HOST_IP:9000` |
| Bridge | `http://127.0.0.1:8099` |

Do not port-forward these services. Use a VPN with ACLs and MFA for remote
access. The bridge stays on loopback even when other services are on the LAN.

## 12. Fresh-install onboarding

1. Create the first Home Assistant user.
2. Configure Home Assistant MQTT with the Mosquitto credentials.
3. Configure the Home Assistant server and MQTT credentials in Node-RED; this
   creates `flows_cred.json`.
4. Confirm that `zigbee2mqtt/bridge/state` is `online`.
5. Configure Matter at `ws://127.0.0.1:5580/ws`, acknowledging standalone
   container limitations.
6. Create the Portainer user or restore its volume.
7. Configure the agent bridge only when needed; it has workspace and Docker
   socket access and is an administrative service.
8. When enabling the weekly review, confirm its next run in the log and run the
   scheduler guide's `--check` preflight.

Entities referenced by the supplied YAML/flows may not exist in another home.
Disable unused packages/tabs or adapt entity IDs.

## 13. Functional validation

```bash
docker exec homeassistant python3 -m homeassistant --script check_config --config /config
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' nodered
```

Test MQTT without putting a password in shell history; use an interactive
prompt or a protected file. Confirm that anonymous auth is rejected,
authenticated publish/subscribe works, Zigbee2MQTT is online, Node-RED requires
login, HA receives MQTT entities, infrastructure monitors load without false
startup recoveries, AppDaemon loads, and the bridge health endpoint is loopback-only.
The documentation scheduler should report its next run and pass preflight.

Automations that move a gate, disarm an alarm, start a vehicle, or cut power
require a controlled on-site test. Never include physical actuators in a generic
smoke test.

## 14. Private backup

With services stopped or using consistent snapshots, preserve `.env`, local
secrets, Home Assistant `.storage/` and selected databases, Node-RED
credentials, Mosquitto password/data, Zigbee2MQTT configuration/database/
coordinator backup, and the Matter and Portainer directories.
Also preserve the scheduler's dedicated SSH credential outside the checkout.

Encrypt before external storage, test restoration, and keep the key away from
the Raspberry Pi. Git, even private Git, is not the right storage for this data.

## 15. Updates

```bash
node scripts/docker-auto-update.mjs daily --dry-run
node scripts/docker-auto-update.mjs daily
```

The script resolves channel tags to digests, updates Compose, validates, and
recreates. Read upstream release notes for database or protocol migrations. Do
not replace the legacy Matter Server with the matter.js successor without a
specific fabric migration plan.

## 16. Troubleshooting

```bash
docker compose ps
docker compose logs --tail=200 SERVICE
docker compose config --quiet
git status --short
```

Common causes:

- **unavailable port:** verify `HOST_LAN_IP` belongs to the host;
- **bridge cannot access Docker:** fix `DOCKER_GID` and recreate only bridge;
- **Mosquitto rejects clients:** align the password file and all consumers;
- **Zigbee mismatch:** restore key/PAN IDs and backup from the same coordinator;
- **Node-RED credentials missing:** restore `flows_cred.json` with the same
  credential secret or reconfigure via UI;
- **Home Assistant asks for a new login:** `.storage/auth*` was not restored;
- **Matter discovery fails:** inspect IPv6, mDNS, D-Bus, and host networking;
- **`vcgencmd` missing:** adapt Compose for non-Raspberry Pi hardware.
- **scheduler refuses to run:** check the clean tree, branch, Codex login, Git
  key push access, and checkout UID/GID.

## 17. Final checklist

- Compose, Node-RED, bridge tests, security scan, and docs check pass;
- expected containers are running;
- administrative UIs are not internet-exposed;
- anonymous MQTT is disabled;
- private state remains ignored and has a tested encrypted backup;
- safety-critical physical actions were validated on site.
- the documentation scheduler is stopped or uses restricted credentials and
  has passed preflight.
