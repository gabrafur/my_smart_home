# Iluminacao externa (Node-RED)

Flow `iluminacao_externa` (`nodered/flows.json`, tab `ce258dec9814b96b`).

## Objetivo

Controlar `switch.lampada_varanda`, `switch.lampadas_garagem` e
`switch.refletores_jardim` por comando manual, por do sol, e desligar tudo
automaticamente quando o alarme (`alarm_control_panel.alarme_moni_mobile`,
integracao `moni_mobile`) e armado.

## Entidades usadas

- `switch.lampada_varanda`, `switch.lampadas_garagem`, `switch.refletores_jardim`
- `sun.sun` (por do sol)
- `alarm_control_panel.alarme_moni_mobile`

## Logica

1. Comando manual (device DuloNode) ou por do sol define ON/OFF e alimenta
   `Distribuir para tópicos Zigbee2MQTT` (publica nos 3 topicos MQTT) e o
   caminho de confirmacao (`Aguardar confirmação das luzes` -> `Confirmar
   estados no Home Assistant` -> `Montar aviso confirmado` -> `Avisar Alexa`).
2. `Alarme armado` (`server-state-changed`, `ifState: armed_away`,
   `outputOnlyOnStateChange: false`) dispara sempre que o estado atual da
   entidade do alarme e `armed_away` — inclusive em atualizacoes de poll sem
   mudanca real, porque a integracao `moni_mobile` usa polling
   (`_attr_should_poll = True`).
3. `Somente se alarme mudou` (function) filtra esses disparos para so deixar
   passar quando o alarme realmente mudou de estado, comparando
   `old_state`/`new_state` do evento (com fallback em cache no flow context,
   chave `last_alarm_state:<entity_id>`, para quando o evento nao traz
   `old_state`).
4. Se passou pelo filtro, `Definir OFF ao armar` forca as 3 lampadas para
   `OFF` e ajusta o texto do aviso.
5. O caminho de confirmacao aguarda alguns segundos, confere o estado real
   das 3 entidades no Home Assistant e so entao chama `Avisar Alexa`
   (`notify.alexa_media_echo_dot_de_gabriel`) com o resultado (sucesso ou
   lista do que falhou).

## Historico relevante

- 2026-07-09: a entidade `moni_mobile` por vezes reporta `unknown` por
  alguns segundos durante o processo de armar (glitch de parsing do
  protocolo TCP proprietario, ver
  [INTEGRACAO_MONI_MOBILE_INTELBRAS.md](INTEGRACAO_MONI_MOBILE_INTELBRAS.md)).
  Isso criava uma sequencia real `disarmed -> unknown -> armed_away`; a
  transicao `unknown -> armed_away` era tratada como mudanca genuina pelo
  filtro antigo e reenviava o aviso "luzes desligadas" no Alexa mais de uma
  vez por armamento. Corrigido em `Somente se alarme mudou`: estados
  `unknown`/`unavailable` agora sao ignorados (nao repassam mensagem, nao
  atualizam o cache), e quando o `old_state` do proprio evento e `unknown`,
  a comparacao usa o ultimo estado real salvo no flow context em vez do
  glitch. Assim `armed_away -> unknown -> armed_away` nao dispara um segundo
  aviso.

## Manutencao

Sempre que este flow for alterado (logica de confirmacao, filtro do alarme,
entidades envolvidas), atualizar esta doc na mesma mudanca.
