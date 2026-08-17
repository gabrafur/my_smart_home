# Iluminacao externa (Node-RED)

Flow `iluminacao_externa` (`nodered/flows.json`, tab
`ce258dec9814b96b`). O controle do alarme foi separado para o flow
`alarme_casa`; esta aba contem apenas o controle das luzes e a reacao ao evento
"alarme armado".

## Objetivo

Controlar `switch.lampada_varanda`, `switch.lampadas_garagem` e
`switch.refletores_jardim` por comando manual ou por do sol, desligando tudo
quando o flow `alarme_casa` informa um armamento real.

## Entradas e conexoes entre flows

- O `DuloNodeHub` fica na aba `integracoes_compartilhadas`, independente dos
  flows consumidores.
- `light_dulo_hub_link_out` -> `light_dulo_hub_link_in` encaminha as mensagens
  do hub ao device "Iluminacao Externa" nesta aba.
- `alarm_dulo_hub_link_out` -> `alarm_dulo_hub_link_in` encaminha as mensagens
  do mesmo hub ao device "Alarme Casa", na aba `alarme_casa`. O DuloNode
  reconhece oficialmente esse caminho por `link out`/`link in`, portanto nao e
  necessario duplicar o hub.
- `ext_alarm_armed_lighting_in` recebe de `alarm_armed_lighting_out` somente
  uma mudanca real para `armed_away` e aciona `Definir OFF ao armar`.

## Logica

1. Um comando manual ON/OFF ou o evento de por do sol prepara o payload para
   os tres topicos Zigbee2MQTT.
2. O por do sol so prossegue quando
   `alarm_control_panel.alarme_moni_mobile` esta `disarmed`; assim ele nao
   religa as luzes depois que a casa foi armada.
3. `Bloquear se rede Zigbee offline` consulta o estado mantido a partir de
   `zigbee2mqtt/bridge/state` e da conexao do broker MQTT. Se a bridge ou o
   broker estiver offline, nenhum comando e publicado, nenhuma repeticao e
   criada e a Alexa informa a falha.
4. Quando a rede esta disponivel, `Distribuir para topicos Zigbee2MQTT`
   publica em:
   - `zigbee2mqtt/example_exterior_light_1/set`;
   - `zigbee2mqtt/example_exterior_light_2/set`;
   - `zigbee2mqtt/example_exterior_light_3/set`.
5. `Confirmar somente o comando mais recente` aguarda cinco segundos. Um novo
   comando cancela a confirmacao anterior para impedir avisos obsoletos.
6. `Confirmar estados no Home Assistant` le as tres entidades. Estados
   `unknown` ou `unavailable` sao tratados como falha de comunicacao Zigbee;
   a Alexa informa quais pontos ficaram indisponiveis e o comando nao e
   repetido. Divergencias ON/OFF tambem sao anunciadas sem retry.

## Avisos

Os avisos desta aba usam o node `Avisar Alexa`
(`notify.alexa_media_echo_dot_de_resident_primary`). O flow `alarme_casa` possui um
node de aviso proprio, evitando fios diretos entre abas.

## Historico relevante

- 2026-08-11: o flow foi separado de `alarme_casa`; a comunicacao entre as
  abas passou a usar links explicitos.
- 2026-08-11: adicionados bloqueio por bridge/broker Zigbee offline, aviso da
  Alexa sem retry, confirmacao apenas do comando mais recente e verificacao de
  que o alarme esta desarmado antes de ligar no por do sol.

## Testes e manutencao

```bash
cd nodered
npm run flows:validate
npm run flows:test-external-lighting
npm run flows:test-alarm-house
```

Depois de alterar `flows.json`, faca Deploy no editor ou reinicie o container
Node-RED de forma segura.
