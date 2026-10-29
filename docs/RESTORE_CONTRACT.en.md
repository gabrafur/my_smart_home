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

## Service readiness and neutral isolation probe

[`restore/service-recovery-contract.mjs`](../restore/service-recovery-contract.mjs)
preserves all seven roles and the `offsite-backup.mjs::serviceReady` criteria.
Every process must be running without restarting. Home Assistant additionally
requires native healthy status; Node-RED requires a fresh `Started flows` and
HTTP 200 from `/auth/login`; Mosquitto requires an authenticated MQTT connection
using restored credentials. Portainer, AppDaemon and Matter Server require TCP
9000, 5050 and 5580 respectively. Zigbee2MQTT requires a fresh startup marker
and an `online` MQTT bridge.

These observations must come from restored processes. The pure evaluator does
not collect them; supplied boolean values do not prove recovery. Planning
requires authenticated HA decryption including Recorder, the canonical Compose
bundle, identity verification across both surfaces, and specific key and
coordinator scopes. Approval or verified files do not establish functional
recovery.

[`service-recovery-isolation-probe.mjs`](../scripts/service-recovery-isolation-probe.mjs)
runs two fixed Python programs without restored data. One container uses
`network none`, and the other shares that namespace exclusively. The probe
checks loopback, zero routes, aliases for all seven roles, zero capabilities,
`no-new-privileges`, 0.05 CPU and 16 processes per container. It refuses mounts,
devices, published ports, images declaring volumes and image downloads. The
root filesystem is read-only; each program expires within 120 seconds.
Creation and cleanup use exclusive intents, exact identity and an inventory
confirming absence. Uncertain results require reconciliation.

The default backend requires a 64 MiB memory cgroup. Where that controller is
unavailable, a separately prepared `python_rlimit_as` probe lowers soft and hard
`RLIMIT_AS` to 64 MiB as the fixed program's first command, before other imports.
The process verifies the limit and rejects a larger allocation. This mode also
requires the exact program and entrypoint; it bounds only the probe's Python
programs, not restored application containers. Backend selection is never
automatic. Docker CLI rejects `--ulimit as`; that option cannot establish a
limit.

The module neither installs an executor nor grants root access. Its reviewed
caller must validate current authority, seal sources, acquire locks, check
resources and persist receipts. The [sanitized acceptance record](../restore/service-recovery-isolation.acceptance.json)
reports the real neutral probe and cleanup. No restored service was started.
This proof does not authorize another key read, transfer, radio access,
household shutdown or operation after authority expires.

The [process boundary for recovery probes](../restore/PROCESS_BOUNDARY.md) has
separate native evidence for limits, watchdog behavior and guest OOM. Its
[resource acceptance receipt](../restore/process-boundary.acceptance.json) uses
only public software, without keys, backups, physical devices or restored
applications. It does not replace the seven functional acceptance checks or
authorize additional access. TCG is not treated as a guest security boundary;
outer containment still requires its own review before admitting private data.

## Limitations

- The real external backup and isolated structural restore were completed;
  restored services were not started and devices were not tested.
- The first scheduled execution, on October 14, 2026, failed before creating a
  new external copy: the consistent capture restarted Home Assistant, and the
  `backup/generate` request made 15 seconds later found Backup Manager still
  `blocked` during startup. No new Compose copy was created, retention did not
  run, and updates remained blocked. The worker now queries `backup/info` and
  waits up to 180 seconds for `idle`, failing closed with a specific diagnosis
  if startup does not finish, another backup remains active, the query fails,
  or an agent reports an error. It sends exactly one generation request after
  readiness.
- The versioned configuration moves the Git -> verified external backup ->
  updates chain to 01:00 in Node-RED's `TZ` (BRT in this installation) while
  preserving the ten-minute capture limit. The
  window precedes the 03:00 jobs and HA automatic-backup activity between roughly
  04:45 and 05:45, and storage maintenance at 06:23. Node-RED loaded the flow
  on October 14, 2026. No manual cycle was run to validate the fix; the first
  automatic cycle in this window and integrated retention remain unobserved in
  production.
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

The disabled public example is
`restore/offsite-backup-policy.example.json`; it classifies all 19 private-state
items into three surfaces. Each installation's effective policy belongs in the
Git-ignored `.local-secrets/offsite-backup-policy.json` with mode 0600. Without
explicit activation and verified receipts, the cycle fails closed. The `plan`
and `measure` commands do not
copy their content; only the scheduled cycle performs the approved capture:

Before `git pull` or `make bootstrap` on an installation that still uses the
old tracked policy, copy it **from the old checkout** without replacing an
existing private file:

```bash
set -eu
test -f restore/offsite-backup-policy.json
test ! -L restore/offsite-backup-policy.json
install -d -m 700 .local-secrets
test ! -L .local-secrets
if test -e .local-secrets/offsite-backup-policy.json; then
  cmp restore/offsite-backup-policy.json .local-secrets/offsite-backup-policy.json
else
  install -m 600 restore/offsite-backup-policy.json .local-secrets/offsite-backup-policy.json
fi
test ! -L .local-secrets/offsite-backup-policy.json
test "$(stat -c %a .local-secrets/offsite-backup-policy.json)" = 600
cmp restore/offsite-backup-policy.json .local-secrets/offsite-backup-policy.json
```

This procedure is idempotent and will not replace a differing private policy.
Confirm the copy before updating; afterwards,
`node scripts/migrate-offsite-policy.mjs` checks the destination without
changing it. Bootstrap gives a fresh clone the
disabled example, with no upload authorization. Removing the tracked file does
not erase its older Git history; review that history before a new public
distribution.

- Home Assistant uses the official **OneDrive** integration for `secrets.yaml`,
  `.storage`, and Recorder. It requests `Files.ReadWrite.AppFolder`,
  `offline_access`, and `openid`, writes only to its application folder, and
  keeps backup encryption enabled. **Delete files permanently** stays disabled;
  full Home Assistant backups are outside Compose retention.
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
node scripts/offsite-backup.mjs retention-dry-run
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
that needs separate approval; `sync`, generic deletion, and
`Files.ReadWrite.All`/`Sites.Read.All` remain prohibited. The strict Compose
retention described below is the only permitted automatic removal.

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

Both local backups and both remote drill backups remain present. The next safe
boundary is keeping the emergency kit away from the host/OneDrive. The Node-RED
tree blocks updates until a complete receipt arrives. The scheduled attempt on
October 14, 2026 failed before the external backup because Backup Manager
remained `blocked` while HA was starting; it created no new copy, ran no
retention, and released no updates. The worker now waits up to 180 seconds for
`backup/info` to report `idle` before sending exactly one `backup/generate`.
The versioned configuration moves the chain to 01:00 in Node-RED's `TZ` (BRT
in this installation), with an expected
interruption of about 90 seconds, a hard ten-minute limit, and immediate service
restoration taking priority after any failure. This precedes the 03:00 jobs, HA's
roughly 04:45-05:45 automatic-backup window, and storage maintenance at 06:23.
Node-RED loaded the 01:00 trigger in its `TZ` on October 14, 2026. The first
automatic cycle in that window ran on October 15: Git finished with no changes
at 04:00:03 UTC. The off-site worker ran from 04:01:01 to 04:08:13 UTC and
failed when the repository owner could not write the retention registry under
the root-owned `.local-state` directory. The code had already validated the
protected external backup, but no final success receipt or retention registry
was written, no pruning ran, and updates remained blocked. The registry now
uses the repository-owner-writable, Git-ignored `.local-secrets` directory;
an existing valid legacy registry is read before the first write to the new
path. The next scheduled cycle still needs observation. Quota or readiness
failures must fail closed, preserve existing copies, and block following updates.

The metadata-only quota review at 14:30 BRT found 769,658,139,443 bytes free out
of 1,104,880,336,896 bytes, with two protected backups using 975,380,480 bytes
and a `deleted` quota of zero. At 14:43 BRT the approved policy became at most
90 daily Compose backups or 90 days, whichever
comes first, scoped only to the exact daily Compose series. At the measured
426,147,840 bytes per cycle, 90 copies use 38,353,305,600 bytes; together with
one full Home Assistant reference backup, the estimate is 38,902,538,240 bytes,
about 5.05% of currently free space. That active total excludes the recycle bin:
30 days of removed copies can temporarily add 12,784,435,200 bytes, taking the
combined estimate to 51,686,973,440 bytes, or 6.72% of measured free space.

The routine registers only IDs it creates after verifying the name, timestamp,
structure, sole OneDrive agent, protection, and size. Pruning requires the
private registry, stored as mode 0600 under `.local-secrets`, and a newly fully
verified external copy; a missing or
mismatched registry fails closed. Earlier HA backups, merely similar names, and
all unrelated files are never adopted. The newest verified copy is always
preserved. The HA API moves eligible candidates only to the OneDrive recycle
bin; permanent deletion and emptying the recycle bin are prohibited, and the
runtime option is checked before every cycle. The activation dry-run found zero
eligible candidates and performed zero removals; no copy was deleted during
activation.
