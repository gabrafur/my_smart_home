# Deterministic backup and restore contract

[Português](RESTORE_CONTRACT.md)

## Authority and boundaries

`restore/private-state-manifest.yaml` is the versioned authority for private
state required to reconstruct an installation. It uses the JSON-compatible
subset of YAML 1.2 so plain Node.js can parse it deterministically. The manifest
is validated by `restore/schema.json`.

The manifest contains no private values. Each item declares a logical name,
component, module, relative or external source/destination, requirement,
criticality, owner, group, permissions, consistency mode, services that would
need to be stopped, dependencies, order, fresh-install/restore behavior,
checksum policy, validation, and Git policy.

Git remains authoritative for public code and configuration. The private bundle
is external, encrypted, and never belongs in the checkout. These commands do not
create a backup from runtime state or start containers.

## Bundle layout

```text
external-bundle/
├── bundle.json
├── manifest.yaml
├── checksums.json
└── components/
    └── <logical_name>/
        └── payload
```

`bundle.json`, validated by `restore/bundle.schema.json`, records the schema
version, repository commit and branch/release, UTC creation time, architecture,
known component versions and image digests, enabled modules, included
components, manifest checksum, checksum-file reference, verification state, and
external encryption method.

It never stores an encryption key, password, secret, or token.
`checksums.json` uses SHA-256 for every payload file and carries only metadata
required for verification and application. The whole directory must be covered
by authenticated encryption before external storage or transport.

## Components and consistency

The manifest separates mandatory core state from module-conditioned state. Core
includes private configuration, bindings, Home Assistant secrets/state,
Node-RED credentials, and Mosquitto credentials. Recorder history, Node-RED
context, and MQTT persistence are recoverable but optional where recreation is
acceptable.

Zigbee configuration, database, and coordinator backup must come from one
stopped snapshot. Matter and Portainer are indivisible directories. Agent-auth
volumes and the scheduler SSH identity are external state: the plan reports
them, but they require a separate approved procedure and are never silently
copied by the engine.

`service_must_be_stopped` is a planning requirement, not permission to stop a
service. Operational coordination remains separate.

## Read-only commands

```bash
make backup-plan
make backup-verify BACKUP_DIR=/external/path
make restore-plan BACKUP_DIR=/external/path
make restore-verify BACKUP_DIR=/external/path
```

`backup-plan` neither reads private content nor copies data. It shows only
logical/masked names, dependencies, consistency, order, and affected services;
expected size stays installation-dependent because runtime is not inspected.

The `*-verify` commands validate schemas, the manifest checksum, all payload
checksums, byte counts, required components, modules, structure, and absence of
symlinks. `restore-plan` also evaluates commit, architecture, digests, available
space, owner/group/permissions, and destination conflicts.

## Apply and rollback

`restore-apply` is never automatic. It requires:

```bash
make restore-apply \
  BACKUP_DIR=/external/path \
  DESTINATION=/reviewed/target \
  CONFIRM=RESTORE_PRIVATE_STATE
```

The engine always rejects `/`, the home directory, the repository root, and
repository ancestors. Only canaries under the system temporary directory are
allowlisted. Any other destination additionally requires:

```text
ALLOW_NON_CANARY=I_UNDERSTAND_NON_CANARY_DESTINATION
```

This does not replace human approval. Before copying, the engine verifies the
bundle, compatibility, and space. Existing targets receive rollback snapshots;
the first failure restores everything touched so far. Output contains metadata
and logical names only.

## Synthetic test

```bash
make restore-test
```

The test creates both bundle and destination in temporary directories. It
proves schemas, order, checksums, modes, restored content, rejection of a bad
checksum, a missing mandatory component, a changed destination contract,
dangerous paths, and rollback after an injected failure. It never reads or
changes household runtime.

## AI context recovery

After infrastructure and configuration are valid:

```bash
node scripts/ai-context-recovery.mjs --commit <restored-commit>
```

The checker verifies the commit, `AGENTS.md`, `MEMORY.md`, the canonical index,
and only the selected thematic memories (`restore` by default). Other topics
can be passed with `--topics topic-1,topic-2`. It never reads `.agent-history/`,
`.claude/`, private `.codex/` runtime, or `.local-secrets/`. Required knowledge
available only there must be reported as `knowledge_not_versioned`.

The coordinating prompt is `prompts/restore-smart-home.prompt.md`:

```text
infrastructure restored
→ configuration validated
→ commit identified
→ instruction and index files read by the checker
→ selected memory files available at the commit
→ retrieval and use still depend on the new agent session
```

## Agent CLI

The environment used to validate this contract had no `codex`, `claude`,
`openai`, or `chatgpt` executable. The project therefore does not publish an
unverified flag. In the available official interface, submit exactly:

```text
Leia e execute integralmente prompts/restore-smart-home.prompt.md
```

If a CLI is later installed, verify its own `--help` and `--version` before
documenting a one-line invocation. Never put secrets in argv.

## Limitations

- The real external backup and isolated structural restore were completed;
  restored services were not started and devices were not tested.
- The daily routine is deployed and active for the next run: the window after the 00:30 BRT
  Git backup is approved with a ten-minute limit, without authorizing deletion
  or retention rotation. The explicitly authorized controlled Node-RED reload
  completed at 14:15 BRT in 32 seconds; no other service restarted and no cycle
  was dispatched at startup. The first daily execution is still in the future.
  The separate retention decision is not a
  prerequisite for deployment in no-deletion mode.
- Agent authentication volumes and the SSH identity remain outside the default
  bundle and require a separate procedure.
- A compatibility difference requires review; databases, registries, Matter
  fabrics, and Zigbee networks are never migrated automatically.

## Evidence required for a real recovery

A Git backup or local Home Assistant archive does not prove private off-host
backup. Independently verify the external location, UTC completion time,
authenticated encryption, key availability through a separate channel,
coverage of every manifest item, and the latest restore receipt. A protected
flag does not prove successful decryption or external integrity. A native HA
archive is not a `private-state-v1` bundle and does not cover other containers.

A real restore drill requires prior authorization to identify the external
artifact and key without printing them, approve a disposable isolated target,
verify decryption and checksums, plan compatibility and capacity, validate
databases and registries offline, and record only a sanitized conclusion. A
synthetic success or an existing file never replaces that receipt.

## OneDrive off-site backup preparation

The public preparation contract is
`restore/offsite-backup-policy.json`. It is `active: true` and classifies all 19
private-state items into three surfaces. The `plan` and `measure` commands do not
copy their content; only the scheduled cycle performs the approved capture:

- Home Assistant uses the official **OneDrive** integration for `secrets.yaml`,
  `.storage`, and Recorder. It requests `Files.ReadWrite.AppFolder`,
  `offline_access`, and `openid`, writes only to its application folder, and
  keeps backup encryption enabled. **Delete files permanently** stays disabled;
  the retention proposal remains disabled pending specific approval.
- Other Compose services use a dated component set derived from the logical
  names in `private-state-v1`. Capture occurs in consistency groups. Every group
  with `service_must_be_stopped` requires an approved window; the daily window
  described below provides that authority, with a ten-minute ceiling. After
  capture and verification, the set is included in a
  protected remote-only native Home Assistant backup without the database,
  using the same OneDrive agent and no broader scopes.
- Agent authentication volumes and the review worker SSH identity require a
  separately approved export and restore procedure and stay outside the default
  bundle.

These commands are read-only. `measure` reads size metadata, prints no private
paths, and reports missing or unreadable components:

```bash
make offsite-backup-plan
make offsite-backup-measure
make offsite-backup-verify BACKUP_DIR=/path/to/compose-bundle
```

The verifier requires the complete approved Compose subset. Its embedded
manifest also contains the dependency closure supplied by the separate HA
surface, and every item remains byte-for-byte equal to the canonical contract.
A partial manifest created by a backup cannot authorize itself.

The primary transport installs no rclone, creates no second OAuth grant, and
stays within the existing Home Assistant `Files.ReadWrite.AppFolder` scope. The
generic `onedrive.upload` action was rejected because it offers no supported
download for roundtrip verification. Rclone remains an unconfigured fallback
that needs separate approval; `sync`, automatic deletion, and
`Files.ReadWrite.All`/`Sites.Read.All` remain prohibited.

Restic through the rclone backend remains a fallback only when quota, size, or
upload windows make dated bundles impractical. It reduces repeated data but
adds a repository format whose restore needs compatible restic, rclone, the
repository password, and remote configuration. Do not add that dependency while
simple bundles remain small and directly verifiable.

Keep the HA emergency kit and backup password away from both this host and the
OneDrive data they protect. Losing the key prevents decryption of matching older
backups. Never include that material in the bundle itself.

### Exact owner action boundary

Before transfer, approve coverage, the personal Microsoft account, dedicated
bundle folder, quota, and service-stop window. At 12:12 BRT on October 13, 2026,
an authenticated HA WebSocket API query that exposed no tokens, keys, or account
identifiers confirmed one loaded personal OneDrive integration with no pending
repair and a reachable backup agent. The destination was not selected in the
schedule and was initially **unprotected**. The supported API changed only its
`protected` flag to `true`; a before/after comparison confirmed that schedule,
automatic destination selection, and retention did not change.

At 12:15 BRT, one manual copy targeting only that destination completed and was
listed again by the OneDrive agent with 549,232,640 bytes, `protected: true`,
Home Assistant configuration, and database included. Both prior local backups
remained present.

At 13:14 BRT, a second protected remote backup incorporated the consistent
13-component Compose bundle. The agent recorded 426,147,840 bytes, with no
database and no new local copy. The roundtrip downloaded 426,137,600 decrypted
bytes, verified 218 files/3,199,322 bytes by checksum, and restored all 13
components only into a temporary directory. The earlier full backup was also
downloaded: 549,222,400 decrypted bytes, a safe inner archive, valid essential
registries, and `PRAGMA integrity_check = ok` for the restored Recorder. Production
was untouched and no restored service was started, so this proves structural/file
recovery rather than household functionality.

The persistent MQTT database was limited to presence, checksum, and a consistent
capture while the broker was stopped because the running image does not provide
`mosquitto_db_dump`; it did not receive an independent semantic validation.

Both local backups and both remote backups remain present; schedule, automatic
selection, and retention did not change. The next safe boundary is keeping the
emergency kit away from the host/OneDrive. The Node-RED tree blocks updates until
a complete receipt arrives and is deployed with `active: true` for the next
scheduled run. The existing window after the daily
00:30 BRT Git backup is approved, with an expected interruption of about 90
seconds, a hard ten-minute limit, and immediate service restoration taking
priority after any failure. No deletion is authorized: each cycle adds about
426,147,840 bytes (roughly 12.8 GB per 30 days), and quota exhaustion must fail
closed, preserve existing copies, and block following updates. The controlled
Node-RED reload completed at 14:15 BRT in 32 seconds and activated the
configuration without restarting another service or dispatching the cycle; its
first daily execution is still in the future. The future retention definition
does not block no-deletion operation.

The metadata-only quota review at 14:30 BRT found 769,658,139,443 bytes free out
of 1,104,880,336,896 bytes, with two protected backups using 975,380,480 bytes.
The proposed policy is at most 90 daily Compose backups or 90 days, whichever
comes first, scoped only to the exact daily Compose series. At the measured
426,147,840 bytes per cycle, 90 copies use 38,353,305,600 bytes; together with
one full Home Assistant reference backup, the estimate is 38,902,538,240 bytes,
about 5.05% of currently free space. Pruning would occur only after a new backup
is fully verified and would always preserve the latest verified copy. This is a
proposal only: deletion remains disabled until a separate explicit approval.
