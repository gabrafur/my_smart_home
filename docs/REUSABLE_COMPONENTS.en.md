# Reusable components

[Português (principal)](REUSABLE_COMPONENTS.md) · [English](REUSABLE_COMPONENTS.en.md)

Few people will adopt this whole house, but several pieces solve common
problems for anyone running Home Assistant and Node-RED. This catalogue lists
what can be reused today, which files each piece depends on, and how much work
it takes to become an independent project.

Original code is licensed under [GPL-3.0-only](../LICENSE). An extracted piece
stays GPL unless the copyright holder of the original code chooses another
licence for it; vendored components always keep their own licence
([third-party notices](../THIRD_PARTY_NOTICES.md)).

## Catalogue

| Component | What it solves | Main files | Dependencies | Coupling | Extraction effort |
| --- | --- | --- | --- | --- | --- |
| Node-RED layout validator and renderer | Readable canvases: overlap, margins, long wires, crossings, a benchmark that cannot regress | `nodered/tools/flow-layout-*.mjs`, `nodered/tools/validate-flow-layout.mjs`, `nodered/tools/render-flow-layout.mjs`, `nodered/tools/layout-flows-elk.mjs` and tests | Node.js, `elkjs` | low: reads any `flows.json` | low |
| Manual-test policy with dry-run | Every tab declares how it is tested without a physical effect | `nodered/tools/manual-test-policy.json`, `nodered/tools/validate-manual-test-policy.mjs` | Node.js | low; tab names are this project's | low |
| Global Node-RED failure observer | `catch`/`status` on every tab, dedupe, shared-outage confirmation, cause history | `nodered/tools/install-global-flow-observer.mjs`, `nodered/tools/validate-global-flow-observer.mjs`, `nodered/tools/test-global-flow-observer.mjs` | Node.js, Home Assistant nodes | **high**: the generator also installs hubs, resume, host/MQTT observers, and operational alerts | high; extract only the `catch`/`status` group and classifier first |
| Notification hubs | A single exit for phone, Alexa, and persistent notifications, with recipients by logical role | `nodered/tools/install-notification-hubs.mjs`, `nodered/tools/test-notification-hubs.mjs` | Node.js, Home Assistant | medium: depends on bindings | medium |
| Logical-role bindings | Public logic without physical IDs; a missing role fails closed | `bindings/public-bindings.schema.json`, `bindings/private-bindings.example.json`, `homeassistant/custom_components/public_bindings/`, `scripts/public-bindings-check.mjs` | Python (HA), Node.js | low | low to medium |
| Privacy scanner | Blocks household data in commits without printing the finding | `scripts/privacy-check.mjs`, `scripts/security-scan.sh` | Node.js, Bash | medium: rules tuned to this repository | medium |
| Manifest-driven restore engine | Read-only `plan`/`verify`; `apply` with a token, destination checks, and rollback | `scripts/restore.mjs`, `restore/schema.json`, `restore/private-state-manifest.yaml`, `scripts/restore.test.mjs` | Node.js | low: the manifest describes the components | medium |
| Scoped MCP tools for Home Assistant | An AI assistant with an allowlist, rate limits, record-before-send, and readback | `scripts/raspberry-mcp/ha-lights/`, `scripts/raspberry-mcp/ha-states/` | Python (standard library), systemd, this project's MCP frontend | medium: the route enters through the Raspberry MCP frontend | medium; the Python broker is independent, the route is not |
| Documentation checks | Links, anchors, bilingual pairs, cited `make`/npm commands, and Mermaid blocks | `scripts/docs-check.mjs`, `scripts/assets-check.mjs`, `docs/i18n-manifest.json` | Node.js | medium: this repository's paths and rules | medium |
| Commit messages | English Conventional Commits, including in shallow CI checkouts | `scripts/commit-message-check.mjs` | Node.js | none | low |

## Reusing a piece today

Without extracting anything, copy the listed files into your repository, keep
their tests with them, and preserve the licence notice. Run the piece's tests
before adapting it; for example:

```bash
node nodered/tools/test-flow-layout-validator.mjs
node --test scripts/restore.test.mjs
node --test scripts/commit-message-check.test.mjs
```

## Extracting a piece into its own repository

1. Choose the piece and the licence (the original copyright holder's decision).
2. In a throwaway clone, keep only the piece's paths with their history, for
   example with [`git filter-repo`](https://github.com/newren/git-filter-repo):

   ```bash
   git clone https://github.com/gabrafur/my_smart_home.git extraction
   cd extraction
   git filter-repo --path nodered/tools/flow-layout-policy.mjs \
     --path nodered/tools/flow-layout-validator.mjs \
     --path nodered/tools/validate-flow-layout.mjs
   ```

3. Add a `package.json` or `pyproject.toml`, an English README, the licence,
   CI, and a synthetic example.
4. Publish a first release and, here, replace the copy with a pinned
   dependency, linking back from this catalogue.

No piece has been extracted yet; once one is, this catalogue points to its
repository.
