# Desarme automatico do alarme na chegada

O flow `alarme_desarme_chegada` desarma
`alarm_control_panel.alarme_moni_mobile` quando uma chegada real de Gabriel,
Valeria ou do Creta e detectada.

## Origem da chegada

O flow nao duplica logica de GPS. Ele recebe, por `link`, apenas a saida
positiva de `sec_detect_arriving_source`, no flow `iluminacao_seguranca`.
Esse detector ja valida:

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
4. `Evitar pedidos duplicados (60 s)` absorve eventos quase simultaneos, por
   exemplo Valeria e Creta entrando juntos no anel.
5. O pedido entra por `link` em `alarm_set_desired_disarm`, no flow
   `iluminacao_externa_alarme`. Assim reutiliza o desarme existente, incluindo
   retry indefinido, cancelamento de retry obsoleto e avisos de sucesso/falha.

O flow novo nao contem nem duplica o codigo do alarme.

## Manutencao

Para reinstalar de forma idempotente e validar:

```bash
cd nodered
npm run flows:backup
npm run flows:install-alarm-arrival
npm run flows:validate
npm run flows:test-alarm-arrival
```

Depois reinicie o container `nodered` para carregar o arquivo atualizado.
