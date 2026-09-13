# Guia de estilo dos canvases Node-RED

Este documento é a convenção canônica de organização visual dos flows deste repositório. O layout representa a topologia existente; não autoriza alterar comportamento, arquitetura, conexões ou contratos para obter um desenho mais simples.

## Princípios

1. **Preservação funcional vence a estética.** Se um problema não puder ser corrigido somente com propriedades visuais aprovadas, preserve o flow e documente a exceção.
2. **Leitura predominante da esquerda para a direita.** Organize cada responsabilidade como entrada → preparação → validação → decisão → gate → efeito/saída → confirmação.
3. **O happy path deve aparecer primeiro.** Mantenha o caminho nominal em uma faixa horizontal estável e reconhecível antes das branches excepcionais.
4. **Topologia e semântica orientam a geometria.** Labels, tipos, grupos, entradas, saídas, convergências e papéis funcionais devem ser considerados em conjunto. Não distribua nodes cegamente em uma grade.
5. **Canvases equivalentes usam convenções equivalentes.** Configuração, produção, falha, observabilidade e testes devem ocupar posições relativas previsíveis.

## Propriedades visuais aprovadas

Para reorganização exclusivamente visual, são aprovadas somente:

- `x` e `y` de objetos posicionados no canvas;
- `x`, `y`, `w` e `h` de objetos `group`.

Nenhum outro campo deve ser presumido visual. Em especial, são funcionais ou estruturais e não podem mudar nesta classe de trabalho: `id`, `type`, `z`, `g`, `nodes`, `wires`, `links`, `inputs`, `outputs`, `rules`, `func`, `payload`, `payloadType`, `topic`, `entity_id`, `device_id`, `domain`, `service`, `action`, configurações, ambientes e ordem dos objetos no array.

O comparador obrigatório é:

```bash
node nodered/tools/validate-layout-only.mjs BEFORE.json AFTER.json
```

Uma propriedade desconhecida ou uma propriedade visual adicionada/removida deve falhar fechada.

## Grade e espaçamento

- Use preferencialmente múltiplos de 10 px para centros e limites de grupos.
- Preserve margem esquerda mínima de 64 px antes do primeiro grupo; sem groups, antes do primeiro node.
- Entre as bordas de nodes consecutivos no caminho horizontal, mantenha normalmente 80–160 px livres. Labels longos exigem mais espaço.
- Entre lanes paralelas, mantenha normalmente 70–120 px entre centros, ampliando quando há muitos wires ou labels altos.
- Controles compactos do mesmo painel de parâmetros podem usar uma cadência menor, desde que labels, conectores e wires não se toquem.
- Evite tanto nodes praticamente encostados quanto gaps locais acima de 500 px. Não compacte um canvas a ponto de esconder branches.
- Ajuste `group` ao conteúdo com ao menos 20 px nas laterais, 36 px no topo para o título e 20 px na base.

## Organização por responsabilidade

### Happy path

O caminho principal ocupa a lane central do grupo, com `x` crescente. Preparação, validação e decisão devem preceder o efeito. Convergências ficam depois das branches, nunca misturadas às entradas.

### Branches

- Dê a cada branch uma lane vertical distinta.
- Alinhe nodes equivalentes em colunas de `x` semelhantes.
- Ordene as saídas de cima para baixo conforme a ordem dos outputs do node quando isso reduzir cruzamentos.
- Evite intercalar nodes de branches diferentes ou fazer uma branch atravessar a faixa de outra.

### Falhas, rejeições e fallback

Posicione caminhos negativos, rejeições e falhas abaixo do happy path, salvo quando a topologia existente justificar claramente outra lane. Terminais negativos devem ficar próximos da decisão que os produz, sem atravessar efeitos nominais.

### Efeitos paralelos

Efeitos independentes começam em uma coluna comum e ocupam lanes paralelas. Confirmações ou resultados equivalentes também se alinham. O fan-out não deve criar diagonais que cruzem outras branches quando uma troca de `y` resolver o problema.

### Testes

- Separe a área de testes dos caminhos de produção por group próprio.
- Use uma lane por cenário: gatilho → preparação → caminho compartilhado → terminal dry-run.
- Alinhe resets e instruções acima ou à esquerda dos cenários.
- Preserve as conexões existentes mesmo quando vários testes compartilham um node; mova apenas as coordenadas para tornar os wires legíveis.
- Terminais de teste permanecem sem saída e visualmente separados dos efeitos reais.

### Observabilidade

Os grupos de cobertura global ficam em uma borda previsível do canvas e não atravessam o domínio funcional. `catch`, `status`, identificação e link de saída devem formar uma pequena sequência local.

## Groups e tamanho do canvas

- Preserve ID, nome, membros, estilo e semântica de cada group.
- Um node pertencente a um group deve ficar integralmente dentro dele.
- Groups não se sobrepõem e mantêm gutters visíveis.
- Empilhe groups por fase ou responsabilidade quando uma única linha produzir largura excessiva.
- Quebrar o canvas em linhas é permitido apenas por reposicionamento; não crie retornos funcionais nem altere a topologia.
- Remova grandes vazios que não separem responsabilidades, mas mantenha espaço suficiente para reconhecer as fases do flow.

## Wires

- Minimize cruzamentos, passagens sobre nodes e diagonais longas por reposicionamento das extremidades.
- Evite destinos à esquerda da origem e sequências em zig-zag.
- Wires acima de 500 px são candidatos obrigatórios a correção visual.
- Nesta classe de trabalho, é proibido criar, remover ou converter wires, junctions ou link nodes. Se a topologia existente impedir a correção somente por coordenadas, registre a exceção.
- Em trabalho funcional futuro, a política geral do repositório para links longos continua válida, mas exige escopo e validação próprios.

## Processo obrigatório

1. Preserve um snapshot byte a byte do `flows.json` atual como baseline.
2. Gere a auditoria anterior à mudança e renderize todos os tabs/subflows.
3. Altere a fonte visual canônica em `nodered/tools/flow-layout-overrides.json`; não edite apenas a saída gerada.
4. Reaplique a geometria com `npm --prefix nodered run flows:apply-left-margin`.
5. Depois de cada lote ou tab, execute o comparador layout-only contra o snapshot.
6. Execute `npm --prefix nodered run flows:validate-layout` e renderize os tabs alterados.
7. Execute `npm --prefix nodered run flows:render-strict -- <tab...>` e inspecione os SVG/PNG, sem aceitar piora do benchmark.
8. Execute os validadores e replays Node-RED relevantes, uma suíte por vez e pelo wrapper seguro do repositório quando a validação for ampla.
9. Inspecione o diff final. Toda diferença fora das propriedades aprovadas deve ser investigada e revertida.
10. Não faça deploy automaticamente. Um carregamento no ambiente residencial exige autorização e procedimento operacional separados.

## Critério de aceite

Um canvas está padronizado quando o happy path é evidente, branches e efeitos têm lanes claras, falhas não confundem o caminho nominal, testes são legíveis, groups contêm seus membros, não há sobreposição, os labels têm espaço e os wires têm o mínimo razoável de cruzamentos. Alinhamento em grade, isoladamente, não é suficiente.
