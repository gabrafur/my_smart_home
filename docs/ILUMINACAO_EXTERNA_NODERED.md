# Iluminacao externa (Node-RED)

Flow `iluminacao_externa` (`nodered/flows.json`, tab
`ce258dec9814b96b`). Esta aba controla somente as luzes e nao consulta nem
recebe eventos do Moni Mobile. O flow `alarme_casa` tambem nao envia comandos
para a iluminacao.

## Objetivo

Controlar `switch.lampada_varanda`, `switch.lampadas_garagem` e
`switch.refletores_jardim`, além de `switch.abajour_sala_de_estar`, por comando
manual, por do sol e amanhecer. Uma
queda do Node-RED durante o evento solar nunca e compensada com uma ligacao
automatica.

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
   `below_horizon` prepara o payload para os quatro destinos Zigbee2MQTT. O node
   solar usa `outputInitially: false`: iniciar ou redeployar o Node-RED a noite
   nao equivale a um novo por do sol.
2. Uma transicao real de `sun.sun` para `above_horizon` prepara diariamente um
   comando OFF com origem `sunrise`, que percorre a mesma disponibilidade,
   distribuicao e confirmacao dos comandos manuais. Esse node tambem usa
   `outputInitially: false`, portanto um redeploy durante o dia nao simula um
   novo amanhecer. O sucesso e silencioso para nao gerar anuncio diario na
   Alexa; falha Zigbee ou luz ainda ligada continua produzindo alerta.
3. Quinze segundos depois do boot, o fluxo verifica `sun.sun`. Se ja estiver
   abaixo do horizonte e `next_setting` apontar para uma data local futura, prepara
   uma pergunta com token unico. A notificacao do celular oferece `Ligar` e
   `Nao ligar`; a Alexa faz a mesma pergunta e orienta responder pelo celular.
   A madrugada anterior ao proximo por do sol nao gera pergunta. `last_changed`
   nao comprova o horario astronomico, pois pode mudar ao reiniciar o HA.
4. A pergunta e registrada no context store `persistent` somente depois que o
   Home Assistant aceita a notificacao. Ela e deduplicada por data e expira ao
   mudar o dia. Uma resposta `Ligar` ainda revalida que o sol esta abaixo do
   horizonte antes de seguir. Nenhuma resposta da Alexa aciona cargas.
5. `Bloquear se rede Zigbee offline` consulta o estado mantido a partir de
   `zigbee2mqtt/bridge/state` e da conexao do broker MQTT. Se a bridge ou o
   broker estiver offline, nenhum comando e publicado, nenhuma repeticao e
   criada e a Alexa informa a falha.
6. Quando a rede esta disponivel, `Distribuir para topicos Zigbee2MQTT`
   publica em:
   - `zigbee2mqtt/example_exterior_light_1/set`;
   - `zigbee2mqtt/example_exterior_light_2/set`;
   - `zigbee2mqtt/example_exterior_light_3/set`;
   - `zigbee2mqtt/example_exterior_light_4/set`.
7. `Confirmar somente o comando mais recente` aguarda cinco segundos. Um novo
   comando cancela a confirmacao anterior para impedir avisos obsoletos.
8. `Confirmar estados no Home Assistant` lê os quatro destinos. Confirmação do
   comando exige observação válida posterior à intenção. Um estado `on` que
   permaneceu `on`, com data anterior ao comando, não comprova falha nem um novo
   aceite do comando: se todos os estados coincidem com o solicitado, o fluxo
   permanece silencioso e a confirmação continua `unconfirmed`.
9. Somente uma leitura válida posterior ao comando, com `on` ou `off` oposto
   ao esperado, gera aviso de divergência. `unknown`, `unavailable`, ausência ou
   data antiga permanecem `unconfirmed`, sem aviso de falha e sem repetir o
   comando. O estado geral do Zigbee2MQTT não confirma o estado individual de
   uma lâmpada. A indisponibilidade de leitura não abre incidente nem gera uma
   recuperação quando a leitura volta. Incidente real por divergência permanece
   aberto durante um intervalo inconclusivo, sem repetir o mesmo aviso; somente
   observações novas de todos os destinos podem encerrá-lo. Avisos legados de
   indisponibilidade ou estados antigos não viram recuperações fictícias.

## Avisos

Os avisos desta aba chamam o hub Alexa com o target lógico
`voice_assistant_primary`. Somente o hub conhece a ação allowlisted
`mobile_primary/notify`. O flow `alarme_casa` possui seu próprio adaptador para
o mesmo hub, evitando fios diretos entre fluxos de negócio.

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
- 2026-10-07: adicionado desligamento diario no amanhecer pelo mesmo pipeline
  canonico dos comandos manuais, com cobertura automatizada e teste dry-run.

## Testes e manutencao

```bash
cd nodered
npm run flows:validate
npm run flows:test-external-lighting
npm run flows:test-alarm-house
```

No grupo de testes do canvas, execute `TESTE 1: reset` e depois
`TESTE 5: amanhecer`. O terminal deve registrar `simulated: true` e
`dispatched: false`, sem publicar MQTT nem chamar Alexa ou notificacao.

Depois de alterar a fonte geradora, regenere o flow e valide o diff. Para uma
mudança de função, faça deploy somente dos nós alterados, com revisão da versão
carregada e releitura posterior. Não é necessário reiniciar o container nem
acionar luzes para testar a classificação. A regressão sintética específica é
`node --test tools/test-external-lighting-matching-state.mjs` dentro de `nodered`.
