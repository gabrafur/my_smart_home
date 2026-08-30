# Public/private boundary

[English](PUBLIC_PRIVATE_BOUNDARY.en.md) · [Português](PUBLIC_PRIVATE_BOUNDARY.md)

This boundary makes the public architecture restorable without coupling its
logic to a specific household.

## Files and configuration flow

| Type | Path | Git |
| --- | --- | --- |
| schema | `bindings/public-bindings.schema.json` | tracked |
| synthetic example | `bindings/private-bindings.example.json` | tracked |
| real entities and services | `bindings/private/private-bindings.json` | ignored |
| real MQTT topics | `bindings/private/node-red-bindings.json` | ignored |

Compose mounts `bindings/private/` at `/run/private-bindings`, read-only, in the
Home Assistant and Node-RED containers. No binding depends on `.storage`, edits
registries, or automatically migrates an `entity_id`.

Keep private JSON documents at mode `0640` and set `PRIVATE_BINDINGS_GID` in
`.env` to the files' owning GID. Node-RED receives that supplementary group for
read-only access. If a document exists but is unreadable or contains invalid
JSON, the runtime now fails explicitly at startup instead of starting with
literal/inactive MQTT topics.

Validate the public example or a private file without printing values:

```bash
node scripts/public-bindings-check.mjs
node scripts/public-bindings-check.mjs --private bindings/private/private-bindings.json
```

`entities`, `services`, `topics`, and `mqtt_topics` are optional per role.
Entities require a target; services require a target service; MQTT topics
may be strings when the flow itself sets the payload, or objects containing
`topic`, `payload_on`, and `payload_off` when the binding also defines the
command. The Node-RED loader normalizes strings to `{ topic }`. The public
example contains all eight required roles.

## Home Assistant consumption

`homeassistant/custom_components/public_bindings` reads the private file and:

- projects state onto public role-based IDs;
- copies only explicitly allowlisted attributes;
- normalizes presence and boolean state when configured;
- forwards allowlisted actions through `public_bindings.call`.

Simple pushes use `notify.send_message` with a `notify.*` entity; that service
accepts only a title and message. Buttons, tags, and `clear_notification` use
the logical `notify_actionable` action, whose private target is the
device-specific legacy Mobile App service. Only this action may target a
`notify.mobile_app_*`, keeping mobile parameters functional without exposing
the private service name in flows.

A missing file, invalid version, disabled role, or unconfigured action produces
no proxy/action. The adapter fails closed and does not expose the private target
in public attributes.

## Node-RED consumption

`nodered/settings.js` merges JSON documents from the private directory into the
`publicBindings` global context. Gate, lighting, and notification Functions read
that context; static MQTT nodes receive only variables derived from bindings. A
missing binding blocks the command or leaves the node without a real topic,
preserving safe degradation.

In the authenticated editor, `nodered/tools/nodes/private-flow-labels.*`
projects the private `source_alias` values onto the headers of the two
resident-approach notification nodes. This projection is visual only, uses a
`no-store` response, and does not change the editor model:
`nodered/flows.json`, exports, and deploys continue to contain only
`resident_primary` and `resident_secondary`. If either alias is missing, the
public labels remain unchanged.

## Bootstrap and restoration

1. Run `make bootstrap-test` and, when authorized, `make bootstrap`.
2. Replace only placeholders with installation targets.
3. Keep files at `0640`, set `PRIVATE_BINDINGS_GID`, and confirm that they remain
   ignored.
4. Run the private checker and public scanners.
5. Use `restore/private-state-manifest.yaml` as the private-backup authority and
   validate bundles with `restore-verify`.
6. Validate Compose with `.env.example` and `config --quiet`.
7. Perform operational activation separately, with local approval and rollback.

Optional modules may remain `enabled: false` or unbound. Public logic does not
assume that a vehicle, second resident, gate, or exterior lighting is available.

The full contract is in [RESTORE_CONTRACT.en.md](RESTORE_CONTRACT.en.md), and
module selection is documented in [BOOTSTRAP_DEMO.en.md](BOOTSTRAP_DEMO.en.md).

## Compatibility and future renaming

Bindings preserve existing real IDs and avoid automatic registry changes. A
future physical entity migration is a separate project and must include a
consumer inventory, change order, backup, rollback, before/after tests,
availability risks, and on-site approval. This stage does not perform that
migration.

## Limitations

- The schema validates shape and roles, not target existence in an installation.
- Binding updates require explicit validation and operational activation.
- The Home Assistant proxy is runtime-only; it does not rename or recreate
  entity-registry entries.
- Private files belong in the installation's private backup and never in the
  public package.
