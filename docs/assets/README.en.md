# Documentation assets

[Português](README.md) · [English](README.en.md)

Every asset is synthetic and contains no household screenshot, map, or data.
Editable sources are versioned beside their renders.

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

The diagram separates core, optional modules, public code, private
bindings/state, and the human-approved restore bundle path.

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
