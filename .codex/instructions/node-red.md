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

## Observabilidade e notificação obrigatórias

Todo tab funcional versionado deve participar do observador global de falhas.
Erros de nós, status persistente de indisponibilidade e perda da conexão com o
Home Assistant ou MQTT precisam convergir no canal central que notifica
`resident_primary` pelo binding lógico `mobile_primary`. A indisponibilidade do
próprio Node-RED deve ser detectada por watchdog nativo no Home Assistant,
independente do runtime observado.

- Depois de criar, remover ou alterar materialmente um tab, execute
  `npm --prefix nodered run flows:update-global-observer` e regenere
  `nodered/flows.json`. O gerador deve permanecer idempotente.
- Execute `npm --prefix nodered run flows:validate-observability`; o gate deve
  falhar se qualquer tab não tiver `catch`, `status`, identificação do tab e
  rota nomeada para o monitor central. Nunca exclua um tab funcional para fazer
  o gate passar.
- O monitor deve deduplicar incidentes, confirmar status transitório antes do
  push e impedir recursão se o próprio canal de notificação falhar. Quando o
  Home Assistant estiver indisponível, preserve `queue: all`; o alerta só pode
  ser entregue quando o serviço voltar e essa limitação deve continuar
  documentada.
- Status vermelho isolado, condição de domínio e erro de chamada de serviço não
  provam queda da conexão compartilhada. Incidentes de Home Assistant e MQTT
  devem exigir texto explícito de desconexão ou indisponibilidade e possuir
  regressão que impeça o alerta duplicado de erro mais queda global falsa.
- Todo tab novo ou materialmente alterado deve manter replay automatizado de
  falha e indisponibilidade até o terminal dry-run compartilhado, sem produzir
  efeitos residenciais.
- Antes de deploy, commit ou push de qualquer alteração Node-RED, execute uma
  única vez o inject canônico `TESTE 5: enviar push real` do tab
  `observabilidade_global`. Confirme no log
  `NODERED_GLOBAL_NOTIFICATION_ACCEPTED ... delivery_test=true` e solicite ao
  usuário a confirmação visual no celular quando a tarefa exigir confirmação
  ponta a ponta. O título e a mensagem devem conter `TESTE`; não use nós de
  produção individuais para esse smoke test.
- Se o smoke test não puder ser entregue porque Home Assistant, MQTT, WAN ou o
  binding estão indisponíveis, não declare a validação concluída nem contorne o
  gate: mantenha o resultado pendente e repita somente após a recuperação.
