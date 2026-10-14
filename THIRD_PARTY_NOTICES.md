# Third-party notices

[Português](THIRD_PARTY_NOTICES.pt-BR.md) · [English](THIRD_PARTY_NOTICES.md)

This repository distributes third-party source code in addition to project-
specific configuration and tooling. The notices below apply only to the
identified upstream code. The repository's original work is licensed under
[GPL-3.0-only](LICENSE).

## Vendored Home Assistant integrations

| Component | Upstream revision | License | Covered path | Local status |
| --- | --- | --- | --- | --- |
| Alexa Media Player | `v5.16.2` / `cd600c6aee2f028f0ccc9d3a836e7cf780215993` | Apache-2.0 | `homeassistant/custom_components/alexa_media/**` | locally maintained coordinator guard; see the pinned origin |
| HACS | `2.0.5` / `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | `homeassistant/custom_components/hacs/**` | version and minimum-HA metadata changed locally |
| Kia Uvo / Hyundai Bluelink | `v3.17.1` / `417f6ac5fe65521e7948015a278c82ee5a584a71` | MIT | `homeassistant/custom_components/kia_uvo/**` | locally modified; see the pinned origin |

The corresponding license text is preserved as `LICENSE.upstream` inside
each component directory. Copyright remains with the upstream authors.
Upstream names and trademarks are used only to identify dependencies.

Full origins, comparison method, modifications, update policy, package-managed
dependencies, and attribution duties are documented in
[dependency provenance](docs/DEPENDENCY_PROVENANCE.en.md).

## Home Assistant Core UI resources

The local `icloud` adapter includes UI resources from Home Assistant Core
2026.10.1 (`abe1fdd7cd6b4de1715c87b6fd87d92699514ef9`), under Apache-2.0.
Verification-step descriptions and service account examples are modified.
Source resource hashes and
the official image digest are recorded in its `upstream.json`; the original
license is preserved in `homeassistant/custom_components/icloud/LICENSE.upstream`.
The adapter's Python code delegates to the installed Core integration.

## External Local AI runtime

The optional [`local-ai-rtx`](https://github.com/gabrafur/local-ai-rtx)
runtime is installed from release `v1.5.1`, commit
`11431302d840e6eb90c33ed8ea5fe68c430b5948`, under the MIT License. It is not
vendored in this repository. The exact release archive and SHA-256 are pinned
in `local-ai-integration/local-ai-rtx.lock.json`; its MIT text accompanies the
upstream release.

## Repository-level license status

The root [LICENSE](LICENSE) applies to original project work under
`GPL-3.0-only`. It does not replace upstream copyright or path-specific
Apache-2.0 and MIT licenses for vendored files. Local changes to vendored
components must retain their upstream notices and follow the applicable terms.
This notice is an inventory, not a claim of ownership over third-party code.
