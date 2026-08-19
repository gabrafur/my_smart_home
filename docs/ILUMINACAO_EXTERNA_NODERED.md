# Iluminacao externa (Node-RED)

Flow `iluminacao_externa` (`nodered/flows.json`, tab
`ce258dec9814b96b`). Esta aba controla somente as luzes e nao consulta nem
recebe eventos do Moni Mobile. O flow `alarme_casa` tambem nao envia comandos
para a iluminacao.

## Objetivo

Controlar `switch.lampada_varanda`, `switch.lampadas_garagem` e
`switch.refletores_jardim` por comando manual ou por do sol. Uma queda do
Node-RED durante o evento solar nunca e compensada com uma ligacao automatica.

## Entradas e conexoes entre flows

- O `DuloNodeHub` fica na aba `integracoes_compartilhadas`, independente dos
  flows consumidores.
- `light_dulo_hub_link_out` -> `light_dulo_hub_link_in` encaminha as mensagens
  do hub ao device "Iluminacao Externa" nesta aba.
- `alarm_dulo_hub_link_out` -> `alarm_dulo_hub_link_in` encaminha as mensagens
  do mesmo hub somente ao device "Alarme Casa", na aba `alarme_casa`. Nao ha
  link entre essa aba e a iluminacao.
- `mobile_app_notification_action` recebe a resposta da notificacao acionavel
  usada apenas para recuperar um por do sol perdido.

## Logica

1. Um comando manual ON/OFF ou uma transicao real de `sun.sun` para
   `below_horizon` prepara o payload para os tres topicos Zigbee2MQTT. O node
   solar usa `outputInitially: false`: iniciar ou redeployar o Node-RED a noite
   nao equivale a um novo por do sol.
2. Quinze segundos depois do boot, o fluxo verifica `sun.sun`. Se ja estiver
   abaixo do horizonte e `last_changed` pertencer a mesma data local, prepara
   uma pergunta com token unico. A notificacao do celular oferece `Ligar` e
   `Nao ligar`; a Alexa faz a mesma pergunta e orienta responder pelo celular.
3. A pergunta e registrada no context store `persistent` somente depois que o
   Home Assistant aceita a notificacao. Ela e deduplicada por data e expira ao
   mudar o dia. Uma resposta `Ligar` ainda revalida que o sol esta abaixo do
   horizonte antes de seguir. Nenhuma resposta da Alexa aciona cargas.
4. `Bloquear se rede Zigbee offline` consulta o estado mantido a partir de
   `zigbee2mqtt/bridge/state` e da conexao do broker MQTT. Se a bridge ou o
   broker estiver offline, nenhum comando e publicado, nenhuma repeticao e
   criada e a Alexa informa a falha.
5. Quando a rede esta disponivel, `Distribuir para topicos Zigbee2MQTT`
   publica em:
   - `zigbee2mqtt/example_exterior_light_1/set`;
   - `zigbee2mqtt/example_exterior_light_2/set`;
   - `zigbee2mqtt/example_exterior_light_3/set`.
6. `Confirmar somente o comando mais recente` aguarda cinco segundos. Um novo
   comando cancela a confirmacao anterior para impedir avisos obsoletos.
7. `Confirmar estados no Home Assistant` le as tres entidades. Estados
   `unknown` ou `unavailable` sao tratados como falha de comunicacao Zigbee;
   a Alexa informa quais pontos ficaram indisponiveis e o comando nao e
   repetido. Divergencias ON/OFF tambem sao anunciadas sem retry.

## Avisos

Os avisos desta aba usam o node `Avisar Alexa`, resolvido pela acao allowlisted
`mobile_primary/notify` em `public_bindings.call`. O flow `alarme_casa` possui
um node de aviso proprio, evitando fios diretos entre abas.

## Historico relevante

- 2026-08-11: o flow foi separado de `alarme_casa`; a comunicacao entre as
  abas passou a usar links explicitos.
- 2026-08-11: adicionados bloqueio por bridge/broker Zigbee offline, aviso da
  Alexa sem retry, confirmacao apenas do comando mais recente e verificacao de
  que o alarme esta desarmado antes de ligar no por do sol.
- 2026-08-17: a inicializacao passou a reavaliar o estado atual do sol, e o
  DuloNodeHub recebeu retry exponencial para falhas transitorias de DNS no boot.
- 2026-08-19: removido todo acoplamento com o Moni Mobile. A reavaliacao
  automatica no boot foi substituida por confirmacao no celular, anunciada
  tambem na Alexa, somente na mesma data local do por do sol perdido.

## Testes e manutencao

```bash
cd nodered
npm run flows:validate
npm run flows:test-external-lighting
npm run flows:test-alarm-house
```

Depois de alterar `flows.json`, faca Deploy no editor ou reinicie o container
Node-RED de forma segura.
