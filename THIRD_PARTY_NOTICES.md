# Third-party notices

[Português](THIRD_PARTY_NOTICES.pt-BR.md) · [English](THIRD_PARTY_NOTICES.md)

This repository distributes third-party source code in addition to project-
specific configuration and tooling. The notices below apply only to the
identified upstream code; they do not grant a license for the repository's
original work.

## Vendored Home Assistant integrations

| Component | Upstream revision | License | Covered path | Local status |
| --- | --- | --- | --- | --- |
| Alexa Media Player | `v5.15.7` / `eef9f9c95645c485b4028cd2dc7154f9493093de` | Apache-2.0 | `homeassistant/custom_components/alexa_media/**` | byte-identical to the tag before this notice |
| HACS | `2.0.5` / `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | `homeassistant/custom_components/hacs/**` | version and minimum-HA metadata changed locally |
| Kia Uvo / Hyundai Bluelink | `v3.10.1` / `2c602560746318fd001db8fe52347e9398f181ed` | MIT | `homeassistant/custom_components/kia_uvo/**` | locally modified; see the provenance guide |
| LocalTuya | `v5.2.3` / `5f2c027c1e9421a93dcc937bf151b9456add04c6` | GPL-3.0-only | `homeassistant/custom_components/localtuya/**` | locally modified for Home Assistant compatibility |
| Tuya Vacuum Maps | `v0.1.4` / `796da700777fa084fe844ed70c882303a09fc268` | MIT | `homeassistant/custom_components/tuya_vacuum_maps/**` | byte-identical to the tag before this notice |

The corresponding license text is preserved as `LICENSE.upstream` inside
each component directory. Copyright remains with the upstream authors.
Upstream names and trademarks are used only to identify dependencies.

Full origins, comparison method, modifications, update policy, package-managed
dependencies, and attribution duties are documented in
[dependency provenance](docs/DEPENDENCY_PROVENANCE.en.md).

## Repository-level license status

There is intentionally no root `LICENSE` file. A public GitHub repository is
not automatically open source, and the owner has not selected a license for
the original configuration, documentation, scripts, flows, or integrations.
Until that decision is made, those original portions remain under default
copyright restrictions. Third-party portions remain governed by their own
licenses above.

Selecting a root license requires an explicit owner decision and, if needed,
legal review—especially because this distribution includes GPL-3.0-only code
and locally modified upstream components. This notice is an inventory, not
legal advice.
