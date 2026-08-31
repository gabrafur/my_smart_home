# Weekly documentation review

[Português (primary)](REVISAO_DOCUMENTACAO_SEMANAL.md) · [English](WEEKLY_DOCUMENTATION_REVIEW.en.md)

The Node-RED `revisao_documental_semanal` tab is the single owner of the deep
repository review schedule and manual trigger. Its cron runs every Monday at
**03:00 in `America/Sao_Paulo`** (06:00 UTC in the canonical configuration).
The `docs-review-scheduler` Compose worker has no timer of its own: it maintains
the heartbeat/status, consumes Node-RED requests, and runs isolated Codex with
Git credentials kept outside the automation container.

The Home Assistant **Run documentation review** button presses
`input_button.weekly_documentation_review_run`. Node-RED validates the source
and invokes the read-only `scripts/request-weekly-docs-review.sh` helper. That
helper only creates the shared trigger; execution, locking, allowlisting,
validation, commit, and push remain under worker authority.

## Home Assistant entity

The `homeassistant/packages/weekly_documentation_review.yaml` package creates
the sensor, running binary sensor, and Node-RED-facing `input_button`. The
**Raspberry Pi - System Health** dashboard keeps the same
`sensor.revisao_semanal_da_documentacao`, its key attributes, and **Run review
now** button. It polls every 60 seconds. The worker also writes a one-minute
heartbeat; after three minutes without
an update, the entity changes to `indisponível`.

| Displayed state | Meaning |
| --- | --- |
| `aguardando` | service is active and waiting for `next_run` |
| `executando` | Codex is reviewing the repository |
| `sucesso` | a manual run completed; the continuous service returns to `aguardando` while preserving `last_result` |
| `falha` | the process did not start, failed, or timed out |
| `ignorado` | preflight rejected the branch, tree, or authentication |
| `parado` | the worker received a shutdown signal |
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
- inspect the final and staged diffs before the canonical
  `docs: weekly public-repository review` commit;
- avoid stack restarts, endpoint calls, notifications, and physical-device
  actions.

It never creates an empty commit. A validation failure prevents the push.
The agent deliberately runs at a detached `HEAD`, pinned to the baseline the
scheduler already compared with `origin/main`; it must not require this
temporary worktree to be checked out on `main`. On completion, the agent writes
a transient JSON receipt. A zero exit without the receipt, or a receipt that
reports a blocker, is a failure rather than `no_changes`.

## Security boundaries

The worker receives the writable workspace and credentials capable of
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
- a mandatory completion receipt removed before diff calculation, preventing
  false success when the agent exits before reviewing the baseline;
- a default three-hour limit that terminates the whole process group.

The SSH key needs push permission, but should be repository-specific and have
the smallest available scope. The Compose `:ro` mount protects the original
file from container writes; it does not turn a Git write credential into a
read-only credential.

## Prerequisites and configuration

Before enabling it:

1. authenticate Codex in `ai-bridge` so `codex-bridge-auth` contains
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
node --test scripts/weekly-docs-review.test.mjs
npm --prefix nodered run flows:update-weekly-docs-review
npm --prefix nodered run flows:test-weekly-docs-review
npm --prefix nodered run flows:render-strict -- revisao_documental_semanal
docker compose --profile automation build docs-review-scheduler
docker compose --profile automation up -d docs-review-scheduler
docker compose --profile automation logs --tail=50 docs-review-scheduler
```

The log should contain `schedule managed by Node-RED` followed by the expected
next request as an ISO timestamp. Also confirm the tab contains cron
`00 03 * * 1`. Check the checkout, branch, and Git authentication without
running a review:

```bash
docker compose --profile automation run --rm docs-review-scheduler \
  node scripts/weekly-docs-review.mjs --check
```

On the canvas, run the safe manual test in this order: **TESTE 1: reset**, then
one of **2A agendada**, **2B manual**, or **2C falha da ponte**. Every scenario
ends at **TESTE FINAL: worker bloqueado** with `simulated: true` and
`dispatched: false`; no trigger, Codex, Git, commit, or push runs.

The second command uses only temporary Git repositories and bare remotes to
prove the allowlist, mixed-diff rejection, wrong-branch handling, remote
advancement, validation/scanner failures, and no-empty-commit behavior; it
never pushes to a real remote. The preflight only passes with a clean tree. To
request a complete manual run,
knowing it may edit, commit, and push:

```bash
docker compose --profile automation run --rm docs-review-scheduler \
  node scripts/weekly-docs-review.mjs --run-now
```

To stop or remove only the worker:

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

If the log reports `make: command not found`, the worker image is stale. The
`make validate-public` target is mandatory and must not be replaced by partial
checks. Rebuild only `docs-review-scheduler`; the versioned image installs GNU
Make together with Git, SSH, Python, Node, and Docker Compose.

A dirty tree, unexpected branch, or authentication failure skips that week's
run with an explicit log message. Reviews run in a detached temporary worktree:
on failure the worker records the reason and removes that worktree without
merging anything into `main`. Pre-existing interactive changes in the primary
checkout remain untouched and keep blocking later runs until the tree is clean.

The service checkout must remain on `main`. On another branch the worker
itself remains healthy and waiting, but the run is recorded as
`skipped`/`unexpected_branch` to avoid mixing with interactive work.

When `last_reason` is `remote_authentication_failed`, distinguish DNS failure
from key rejection before replacing credentials. A container created while the
host had no external resolvers can retain a stale `/etc/resolv.conf` after the
host recovers. Check Git-host resolution inside `docs-review-scheduler` and, if
only that container is affected, recreate the worker alone:

```bash
docker compose --profile automation up -d --no-deps --force-recreate \
  docs-review-scheduler
```

Then confirm DNS resolution, an authenticated read from the remote without a
push, the heartbeat, and the new `next_run`. Do not restart the residential
stack to repair the worker.

This is a local schedule and depends on the Docker host and Node-RED being
available. The versioned flow keeps the cron auditable; the Compose service
keeps only the isolated execution environment and versioned prompt.
