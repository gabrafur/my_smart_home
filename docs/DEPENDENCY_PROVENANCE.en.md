# Dependency provenance

[Português](DEPENDENCY_PROVENANCE.md) · [English](DEPENDENCY_PROVENANCE.en.md)

This inventory separates vendored source, project-owned code, and dependencies
installed by package managers. The audit compares Git-tracked files only;
ignored caches and runtime state are outside the public distribution.

## Vendored integrations

| Name | Upstream project | Pinned origin | License | Local modifications | Update and attribution | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Alexa Media Player | [`alandtse/alexa_media_player`](https://github.com/alandtse/alexa_media_player) | exact origin in `scripts/alexa-media-upstream.json` (`v5.16.0` in this revision) | Apache-2.0 | `__init__.py` contains one allowlisted guard; the updater requires its marker or proves the target absorbed it | resolve tag/commit/tag object, compare byte for byte, allow only reviewed deltas, validate manifest/compilation, retain `LICENSE.upstream` and Apache notices | verified, protected update |
| HACS | [`hacs/integration`](https://github.com/hacs/integration) | `2.0.5`, `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | minimum HA version in `const.py`; release version in `manifest.json` | reapply and review only those deltas; retain MIT copyright and license | verified, modified |
| Kia Uvo / Hyundai Bluelink | [`Hyundai-Kia-Connect/kia_uvo`](https://github.com/Hyundai-Kia-Connect/kia_uvo) | exact origin in `scripts/kia-uvo-upstream.json` (`v3.12.0`, commit `97f5d61b92209a0476762f625f5053e414063eba` in this revision) | MIT | rate-limit guard, failure-tolerant refresh, trip/efficiency history, command status, and related entities | reconcile through staging/Codex, retain MIT copyright/license, and promote only after tests, backup, rollback, and runtime validation | verified, substantially modified |
| LocalTuya | [`rospogrigio/localtuya`](https://github.com/rospogrigio/localtuya) | `v5.2.3`, `5f2c027c1e9421a93dcc937bf151b9456add04c6` | GPL-3.0-only | 3 of 24 files: service registration, platform/options setup, and `VacuumActivity` API | compare manually; this directory and its modifications remain GPL-3.0-only and the license must accompany redistribution | verified, modified |
| Tuya Vacuum Maps | [`jaidenlabelle/tuya-vacuum-maps`](https://github.com/jaidenlabelle/tuya-vacuum-maps) | `v0.1.4`, `796da700777fa084fe844ed70c882303a09fc268` | MIT | none across 5 tracked files | replace from release, check manifest, retain MIT copyright/license | verified |

The covered paths are `homeassistant/custom_components/<domain>/**`. Each
directory contains the verified upstream license as `LICENSE.upstream`.

## Project-owned components and external services

`claude_code_chat` and `public_bindings` are implementations
owned by this repository, not copies of the projects or services named by
their manifests. Their links identify an API, service, or local guide; they do
not transfer a license to the local code. These components currently have no
license declaration and follow the repository-level blocker in
[third-party notices](../THIRD_PARTY_NOTICES.md#repository-level-license-status).

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
hacs              62 identical,  2 modified
kia_uvo           24 identical, 10 modified
localtuya         21 identical,  3 modified
tuya_vacuum_maps   5 identical,  0 modified
```

The preserved license SHA-256 values are listed in the
[Portuguese inventory](DEPENDENCY_PROVENANCE.md). When a
component changes, repeat the comparison and update its tag, commit, changes,
and hash. For Alexa and Kia, the upstream JSON files are the executable source
of the exact origin and change only after a validated promotion. Then run
`make validate-public`.

## Legal boundary

The missing root `LICENSE` is intentional. The owner must still select a
license for original work and assess this mixed distribution. LocalTuya's GPL
continues to govern its covered directory, but it does not justify assuming a
license for independent files. This is a technical provenance record, not
legal advice.
