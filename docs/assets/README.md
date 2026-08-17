# Ativos de documentação

[Português (principal)](README.md) · [English](README.en.md)

Todos os ativos são sintéticos e não usam screenshots, mapas ou dados da
residência. As fontes editáveis são versionadas ao lado dos renders.

## Arquitetura

- fonte: `smart-home-architecture.mmd`;
- render: `smart-home-architecture.svg`;
- Mermaid CLI imobilizado para reprodução: `11.12.0`.

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/data" \
  ghcr.io/mermaid-js/mermaid-cli/mermaid-cli:11.12.0@sha256:bad64c9d9ad917c8dfbe9d9e9c162b96f6615ff019b37058638d16eb27ce7783 \
  -i /data/docs/assets/smart-home-architecture.mmd \
  -o /data/docs/assets/smart-home-architecture.svg -b transparent
```

O diagrama separa core, módulos opcionais, código público, bindings/estado
privados e o bundle de restore com aplicação aprovada por uma pessoa.

## Social preview

`github-social-preview.svg` é a fonte determinística. O PNG publicado deve ser
RGB, 1280×640, menor que 1 MB e sem chunks de metadata textual.

```bash
npx --yes sharp-cli@5.2.0 \
  --input docs/assets/github-social-preview.svg \
  --output docs/assets --format png --compressionLevel 9 \
  resize 1280 640 --fit fill -- removeAlpha
node scripts/strip-png-metadata.mjs docs/assets/github-social-preview.png
```

O layout final foi desenhado em SVG. Uma geração `imagegen` separada, não
versionada, foi usada apenas para explorar direção visual com o prompt:
“synthetic self-hosted smart-home platform, navy/teal, house, event streams,
containers, observability and recovery, no text, logos, people or real data”.
Nenhum pixel ou metadata dessa exploração é necessário para reproduzir o PNG.

Depois de regenerar, rode `node scripts/assets-check.mjs` e
`make privacy-check`.
