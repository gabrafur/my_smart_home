# Alarme da casa (Node-RED)

Flow `alarme_casa` (`nodered/flows.json`, tab `alarm_house_tab`). Ele é a fonte
canônica para decidir, registrar e executar armamento/desarmamento pelo binding
lógico `security_panel`. A política, as decisões, os retries, os gates de teste
e os avisos ficam visíveis no canvas. Não há troca de eventos ou comandos com o
flow `iluminacao_externa`.

## Entradas

- O device DuloNode "Alarme Casa" recebe comandos Alexa PowerController
  ON/OFF. O hub Dulo fica na aba `integracoes_compartilhadas` e chega aqui por
  `alarm_dulo_hub_link_out` -> `alarm_dulo_hub_link_in`.
- O evento `node_red_moni_mobile_arm` solicita `arm` ou `disarm`; a ausência de
  `action` continua significando `arm` por compatibilidade.
- O script CarPlay preserva o mesmo identificador, mas agora publica esse evento
  em vez de contornar a política com uma chamada direta ao alarme.
- `alarm_arrival_disarm_command_in` recebe somente pedidos confirmados pela
  notificacao acionavel do flow `alarme_desarme_chegada`.
- Os controles `TESTE 1` a `TESTE 4` usam estado sintético isolado e terminam no
  terminal dry-run. Não há inject manual ligado a um serviço real.

## Política visual

O grupo azul `0. Política visual — edite os valores` contém a única definição
dos parâmetros abaixo. Cada controle informa valor e unidade no nome; o
validador mantém a última configuração persistente válida quando recebe valor
fora do limite.

- intervalo de retry: **10 s**, inteiro entre 1 e 300 s;
- periodicidade do aviso: **5 tentativas**, inteiro entre 1 e 100;
- limite de tentativas: **0 (sem limite)**, entre 0 e 1.000.

O valor padrão `0` preserva o retry indefinido anterior. Alterá-lo para um valor
positivo é uma mudança operacional explícita e visível.

## Armar e desarmar

Os comandos de armar e desarmar usam as ações allowlisted `arm_away` e
`disarm` do papel `security_panel` por `public_bindings.call`.

- Todas as entradas convergem na decisão visual `Decisão canônica: armar ou
  desarmar?`. O estado novo fica em `alarm_house_state_v1`; `flow.alarm_desired`
  continua sendo atualizado como ponte reversível para a versão anterior.
- Falhas da integração Moni Mobile passam pelos blocos visuais `Retry permitido
  pelo limite?`, `Avisar na 1ª / a cada N / no limite?` e `A intenção ainda é a
  mesma?`.
- Um retry obsoleto é cancelado quando uma intenção oposta chega durante a
  espera. Reiniciar o Node-RED não reproduz automaticamente uma ação de
  segurança: a política e a última intenção são recuperadas, mas um comando
  interrompido exige uma nova solicitação.
- O aviso de falha ocorre na primeira falha e depois conforme a periodicidade
  visual. O efeito usa o papel lógico `mobile_primary`.
- Depois de um armamento aceito, `Atualizar estado Moni Mobile` solicita a
  atualizacao da entidade antes do aviso de sucesso.

Os retries acima pertencem somente à comunicação da central Moni Mobile. Erros
da rede Zigbee na aba `iluminacao_externa` nunca geram retry.

## Teste seguro e rollback

Execute no canvas: `TESTE 1: reset`, `TESTE 2: pedir armar`, `TESTE 3: falha ao
armar` e `TESTE 4: pedir desarmar`. Aguarde 10 s após a falha para observar o
retry ou peça o desarme antes do prazo para validar o cancelamento. As entradas
sintéticas percorrem adaptação, estado, decisões, delay e gates finais; na
fronteira dos efeitos, o log contém `ALARM_HOUSE_DRY_RUN`, `simulated: true` e
`dispatched: false`.

Para rollback, restaure `nodered/flows.json`, o gerador e este pacote a partir
do Git e reinicie somente o Node-RED. A entidade, o binding, os IDs dos scripts,
os links de chegada e os IDs dos serviços foram preservados.

## Historico relevante

- 2026-08-11: o controle foi retirado da antiga aba
  `iluminacao_externa_alarme` e passou para `alarme_casa`. O hub Dulo ficou
  compartilhado por links e cada aba passou a ter seu proprio node de aviso.
- 2026-08-11: o `DuloNodeHub` foi movido para a aba
  `integracoes_compartilhadas`, permitindo que qualquer flow o consuma por
  pares `link out`/`link in` sem acoplamento a uma automacao especifica.
- 2026-08-02: os guards de `flow.alarm_desired` passaram a impedir que um
  retry antigo reverta o ultimo comando do usuario.
- 2026-07-09: estados transitorios `unknown`/`unavailable` deixaram de contar
  como mudanca real do alarme; o retry de armamento e os avisos periodicos
  foram adicionados.
- 2026-07-10: o mesmo retry protegido foi aplicado ao desarmamento.
- 2026-08-19: removidos o observador e os links que desligavam a iluminacao
  externa ao armar. Alarme e iluminacao passaram a ser independentes nos dois
  sentidos.

## Testes e manutencao

```bash
cd nodered
npm run flows:validate
npm run flows:test-alarm-house
npm run flows:test-alarm-arrival
```

Para regenerar a implementação visual de forma idempotente, use
`npm run flows:update-alarm-house`. O comando legado
`npm run flows:split-alarm-house` aponta para o mesmo gerador. Depois execute os
validadores de layout/render e reinicie somente o Node-RED de forma segura.
