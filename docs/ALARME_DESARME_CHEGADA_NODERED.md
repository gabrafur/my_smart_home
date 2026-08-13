# Desarme confirmado do alarme na chegada

O flow `alarme_desarme_chegada` solicita confirmacao por uma notificacao
acionavel do Home Assistant quando uma chegada real de Gabriel, Valeria ou do
Creta e detectada. O `alarm_control_panel.alarme_moni_mobile` so e desarmado
depois que alguem toca em `Desarmar`.

## Origem da chegada

O flow nao duplica logica de GPS. Ele recebe, por `link`, apenas contratos
`security.arrival.v1` publicados por `localizacao_pessoas` e
`contexto_creta`. Esses flows de dominio ja validam:

- origem `gabriel`, `valeria` ou `creta`;
- entrada no anel `zone.chegando` vinda de fora (`arrival_stage: approach`),
  ou chegada confirmada perto de casa (`arrival_stage: home`);
- precisao do GPS, sentido da travessia e trackers iCloud/mobile_app
  congelados;
- o ciclo de afastamento individual, para nao tratar quem ja estava em casa
  como uma nova chegada.

## Condicoes e desarme

1. `Validar chegada real` faz uma segunda validacao da origem, lista
   `payload.arriving` e estagio.
2. `Ler estado atual do alarme` consulta a entidade no Home Assistant.
3. `Alarme esta armado?` so prossegue para `armed_away`. Se estiver
   `disarmed`, `unknown` ou `unavailable`, nenhuma acao e enviada.
4. `Preparar confirmacao (5 min)` cria identificadores de acao exclusivos e
   absorve eventos quase simultaneos, por exemplo Valeria e Creta entrando
   juntos no anel.
5. `Pedir confirmacao no Home Assistant` envia a notificacao aos entities
   `notify.iphone_de_gabriel_furlan` e `notify.iphone_de_valeria`, com os
   botoes `Desarmar` e `Manter armado`.
6. `Resposta da notificacao` escuta
   `mobile_app_notification_action`. `Validar confirmacao pendente` aceita
   somente o token da solicitacao atual e dentro do prazo de cinco minutos.
   Cancelamentos, tokens diferentes, respostas vencidas e uma segunda
   resposta sao ignorados.
7. Apenas depois da confirmacao, o pedido entra por `link` em
   `alarm_set_desired_disarm`, no flow
   `alarme_casa`. Assim reutiliza o desarme existente, incluindo
   retry indefinido, cancelamento de retry obsoleto e avisos de sucesso/falha.

O flow nao contem nem duplica o codigo de acionamento do alarme. Ele apenas
valida a chegada e a confirmacao humana antes de chamar a cadeia compartilhada.

## Manutencao

O `nodered/flows.json` versionado e a fonte de verdade. Para validar:

```bash
cd nodered
npm run flows:backup
npm run flows:validate
npm run flows:test-alarm-arrival
```

Depois reinicie o container `nodered` para carregar o arquivo atualizado.
