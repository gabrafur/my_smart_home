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
→ AGENTS.md and MEMORY.md loaded
→ relevant memory verified against the commit
→ agent ready to operate
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

- Real backup creation was intentionally not automated in this phase.
- External-volume snapshots, service stops, and household post-restore checks
  remain separate, explicitly authorized operations.
- A compatibility difference requires review; databases, registries, Matter
  fabrics, and Zigbee networks are never migrated automatically.
- Synthetic tests prove the engine, not the consistency of a private bundle.
