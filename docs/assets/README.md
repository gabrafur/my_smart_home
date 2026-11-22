# Ativos de documentação

[Português (principal)](README.md) · [English](README.en.md)

Todos os ativos são sintéticos e não usam screenshots, mapas ou dados da
residência. As fontes editáveis são versionadas ao lado dos renders.

## Visão geral

- fonte e render: `smart-home-overview.svg`, escrito à mão (sem gerador);
- imagem principal dos READMEs da raiz: entradas, core, saídas, estado
  privado, backup/restore e fronteira de IA em camadas, com fundo próprio para
  ficar legível nos temas claro e escuro;
- edite o SVG diretamente, mantendo coordenadas que não se sobreponham, e
  confira o resultado num navegador; a revisão semanal da documentação também
  pode atualizá-lo.

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

O diagrama separa repositório público, runtime privado, dispositivos físicos,
serviços cloud opcionais, backup/restore e a fronteira de agentes/Local AI.
Core e módulos opcionais continuam visualmente distintos nessas fronteiras.
Também mostra os painéis, o observador global com os hubs de notificação, a
cadeia noturna (backup Git → backup externo → updates) e o servidor MCP com
edge OAuth usado por clientes de IA.

A fonte usa o layout `elk` (incluído no Mermaid CLI 11.12.0) e cor de linha
neutra para que o SVG transparente fique legível nos temas claro e escuro do
GitHub. Sem Docker, o mesmo pacote pode ser instalado com
`npm i @mermaid-js/mermaid-cli@11.12.0` e apontado para um Chromium local por
`-p` (arquivo de configuração do Puppeteer com `executablePath`).

Os diagramas de decisão e da cadeia noturna no `README` da raiz são blocos
Mermaid inline, renderizados pelo próprio GitHub; não há SVG gerado para eles.

## Prints da demo

`generated/demo-casa.png` e `generated/demo-sistema.png` são capturas da stack
sintética (`make demo-stack`, depois `make demo-stack-screenshots`). Mostram só
entidades da integração `demo` do Home Assistant e dados inventados pelo fluxo
de demo do Node-RED; os metadados PNG são removidos. A revisão semanal da
documentação pode substituí-los, mas não consegue gerá-los no worker.

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
