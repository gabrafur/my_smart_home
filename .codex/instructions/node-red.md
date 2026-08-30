# Contratos do Node-RED

## Organização obrigatória dos canvases Node-RED

Antes de deploy, commit ou push de Node-RED, organize grupos e direção de
leitura; não sobreponha nós/grupos nem deixe nós fora do grupo. Altere também a
fonte geradora e regenere `nodered/flows.json`. Execute
`npm --prefix nodered run flows:validate-layout` e renderize/inspecione os tabs
alterados com `npm --prefix nodered run flows:render -- <tab...>`.
`validate-node-red` inclui esse gate no `pre-push`; nunca o ignore ou remova.

Em tabs novos ou alterados, substitua por pares nomeados `link out`/`link in`
qualquer ligação que passe por cima de outro nó/grupo, cruze várias trilhas ou
tenha mais de 500 px. Posicione o `link out` junto da origem e o `link in` junto
do destino, mantendo a direção de leitura. Use
`npm --prefix nodered run flows:render-strict -- <tab...>` e não permita piora
em relação a `nodered/tools/flow-layout-benchmark.json`. Os canvases aprovados
em 2026-08-29 são o benchmark inicial; a inspeção visual continua obrigatória
para detectar cruzamentos que não sejam mensurados geometricamente.

Todo canvas Node-RED versionado deve preservar margem esquerda mínima de 64 px
antes do primeiro grupo, usando `contexto_vehicle_primary` como referência.
Execute `npm --prefix nodered run flows:apply-left-margin` depois de regenerar
os flows; `flows:validate-layout` bloqueia qualquer regressão. Ao adequar um
canvas legado, desloque o conjunto inteiro para manter espaçamentos,
alinhamentos e direção de leitura; não comprima os grupos contra a borda.

## Testabilidade obrigatória dos fluxos Node-RED

Todo tab funcional novo ou materialmente alterado deve prever como será testado
sem depender de uma ocorrência real. A política versionada fica em
`nodered/tools/manual-test-policy.json` e é validada por
`npm --prefix nodered run flows:validate-manual-tests`.

- Quando houver estados relevantes para a decisão (`on`/`off`, zonas,
  disponibilidade, armado/desarmado), inclua controles manuais para os estados
  nominais e negativos, um reset explícito e instruções de ordem no canvas.
- Prefira estado sintético cumulativo com `test_mode`, chaves de contexto
  separadas e papéis lógicos. O teste nunca deve sobrescrever entidades ou
  memória persistente de produção.
- O teste sintético deve atravessar a mesma normalização, decisões, gates,
  dedupe e lifecycle da produção até a fronteira final de side effects. Não o
  encerre antecipadamente em um gate apenas para evitar a ação.
- Na fronteira final, separe obrigatoriamente produção e `test_mode`: produção
  segue para os dispositivos; teste segue para um terminal dry-run que registra
  `simulated: true` e `dispatched: false`, sem chamar serviço, MQTT, HTTP,
  `exec`, notificação, desarme, abertura ou qualquer dispositivo.
- Exceção somente quando o usuário pedir explicitamente para testar a entrega
  de uma notificação: o push pode ser o efeito sob teste, deve trazer `TESTE`
  no título e na mensagem, declarar `notification_delivery_under_test` no
  manifesto e manter todos os demais dispositivos em dry-run.
- Para tabs novos ou materialmente alterados, use a estratégia
  `manual_full_dry_run` no manifesto e declare os terminais em
  `dry_run_terminal_ids`. Estratégias manuais legadas não são modelo para novas
  implementações e devem ser migradas quando o respectivo tab for modificado.
- Cada tab precisa declarar uma estratégia no manifesto: teste manual seguro,
  teste manual com efeito explícito, replay automatizado ou não aplicável. As
  duas últimas exigem justificativa; efeitos inseguros não devem ganhar um
  botão manual apenas para satisfazer o gate.
- Altere a fonte geradora, regenere `nodered/flows.json`, acrescente regressão
  automatizada e documente a sequência manual. Converta resultados manuais
  confirmados em casos automatizados reutilizáveis, sem registrar dados
  privados do teste residencial.
