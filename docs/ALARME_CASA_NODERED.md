# Alarme da casa (Node-RED)

Flow `alarme_casa` (`nodered/flows.json`, tab `alarm_house_tab`). Ele concentra
o controle do binding publico `alarm_control_panel.security_panel`, os retries e os avisos
do alarme. A iluminacao externa permanece no flow `iluminacao_externa`.

## Entradas

- O device DuloNode "Alarme Casa" recebe comandos Alexa PowerController
  ON/OFF. O hub Dulo fica na aba `integracoes_compartilhadas` e chega aqui por
  `alarm_dulo_hub_link_out` -> `alarm_dulo_hub_link_in`.
- O evento `node_red_moni_mobile_arm` solicita armamento.
- `alarm_arrival_disarm_command_in` recebe somente pedidos confirmados pela
  notificacao acionavel do flow `alarme_desarme_chegada`.
- Os injects sem nome permitem testes manuais de armar e desarmar no editor.

## Armar e desarmar

Os comandos de armar e desarmar usam as ações allowlisted `arm_away` e
`disarm` do papel `security_panel` por `public_bindings.call`.

- Antes da chamada, `alarm_set_desired_arm` ou
  `alarm_set_desired_disarm` grava a ultima intencao em
  `flow.alarm_desired`.
- Falhas da integracao Moni Mobile entram em retry indefinido, com intervalo
  de dez segundos: `arm_alarm_*` para armar e `disarm_alarm_*` para desarmar.
- `alarm_guard_arm` e `alarm_guard_disarm` cancelam um retry obsoleto quando o
  usuario pediu a acao oposta nesse meio-tempo.
- A Alexa e avisada na primeira falha e depois a cada cinco tentativas. O node
  `Avisar Alexa - alarme` e exclusivo desta aba.
- Depois de um armamento aceito, `Atualizar estado Moni Mobile` solicita a
  atualizacao da entidade antes do aviso de sucesso.

Os retries acima pertencem somente a comunicacao da central Moni Mobile. Erros
da rede Zigbee na aba `iluminacao_externa` nunca geram retry.

## Evento de alarme armado para a iluminacao

`Alarme armado` observa `armed_away`. Como a integracao usa polling,
`Somente se alarme mudou` elimina polls repetidos e ignora os estados
transitorios `unknown`/`unavailable`, usando o ultimo estado real no flow
context quando necessario.

Uma mudanca real segue por `alarm_armed_lighting_out` para
`ext_alarm_armed_lighting_in`, na aba `iluminacao_externa`. A aba de alarme
publica apenas o evento; a decisao e o comando MQTT das luzes permanecem na
aba de iluminacao.

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

## Testes e manutencao

```bash
cd nodered
npm run flows:validate
npm run flows:test-alarm-house
npm run flows:test-alarm-arrival
```

Para reaplicar a separacao de forma idempotente, use
`npm run flows:split-alarm-house`. Depois faca Deploy no editor ou reinicie o
container Node-RED de forma segura.
