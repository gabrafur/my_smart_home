# Motor de layout ELK para Node-RED

Este motor reorganiza somente a geometria versionada dos canvases. O arquivo
ativo continua sendo `nodered/flows.json`, e
`nodered/tools/flow-layout-overrides.json` registra a geometria aprovada que os
geradores reaplicam. O motor não faz deploy, não reinicia o Node-RED e não lê
`flows_cred.json`.

## Contrato de segurança

Somente `x` e `y` de objetos posicionados e `x`, `y`, `w` e `h` de `group`
podem mudar. A ordem global dos objetos e das propriedades permanece igual.
IDs, tipos, tabs, `z`, `g`, `group.nodes`, `wires`, `links`, portas, outputs,
funções, entidades, serviços, tópicos, credenciais e config nodes fazem parte do
hash semântico e bloqueiam a gravação se mudarem.

O grafo virtual inclui wires locais, `link out`/`link in` e `link call`. Esses
links servem somente para calcular componentes e direção visual; nunca são
convertidos nem regravados. Subflows são canvases próprios. Config nodes ficam
fora do layout. Groups aninhados sem contrato inequívoco são congelados.

## Estratégias e precedência

O ELK Layered (`elk.direction=RIGHT`) produz duas propostas determinísticas:

1. layout hierárquico completo dos nós dentro dos groups e dos groups no tab;
2. layout conservador de cada componente conectado dentro do espaço já
   aprovado do group.

O pós-processador aplica grade de 10 px, margem esquerda mínima de 64 px,
padding de group de 20/36/20/20 px, espaçamento de 40 px entre nós, 100 px
entre camadas e 70 px entre componentes/groups. As regras do projeto têm
precedência sobre o resultado bruto do ELK.

Para cada tab, o motor compara as duas propostas com o baseline. Uma proposta
é aceita somente quando produz ganho mensurável sem aumentar sobreposições,
interseções fio–nó, fios acima de 500 px, retornos, inversões de outputs,
groups isolados, cadeias separadas, interseções de componentes ou cruzamentos
estimados. Sem proposta segura, a geometria original é preservada e o motivo
aparece no relatório.

## Comandos

```bash
npm --prefix nodered run layout:dry-run
npm --prefix nodered run layout
npm --prefix nodered run layout:check
```

`layout:dry-run` calcula todas as propostas em memória e relata, por tab,
componentes, objetos/campos alterados, sobreposições, interseções, fios longos,
retornos, cruzamentos, espaçamento mínimo/médio, interseções entre envelopes de
componentes e dimensão do canvas. `layout` repete os mesmos gates, prova uma
segunda execução idêntica e só então atualiza o fluxo e os overrides. A escrita
é atômica quando o diretório permite; no host residencial, onde o arquivo é
gravável mas o diretório pode não ser, a operação mantém o conteúdo anterior e
faz rollback dos dois arquivos se qualquer etapa falhar. `layout:check` falha
quando a geometria aprovada não é um ponto fixo do motor.

Para limitar a análise:

```bash
node nodered/tools/layout-flows-elk.mjs --dry-run --tabs storage_health,backup_git
```

## Validação

Antes de aceitar uma alteração, execute os testes direcionados, o comparador
layout-only contra o snapshot anterior, os validadores do Node-RED e a
renderização estrita. Inspecione visualmente todos os PNGs alterados. O teste
automatizado cobre cadeias, fan-in/fan-out, switches, ciclos, componentes
independentes, groups, links, subflows, comentários, nós HA/MQTT/custom,
colisões, grafo grande, hash semântico, ordem global e idempotência.

Limitação deliberada: o ELK não conhece o roteamento Bézier exato do editor do
Node-RED. Por isso cruzamentos e interseções são reavaliados pelo auditor local,
e uma proposta pior é descartada mesmo que o ELK a considere válida.
