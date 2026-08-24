# Licensing and template decision memo

[English](LICENSING_DECISION.md) · [Português](LICENSING_DECISION.pt-BR.md)

Status: owner decision required. This is a technical inventory and decision aid,
not legal advice.

## Current state and contradiction

As observed through the GitHub API on 2026-08-24, the repository is public,
GitHub reports no detected root license, and **Template repository is enabled**.
The template control suggests reuse, while the repository grants no general
license for its original work. Public visibility lets reviewers inspect the
project, but it should not be presented as open source or as a generally
reusable starter until the owner selects terms.

Third-party licenses still apply to their covered files. They do not grant a
license for independent project-owned configuration, flows, scripts,
documentation, or integrations. The technical inventory is maintained in
[third-party notices](../THIRD_PARTY_NOTICES.md) and
[dependency provenance](DEPENDENCY_PROVENANCE.en.md).

## What is in the repository

| Category | Representative paths | Current treatment |
| --- | --- | --- |
| Original project work | `bootstrap/`, `bindings/`, `demo/`, `modules/`, `restore/`, most of `scripts/`, `.github/`, configuration and documentation | no root license; default copyright restrictions apply |
| Original Home Assistant/Node-RED work | Home Assistant YAML/Jinja and dashboards, `claude_code_chat`, `public_bindings`, Node-RED flows/settings/tools | no project-level license declaration |
| Vendored Apache-2.0 | `homeassistant/custom_components/alexa_media/` | 39 upstream files byte-identical to `v5.15.7`; preserved upstream license |
| Vendored MIT | `hacs/`, `kia_uvo/`, `tuya_vacuum_maps/` under `homeassistant/custom_components/` | HACS has 2 local deltas, Kia Uvo has 10, Tuya Vacuum Maps has none; preserved upstream licenses |
| Vendored GPL-3.0-only | `homeassistant/custom_components/localtuya/` | 3 locally modified files; covered code and modifications retain GPL-3.0-only obligations |
| Managed dependencies and images | npm lockfiles, Home Assistant manifest requirements, digest-pinned Compose images | resolved artifacts retain their own terms; locks/digests are provenance, not relicensing |
| Separate external integration | `moni_mobile` is installed from its own MIT repository | source is not vendored here |

The 2026-08-24 audit resolved every documented upstream tag and compared each
tracked vendored component file byte for byte. Counts and local delta names
still match the provenance guide. The Alexa tag is annotated: its tag object is
`eef9f9c95645c485b4028cd2dc7154f9493093de`, while the checked-out commit is
`5365f875c00692771f17c957a58553f30682b5c3`.

## Realistic options

### 1. Keep the original work unlicensed

- Keep the repository as a reviewable portfolio/reference implementation.
- Disable GitHub's template setting and avoid installation/reuse language.
- Preserve all third-party notices and path-specific licenses.
- Practical consequence: external reuse remains intentionally restricted and
  the project is not an open-source template.

### 2. License original work permissively

- Select a permissive license for project-owned code and configuration, with
  explicit exclusions for vendored paths and their existing licenses.
- Decide whether documentation uses the same terms or a separate content
  license.
- Practical consequence: template/reuse language becomes coherent, but the
  mixed distribution and GPL-covered LocalTuya directory still require clear
  notices and compatibility review.

### 3. License original work under reciprocal terms

- Select a reciprocal license appropriate to the intended distribution and
  hosted/network use, again without overriding third-party path licenses.
- Decide whether documentation is covered separately.
- Practical consequence: reuse can be permitted with share-alike obligations;
  license compatibility and the boundary between independent configuration and
  vendored integrations should be reviewed before publishing the choice.

### 4. Separate vendored code from the public distribution

- Replace vendored integrations with a deterministic fetch/install mechanism
  that preserves versions, hashes, patches, and notices, then license only the
  first-party repository content.
- Practical consequence: the root decision becomes easier to explain and the
  repository gets smaller, but reproducibility, offline restore, upstream
  availability, and patch application become new engineering obligations.
- This option does not by itself grant a license to the original work.

### 5. Use separate code and documentation licenses

- Choose explicit terms for code/configuration and different terms for prose or
  diagrams, with a path-level scope table.
- Practical consequence: permissions can match each artifact, but contributors
  and downstream users must understand two policies.

## Decisions the owner needs to make

1. Which rights should reviewers receive: inspection only, copying,
   modification, redistribution, commercial use, or template-based deployment?
2. Should vendored integrations remain in the repository or be fetched during
   an explicit setup step?
3. Should code/configuration and documentation share one license?
4. Should GitHub's template setting remain enabled after the terms are chosen?
5. What contribution terms should apply to external pull requests?
6. Is a professional license-compatibility review warranted for the selected
   distribution, particularly around modified GPL-3.0-only code?

## Interim public policy

Until that decision is explicit, public documentation describes this as a
**reference implementation / portfolio project**, not a reusable template. The
remote template setting was reported but not changed. No root `LICENSE` was
created, and no license option above is selected by this memo.
