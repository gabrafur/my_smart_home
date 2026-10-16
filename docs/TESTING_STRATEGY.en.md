# Testing strategy

[English](TESTING_STRATEGY.en.md) · [Português](ESTRATEGIA_DE_TESTES.md)

## Authority and levels

`make validate-public` is the single complete public verification command.
The Makefile may delegate to smaller diagnostic targets, while CI,
documentation, and the scheduler do not maintain a second coverage list.

| Level | Purpose | Execution |
| --- | --- | --- |
| Unit | Pure functions, parsing, and fail-safe rules | Node Test Runner and `unittest` |
| Static | JSON, YAML, shell, Compose, links, assets, and syntax | Git-tracked checkers |
| Contract | Manifests, modules, bindings, memory, privacy, and security | fail-closed schemas and scanners |
| Home Assistant | Dashboards, Brazilian numeric formatting, RTX history, and vehicle estimate | `unittest` discovery without household runtime |
| Synthetic integration | Flows and bridge with temporary data | Node-RED and bridge aggregators |
| Restore/bootstrap/demo | Recovery, fresh clones, and logical scenarios | temporary directories, no household state |

## Discovery and categories

`npm --prefix nodered run test:all` discovers every
`nodered/tools/test-*.mjs`; only the aggregator itself is excluded. The runtime
test uses a temporary isolated Node-RED container with a synthetic flow and no
household volumes, credentials, or network. `npm --prefix ia-bridge test` uses
the Node Test Runner's recursive discovery for all relevant `*.test.js` files.

Node.js tests under `scripts/` are recursively discovered by
`scripts/test-all.mjs`. Restore, bootstrap, and demo are explicit categories
run by `make restore-test`, `make bootstrap-test`, and `make demo-test`.
Independent public Local AI tests use `test_*.py` discovery.
Tests in `homeassistant/tests/` use the same discovery and load only minimal
deterministic stubs when exercising the vendored integration.

## Matrices and CI

The core matrix validates only Home Assistant, Node-RED, and Mosquitto. The
full matrix enables every public profile using `.env.example`. Both run only
`docker compose ... config --quiet`; no household service is started. CI has
one canonical check, `public-validation / Canonical public validation`, which
calls only `make validate-public`.

The versioned `pre-push` hook, enabled by `make install-git-hooks`, requires a
clean worktree and runs that same canonical target before allowing `HEAD` to be
pushed. The locally validated state therefore matches the commit being sent,
and any failure blocks the push before it reaches GitHub Actions.

## Completion criteria and handoff

Each task needs one objective and a stated completion criterion. When
continuing work from another executor, confirm the project, host, branch and
commit SHA when there is a repository, authorized scope, pre-existing state to preserve, last validated
result, and next step. A summary from another task does not transfer its
authorization.

Report only the applicable evidence layers, with the source, environment,
observation time, and limitation:

| Layer | Completion evidence | If not verified |
| --- | --- | --- |
| Configuration/API | Read back the applied state from configuration or API | Say that the change was only written or prepared |
| Code | Targeted tests and public validation/CI as appropriate | List pending checks; CI does not prove production |
| UI | Visually check the affected appearance and interaction | State that only configuration/API was read back |
| Operation | Health and outcome of a real cycle after the change | Leave pending until the scheduled cycle; do not trigger it to close the task |

Not every layer applies to every task. Do not claim that a routine is working
in production based only on configuration or tests. State pending checks,
including those dependent on access, authorization, or a future event.

Minimum handoff: **objective; project/host; branch/SHA if any; pre-existing state;
change made; evidence for applicable layers; pending checks and authorizations;
verifiable next step**. Cite public files, test/CI results, API readback, or
summarized operational state. Do not include credentials, events, private
calendars, personal identifiers, or private runtime content in handoffs or
public memory.

## Deliberate boundaries

Automation never tests against the real household: it does not read secrets,
call home endpoints, send notifications, move the gate, change the alarm,
control the vehicle, or start the stack. Physical tests and post-deployment
validation remain documented manual procedures. Before a commit, the index can
also be checked with `make validate-staged`. Git's `--no-verify` escape hatch
exists for exceptional recovery and is not part of the normal workflow.
