# Weekly documentation review

[Português (primary)](REVISAO_DOCUMENTACAO_SEMANAL.md) · [English](WEEKLY_DOCUMENTATION_REVIEW.en.md)

The `docs-review-scheduler` Compose service performs a deep repository review
every Monday at **06:00 UTC** (03:00 in `America/Sao_Paulo`). It uses the Codex
login already stored in the bridge volume, updates documentation and the
minimum changes needed to keep it truthful, validates the result, commits only
when something changed, and pushes to `origin/main` without force push.

The schedule is deliberately UTC-based, so daylight-saving changes cannot move
it. The service log reports the next run.

## Home Assistant entity

The `homeassistant/packages/weekly_documentation_review.yaml` package creates
`sensor.revisao_semanal_da_documentacao`; the **Raspberry Pi - System Health**
dashboard shows its state and key attributes. It polls every 60 seconds.
The scheduler also writes a one-minute heartbeat; after three minutes without
an update, the entity changes to `indisponível`.

| Displayed state | Meaning |
| --- | --- |
| `aguardando` | service is active and waiting for `next_run` |
| `executando` | Codex is reviewing the repository |
| `sucesso` | a manual run completed; the continuous service returns to `aguardando` while preserving `last_result` |
| `falha` | the process did not start, failed, or timed out |
| `ignorado` | preflight rejected the branch, tree, or authentication |
| `parado` | the scheduler received a shutdown signal |
| `indisponível` | Home Assistant could not read the status file |

Attributes include the next run, previous start and finish, result, normalized
reason, final commit, and counters. The shared
`.local-state/docs-review/status.json` file contains only this metadata, is
Git-ignored, and is mounted read-only in Home Assistant. Full logs and arbitrary
error messages are never copied into the entity.

## Review scope

The versioned prompt at `scripts/weekly-docs-review.prompt.md` requires the
agent to:

- compare new commits with code, Compose, scripts, and documentation;
- keep Brazilian Portuguese primary while preserving full English parity;
- remove stale guidance, fill clone/build/restore gaps, and never add secrets
  or physical household data;
- use official sources when versions or procedures may have changed;
- validate Compose with both the real and example environments,
  documentation, the security scanner, Node-RED flows, and the bridge;
- inspect the final and staged diffs before a commit prefixed with
  `docs: weekly documentation review`;
- avoid stack restarts, endpoint calls, notifications, and physical-device
  actions.

It never creates an empty commit. A validation failure prevents the push.

## Security boundaries

The scheduler receives the writable workspace and credentials capable of
pushing to the Git remote, so it remains an administrative service. It does
not receive the Docker socket and must never be published or exposed.

Additional boundaries include:

- no published port;
- Codex auth and the SSH key are read-only source mounts and are copied into a
  private temporary directory;
- a short root bootstrap followed by execution as the non-root UID/GID that
  owns the checkout, with no supplementary groups; when that UID is absent
  from the image, a no-login local identity is created inside the container;
- required branch, clean Git tree, and remote authentication checks before a
  run starts;
- the shared `.git-backup.lock`, preventing overlap with update/backup scripts;
- fast-forward-only operation, with no destructive rebase, force push, or
  history rewrite;
- a default three-hour limit that terminates the whole process group.

The SSH key needs push permission, but should be repository-specific and have
the smallest available scope. The Compose `:ro` mount protects the original
file from container writes; it does not turn a Git write credential into a
read-only credential.

## Prerequisites and configuration

Before enabling it:

1. authenticate Codex in `claude-bridge` so `codex-bridge-auth` contains
   `auth.json`;
2. create a dedicated SSH key with push access to the repository remote;
3. register the public key with the Git provider and keep the private key out
   of Git;
4. maintain a `known_hosts` file for the Git host;
5. run the setup helper, which preserves existing values and fills the checkout
   UID/GID plus conventional SSH paths when present:

```bash
node scripts/setup-node-red-security.mjs
```

Private `.env` variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEEKLY_DOCS_REVIEW_DAY_UTC` | `1` | UTC day, 0 (Sunday) through 6 (Saturday) |
| `WEEKLY_DOCS_REVIEW_HOUR_UTC` | `6` | UTC hour |
| `WEEKLY_DOCS_REVIEW_MINUTE_UTC` | `0` | UTC minute |
| `WEEKLY_DOCS_REVIEW_BRANCH` | `main` | allowed branch |
| `WEEKLY_DOCS_REVIEW_REMOTE` | `origin` | preflight and push remote |
| `WEEKLY_DOCS_REVIEW_TIMEOUT_MS` | `10800000` | run limit in milliseconds |
| `REPO_UID` / `REPO_GID` | checkout owner | non-root execution identity |
| `WEEKLY_DOCS_REVIEW_SSH_KEY` | no useful default | absolute private-key path |
| `WEEKLY_DOCS_REVIEW_KNOWN_HOSTS` | no useful default | absolute `known_hosts` path |

Never print `.env` values or credential contents in logs or support requests.

## Enable and validate

```bash
node scripts/weekly-docs-review.mjs --self-test
docker compose --profile automation build docs-review-scheduler
docker compose --profile automation up -d docs-review-scheduler
docker compose --profile automation logs --tail=50 docs-review-scheduler
```

The log should contain `next weekly documentation review` followed by an ISO
date. Check the checkout, branch, and Git authentication without running a
review:

```bash
docker compose --profile automation run --rm docs-review-scheduler \
  node scripts/weekly-docs-review.mjs --check
```

The preflight only passes with a clean tree. To request a complete manual run,
knowing it may edit, commit, and push:

```bash
docker compose --profile automation run --rm docs-review-scheduler \
  node scripts/weekly-docs-review.mjs --run-now
```

To stop or remove only the scheduler:

```bash
docker compose --profile automation stop docs-review-scheduler
docker compose --profile automation rm -f docs-review-scheduler
```

## Failures and recovery

Start with:

```bash
docker compose --profile automation ps docs-review-scheduler
docker compose --profile automation logs --tail=200 docs-review-scheduler
git status --short
```

A dirty tree, unexpected branch, or authentication failure skips that week's
run with an explicit log message. If a review fails after editing, its changes
remain in the checkout for human inspection; later runs keep refusing to start
until the tree is clean again. Never discard those changes automatically.

The service checkout must remain on `main`. On another branch the scheduler
itself remains healthy and waiting, but the run is recorded as
`skipped`/`unexpected_branch` to avoid mixing with interactive work.

This is a local schedule and depends on the Docker host being powered on. The
official [Scheduled tasks documentation](https://learn.chatgpt.com/docs/automations)
describes the same limitation for local Codex tasks and notes that schedule
management lives in the desktop/web UI, not the CLI or IDE extension. This
repository uses a Compose service so the schedule and prompt stay versioned and
operable on the Raspberry Pi.
