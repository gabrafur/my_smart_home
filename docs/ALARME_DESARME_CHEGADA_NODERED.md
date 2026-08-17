# Desarme confirmado do alarme na chegada

O flow `alarme_desarme_chegada` solicita confirmacao por uma notificacao
acionavel do Home Assistant quando uma chegada real de resident_primary, resident_secondary ou do
vehicle_primary e detectada. O binding publico `alarm_control_panel.security_panel` so e desarmado
depois que alguem toca em `Desarmar`.

## Origem da chegada

O flow nao duplica logica de GPS. Ele recebe, por `link`, apenas contratos
`security.arrival.v1` publicados por `localizacao_pessoas` e
`contexto_vehicle_primary`. Esses flows de dominio ja validam:

- origem `resident_primary`, `resident_secondary` ou `vehicle_primary`;
- entrada no anel `zone.chegando` vinda de fora (`arrival_stage: approach`),
  ou chegada confirmada perto de casa (`arrival_stage: home`);
- precisao do GPS, sentido da travessia e trackers iCloud/mobile_app
  congelados;
- o ciclo de afastamento individual, para nao tratar quem ja estava em casa
  como uma nova chegada.

O contrato v1 agora também traz `event_at` (epoch UTC em milissegundos). Os
produtores persistem dedupe por 10 minutos, portanto um restart não republica
a mesma chegada e não recria uma confirmação. Snapshots stale ou ainda não
ready não geram `security.arrival.v1`; `unknown` nunca é interpretado como
ausência ou chegada.

O aviso de aproximação da resident_secondary é separado do comando de desarme. Se o
contexto do vehicle_primary ainda estiver pendente, o coordenador mantém o candidato por
até 10 min e o libera uma única vez quando puder enriquecê-lo; isso evita perda
ou duplicação durante a ordem variável do startup.

## Condicoes e desarme

1. `Validar chegada real` faz uma segunda validacao da origem, lista
   `payload.arriving` e estagio.
2. `Ler estado atual do alarme` consulta a entidade no Home Assistant.
3. `Alarme esta armado?` so prossegue para `armed_away`. Se estiver
   `disarmed`, `unknown` ou `unavailable`, nenhuma acao e enviada.
4. `Preparar confirmacao (5 min)` cria identificadores de acao exclusivos e
   absorve eventos quase simultaneos, por exemplo resident_secondary e vehicle_primary entrando
   juntos no anel.
5. `Pedir confirmacao no Home Assistant` envia a notificacao aos entities
   os papéis `mobile_primary` e `mobile_secondary` via
   `public_bindings.call`, com os
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

Limitação: a própria confirmação pendente e seus tokens continuam em flow
context volátil. Depois de restart ela expira sem ser retomada; o usuário deve
aguardar uma nova chegada real. Persistir credenciais/tokens de notificação não
faz parte do recovery dos quatro flows de segurança.

## Manutencao

O `nodered/flows.json` versionado e a fonte de verdade. Para validar:

```bash
cd nodered
npm run flows:backup
npm run flows:validate
npm run flows:test-alarm-arrival
```

Depois reinicie o container `nodered` para carregar o arquivo atualizado.
