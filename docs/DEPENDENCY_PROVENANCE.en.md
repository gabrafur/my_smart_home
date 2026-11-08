# Dependency provenance

[Português](DEPENDENCY_PROVENANCE.md) · [English](DEPENDENCY_PROVENANCE.en.md)

This inventory separates vendored source, project-owned code, and dependencies
installed by package managers. The audit compares Git-tracked files only;
ignored caches and runtime state are outside the public distribution.

## Vendored integrations

| Name | Upstream project | Pinned origin | License | Local modifications | Update and attribution | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Alexa Media Player | [`alandtse/alexa_media_player`](https://github.com/alandtse/alexa_media_player) | exact origin in `scripts/alexa-media-upstream.json` | Apache-2.0 | `__init__.py` contains an allowlisted guard; the updater requires its marker or proves the target absorbed it | resolve tag/commit/tag object, compare byte for byte, allow only reviewed deltas, validate manifest/compilation, retain `LICENSE.upstream` and Apache notices | local pin; protected update |
| Kia Uvo / Hyundai Bluelink | [`Hyundai-Kia-Connect/kia_uvo`](https://github.com/Hyundai-Kia-Connect/kia_uvo) | exact origin in `scripts/kia-uvo-upstream.json` | MIT | rate-limit guard, failure-tolerant refresh, trip/efficiency history, command status, and related entities | reconcile through staging/Codex, retain MIT copyright/license, and promote only after tests, backup, rollback, and runtime validation | local pin, substantially modified |

Amazon Kids state is shared across platforms. A later platform start initializes
only unknown devices and checks that selection again under the lock, without
creating another timer or polling known states again. Regression tests exercise
the actual function with a simulated API; counting calls to a mock that replaces
the entire filter does not establish this contract.

The covered paths are `homeassistant/custom_components/<domain>/**`. Each
directory contains the verified upstream license as `LICENSE.upstream`.

## HACS retired after migration to Marketplace

Core `2026.11.0` replaced the vendored HACS copy with native Marketplace.
The installed `components/marketplace/migration.py` implements
`_remove_legacy_integration`, checking the legacy domain and protecting standalone
development checkouts before removing the custom integration. This inventory
reconciles the observed removal of HACS;
there is no remaining vendored HACS code or local manifest to restore.
Marketplace ships in the Compose-pinned Core image, rather than as newly
vendored source. The audited image was
`sha256:c6c1ca9931036bf3a2c4cc088d8db25dfea3b33935a5ecc83c40349462e2f69e`;
the installed migration module SHA-256 was
`e1c5775e2483f8cf0610049122fd9fa109ca174b3f6709926aafe2bc3e657c4e`.

Historical provenance remains: `hacs/integration`, lightweight tag `2.0.5`,
commit `c0dfd8b44297c3673c21973e2539375a53687a9c` (no annotated tag object).
The retired Git tree `4e47869f7ca4f0a12c80c3cf13207274accfaa8e` was compared
byte for byte against that commit: 62 identical code files, identical MIT
license, and only two local changes, `const.py` (minimum HA `2024.4.1`) and
`manifest.json` (version `2.0.5`). These changes are not transferred to native
Marketplace. The MIT license and copyright remain in Git history, including
`1a8d7f53f368c533116f1af06a47c9e74a070f51:homeassistant/custom_components/hacs/LICENSE.upstream`.
Its historical hash is recorded in the Portuguese inventory. Redistribution
of an older revision containing HACS must retain that MIT license. This file
audit alone does not establish entity-registry migration, runtime health or
Recorder preservation; those require separate operational verification.

## Project-owned components and external services

`icloud` is a local adapter that delegates platforms to the installed Home
Assistant Core and restricts OTP delivery to an explicit manual action. Its
Python code is original; Core-derived UI resources retain Apache-2.0 in
`homeassistant/custom_components/icloud/LICENSE.upstream`. The adjacent
`upstream.json` records the source tag, commit, image digest and original
resource hashes. Resource changes cover verification-step text and account
examples sanitized to the reserved `example.invalid` domain.
Compatibility and tests: [manual reauthentication](ICLOUD_MANUAL_AUTH.md).

`claude_code_chat` and `public_bindings` are implementations
owned by this repository, not copies of the projects or services named by
their manifests. Their links identify an API, service, or local guide; they do
not transfer a license to the local code. These original components follow
the project's [GPL-3.0-only license](../LICENSE) while external dependencies
retain their own terms.

`moni_mobile` was extracted to
[`gabrafur/moni_mobile_home_assistant`](https://github.com/gabrafur/moni_mobile_home_assistant),
is licensed under MIT, and is installed by HACS. The runtime directory
`/config/custom_components/moni_mobile/` is no longer tracked here; the HACS
release is the integration code's single canonical source.

## Managed dependencies

- `nodered/package-lock.json` pins the Node-RED npm graph, including the Home
  Assistant websocket and Dulonode packages.
  For Dulonode 1.0.11, `nodered/tools/patch-dulonode-retry.mjs` applies a
  minimal, idempotent local startup patch that retries the initial deployment
  after transient DNS failures. The installed package retains its upstream
  license and provenance; the patch does not replace the package license files.
- `validation/package-lock.json` pins `yaml@2.9.0` for validation only.
- `local-ai-integration/local-ai-rtx.lock.json` pins the external runtime's
  repository, release, commit, and SHA-256; the installer rejects a mismatch
  before activating an immutable release.
- Home Assistant manifest requirements are resolved during integration setup;
  their source is not vendored here.
- Compose images are pinned by digest; [Containers](CONTAINERS.en.md) records
  their origin, versions, and update policy.

Locks and digests make resolution reproducible but do not replace the license
terms shipped by each package or image.

## Verification method

Official tag archives were resolved to commits with `git ls-remote`. Every
tracked component file was then compared byte for byte with the tag's
`custom_components/<domain>` directory:

```text
alexa_media       38 identical,  1 modified
hacs (historical) 62 identical,  2 modified
kia_uvo           24 identical, 10 modified
```

The preserved license SHA-256 values are listed in the
[Portuguese inventory](DEPENDENCY_PROVENANCE.md). When a
component changes, repeat the comparison and update its tag, commit, changes,
and hash. For Alexa and Kia, the upstream JSON files are the executable source
of the exact origin and change only after a validated promotion. Then run
`make validate-public`.

## Legal boundary

Original project work follows [GPL-3.0-only](../LICENSE). Upstream copyright
and licenses still govern vendored files. This is a technical provenance
record, not a claim of ownership over third-party code.
