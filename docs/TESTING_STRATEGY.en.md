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

## Matrices and CI

The core matrix validates only Home Assistant, Node-RED, and Mosquitto. The
full matrix enables every public profile using `.env.example`. Both run only
`docker compose ... config --quiet`; no household service is started. CI has
one canonical check, `public-validation / Canonical public validation`, which
calls only `make validate-public`.

## Deliberate boundaries

Automation never tests against the real household: it does not read secrets,
call home endpoints, send notifications, move the gate, change the alarm,
control the vehicle, or start the stack. Physical tests and post-deployment
validation remain documented manual procedures. Before a commit, the index can
also be checked with `make validate-staged`.
