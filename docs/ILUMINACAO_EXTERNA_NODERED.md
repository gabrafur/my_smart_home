# Iluminacao externa (Node-RED)

Flow `iluminacao_externa` (`nodered/flows.json`, tab `ce258dec9814b96b`).

## Objetivo

Controlar `switch.lampada_varanda`, `switch.lampadas_garagem` e
`switch.refletores_jardim` por comando manual, por do sol, e desligar tudo
automaticamente quando o alarme (`alarm_control_panel.alarme_moni_mobile`,
integracao `moni_mobile`) e armado. O mesmo flow tambem expoe o device
"Alarme Casa" (armar/desarmar) para Alexa via `node-red-contrib-dulonode`.

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

## Armar/Desarmar Alarme (device "Alarme Casa")

O device DuloNode "Alarme Casa" (`de18d31309e8a0ca`) recebe comandos
Alexa PowerController ON/OFF e chama `alarm_control_panel.alarm_arm_away`
(node `Armar Alarme`, `70eb073f8191e69e`) ou `alarm_control_panel.alarm_disarm`
(node `Desarmar Alarme`, `8261c7cfb6756ca8`) na entidade
`alarm_control_panel.alarme_moni_mobile`.

- **Retry ate conseguir armar** (`arm_alarm_catch` -> `arm_alarm_retry_decision`
  -> `arm_alarm_retry_delay` -> volta para `Armar Alarme`): a integracao
  `moni_mobile` fala com um servidor TCP proprietario remoto que
  frequentemente falha o handshake/confirmacao (`HomeAssistantError:
  Servidor Moni Mobile nao confirmou o arme`, etc.). Um node `catch`
  escopado so ao node `Armar Alarme` pega qualquer erro desse tipo, espera
  ~10-15s (com jitter) e tenta de novo, indefinidamente, ate a chamada ter
  sucesso. Avisa no Alexa (via `Avisar Alexa`) na primeira falha e depois a
  cada 5 tentativas, para nao spammar mas manter o usuario informado que o
  alarme ainda nao foi armado.
- **Aviso de sucesso**: tanto `Armar Alarme` quanto `Desarmar Alarme`, ao
  terminar com sucesso, seguem para um node `change` que define
  `notify_text` ("Alarme armado com sucesso." / "Alarme desarmado com
  sucesso.") e chama `Avisar Alexa`.
- `Desarmar Alarme` **nao** tem retry automatico — falhas ao desarmar nao
  sao repetidas sozinhas hoje.

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

- 2026-07-09: `Armar Alarme` falhava com frequencia
  (`HomeAssistantError: Servidor Moni Mobile nao confirmou o arme`) sem
  nenhuma tentativa automatica de repeticao, deixando a casa sem alarme
  armado ate alguem notar e tentar de novo manualmente. Adicionado retry
  indefinido (`arm_alarm_catch`/`arm_alarm_retry_decision`/
  `arm_alarm_retry_delay`, ver secao acima) e avisos no Alexa de
  sucesso/falha para `Armar Alarme` e `Desarmar Alarme`. Testado ao vivo:
  injecao manual disparou `Armar Alarme` e a entidade confirmou
  `armed_away` na primeira tentativa.

## Manutencao

Sempre que este flow for alterado (logica de confirmacao, filtro do alarme,
entidades envolvidas), atualizar esta doc na mesma mudanca.
