# Public/private boundary

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

Validate the public example or a private file without printing values:

```bash
node scripts/public-bindings-check.mjs
node scripts/public-bindings-check.mjs --private bindings/private/private-bindings.json
```

`entities`, `services`, `topics`, and `mqtt_topics` are optional per role.
Entities require a target; services require a target service; MQTT topics
require valid keys and payloads. The public example contains all eight required
roles.

## Home Assistant consumption

`homeassistant/custom_components/public_bindings` reads the private file and:

- projects state onto public role-based IDs;
- copies only explicitly allowlisted attributes;
- normalizes presence and boolean state when configured;
- forwards allowlisted actions through `public_bindings.call`.

A missing file, invalid version, disabled role, or unconfigured action produces
no proxy/action. The adapter fails closed and does not expose the private target
in public attributes.

## Node-RED consumption

`nodered/settings.js` merges JSON documents from the private directory into the
`publicBindings` global context. Gate, lighting, and notification Functions read
that context; static MQTT nodes receive only variables derived from bindings. A
missing binding blocks the command or leaves the node without a real topic,
preserving safe degradation.

## Bootstrap and restoration

1. Copy `bindings/private-bindings.example.json` into the private directory.
2. Replace only placeholders with installation targets.
3. Keep restrictive permissions and confirm that the files remain ignored.
4. Run the private checker and public scanners.
5. Validate Compose with `.env.example` and `config --quiet`.
6. Perform operational activation separately, with local approval and rollback.

Optional modules may remain `enabled: false` or unbound. Public logic does not
assume that a vehicle, second resident, gate, or exterior lighting is available.

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
