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

Public `device_tracker` aliases use `state_mode: passthrough` so named zones
remain intact. When a resident has multiple GPS sources, Home Assistant exposes
only single-source aliases such as `device_tracker.mobile_primary_source_1` and
`_source_2`; `public_bindings` does not select or consolidate them. The visual
blocks in Node-RED's `localizacao_pessoas` tab own the single decision: location
freshness, reliable coordinates, material recency, accuracy, and valid state.
Node-RED publishes the result over MQTT as
`device_tracker.resident_primary_location` and
`device_tracker.resident_secondary_location`, with
`decision_owner: node_red`.

The native Map panel omits entities whose current state is `home`. The
`dashboards/location.yaml` file therefore uses a `map` card with
`show_all: true`, automatically including every current or future entity that
exposes a numeric location, including entities at home. Display names and
public source labels stay in private bindings; the vehicle is shown as `Creta`.

The adapter keeps `location_observed_at` separate from `source_reported_at` on
each alias: battery or metadata changes can prove that a source is reporting,
but they do not refresh a GPS position. The original heartbeat is propagated
through aliases and the position timestamp is recovered from Recorder history
at startup by comparing only state, coordinates, and accuracy.

Node-RED publishes the winning `selected_location_source`, a sanitized
`location_sources` list, and the already-computed `position_fresh`,
`reporting_fresh`, and `reliable_coordinates` results. Map cards only display
those values and contain no timing windows or selection algorithm. Source
aliases use `hide_targets: true` and string coordinates, remaining available to
the flow without producing duplicate visual markers.

All `vehicle_primary` bindings also use `hide_targets: true`. Native Bluelink
entities remain active as internal targets, while the input alias
`device_tracker.vehicle_primary` exposes string coordinates only to Node-RED.
The map and dashboard use the numeric
`device_tracker.vehicle_primary_location_nodered` output published by the same
flow that decides movement and `location_since`, avoiding duplicate markers.
Bindings used only to resolve an action may set `expose_state: false`. Their
public IDs remain available internally to `target_public_entity_id` without
creating a second visible button. Vehicle refresh uses this mode, so the UI
shows only the `input_button` routed through the single coordinator.

The `consolidated_map` component idempotently applies that same YAML file to
the native `/map` dashboard during startup. The file is not registered as a
second sidebar panel: the native Map tab is the only exposed interface. Its
status and health cards accept only entities carrying
`decision_owner: node_red`, so they implement neither source selection nor
freshness decisions.

Intermediate aliases consumed by `localizacao_pessoas` and
`contexto_vehicle_primary` keep `latitude`,
`longitude`, and `gps_accuracy` in `string_attributes`. Node-RED explicitly
normalizes them with `Number(...)`, while the Map frontend accepts only numeric
coordinates as a location. This keeps Mobile App and iCloud from appearing as
additional markers without removing their data from the normalizer. The
normalizer uses `location_observed_at`, never generic `last_updated`, to decide
freshness and precedence between sources. Source heartbeat is evaluated
separately to recognize an active stationary source without authorizing an
arrival from old coordinates.

`person.*` entities are not materialized in the Map card: each resident's
position is represented only by the canonical Node-RED tracker. Zones and the
trackers feeding those person entities remain excluded as well.

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
