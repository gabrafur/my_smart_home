# Documentation assets

[Português](README.md) · [English](README.en.md)

Every asset is synthetic and contains no household screenshot, map, or data.
Editable sources are versioned beside their renders.

## Overview

- source and render: `smart-home-overview.svg`, hand-authored (no generator);
- main image of the root READMEs: inputs, core, outputs, private state,
  backup/restore, and the AI boundary in layers, on its own background so it
  stays legible in light and dark themes;
- edit the SVG directly, keeping coordinates from overlapping, and check the
  result in a browser; the weekly documentation review may also update it.

## Architecture

- source: `smart-home-architecture.mmd`;
- render: `smart-home-architecture.svg`;
- pinned Mermaid CLI for reproduction: `11.12.0`.

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/data" \
  ghcr.io/mermaid-js/mermaid-cli/mermaid-cli:11.12.0@sha256:bad64c9d9ad917c8dfbe9d9e9c162b96f6615ff019b37058638d16eb27ce7783 \
  -i /data/docs/assets/smart-home-architecture.mmd \
  -o /data/docs/assets/smart-home-architecture.svg -b transparent
```

The diagram separates the public repository, private runtime state, physical
devices, optional cloud services, backup/restore, and the agent/Local-AI
boundary. Core and optional modules remain visually distinct inside those
boundaries. It also shows the dashboards, the global observer with its
notification hubs, the nightly chain (Git backup → off-site backup → updates),
and the MCP server with the OAuth edge used by AI clients.

The source uses the `elk` layout (bundled with Mermaid CLI 11.12.0) and a
neutral line colour so the transparent SVG stays legible in GitHub's light and
dark themes. Without Docker, install the same package with
`npm i @mermaid-js/mermaid-cli@11.12.0` and point it at a local Chromium through
`-p` (a Puppeteer configuration file with `executablePath`).

The decision and nightly-chain diagrams in the root `README` are inline Mermaid
blocks rendered by GitHub itself; no SVG is generated for them.

## Demo screenshots

`generated/demo-casa.png` and `generated/demo-sistema.png` are captures of the
synthetic stack (`make demo-stack`, then `make demo-stack-screenshots`). They
show only Home Assistant `demo` integration entities and data invented by the
demo Node-RED flow; PNG metadata is stripped. The weekly documentation review
may replace them but cannot generate them in its worker.

## Social preview

`github-social-preview.svg` is the deterministic source. The published PNG
must be RGB, 1280×640, below 1 MB, and free of textual metadata chunks.

```bash
npx --yes sharp-cli@5.2.0 \
  --input docs/assets/github-social-preview.svg \
  --output docs/assets --format png --compressionLevel 9 \
  resize 1280 640 --fit fill -- removeAlpha
node scripts/strip-png-metadata.mjs docs/assets/github-social-preview.png
```

The final layout is authored in SVG. A separate, untracked `imagegen` result
was used only to explore a navy/teal visual direction with a synthetic house,
event streams, containers, observability, and recovery—no text, logos, people,
or real data. No pixel or metadata from that exploration is required to
reproduce the PNG.

After regeneration, run `node scripts/assets-check.mjs` and
`make privacy-check`.
