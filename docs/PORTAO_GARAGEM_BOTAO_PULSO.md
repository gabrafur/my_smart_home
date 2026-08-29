# Portão da garagem — pulso único no Node-RED

Complemento de [`PORTAO_GARAGEM_RELE_LOCAL.md`](PORTAO_GARAGEM_RELE_LOCAL.md).
O Node-RED é o único controlador do pulso físico; o Home Assistant mantém apenas
a entidade do botão no dashboard e uma proteção independente para relé preso.

## Contrato físico

`switch.rele_acionador_portao` é um contato seco na entrada de botoeira da
central. Cada `ON` é uma ação física real — abrir, fechar, parar ou inverter.
Não existe sensor de posição; o estado do relé representa somente o contato.

Regras:

- um pedido aceito produz exatamente `ON → 700 ms → OFF`;
- não existe retry de `ON`;
- o cooldown começa antes da publicação do `ON`;
- um relé cujo último estado MQTT reportado ainda seja `ON` recebe somente
  `OFF`; um novo `ON` é recusado;
- o estado final esperado é sempre `OFF`.

O `TS0001` não honra `on_time`/`onWithTimedOff`. Por isso o pulso é feito
por software com dois comandos simples.

## Entradas

As duas entradas convergem no nó `validar pedido (dedupe + cooldown 1 s)` da
aba `garagem`:

| Fonte | Caminho |
|---|---|
| Botão Zigbee físico | MQTT `action=single` → Node-RED |
| `button.acionar_portao_da_garagem` | evento local `portao_garagem_pulso_solicitado` → Node-RED |

O botão template do Home Assistant só emite o evento. O antigo
`script.portao_garagem_pulso`, seus helpers de timestamp e a automação que
sincronizava o cooldown foram removidos; não há mais dois controladores
concorrentes.

## Temporização e dedupe

- largura do pulso: **700 ms**;
- dedupe do mesmo aperto Zigbee: **900 ms**;
- cooldown entre pulsos aceitos: **1.000 ms**, contado desde o início do pulso;
- coalescência de comando/estado MQTT: o observador atualiza o mesmo timestamp,
  sem produzir um segundo pulso.

A janela deixa 300 ms entre o `OFF` esperado e a próxima aceitação. O
normalizador grava `portao_garagem_last_pulse_ms` antes do `ON`, fechando a
corrida entre o botão físico e o botão do dashboard.

## Proteções

1. Payloads diferentes de `single` são descartados.
2. Retransmissões em menos de 900 ms são descartadas.
3. Qualquer novo pedido em menos de 1.000 ms é descartado.
4. Se o tópico de estado reportou `ON`, o fluxo envia somente `OFF`, gera
   alerta persistente e não movimenta o portão novamente.
5. O tópico de comando e o tópico de estado observam também pulsos externos e
   armam o mesmo cooldown.
6. A automação `portao_garagem_rele_preso_em_on` continua no Home Assistant
   como proteção independente: após 5 s em `ON`, envia somente `OFF` e
   alerta. Ela cobre uma queda do Node-RED durante o delay de 700 ms.
7. Não existe gatilho de startup nem mensagem MQTT retida de comando.

O pulso aceito é registrado no Logbook pelo próprio Node-RED com origem,
largura e cooldown.

O relé deve continuar oculto no registro de entidades e fora dos assistentes
de voz. Essas opções vivem no `.storage` privado e não são restauradas por um
clone. Um administrador ainda consegue chamar `switch.turn_on` diretamente;
o observador do Node-RED arma o cooldown para esse pulso e a automação de 5 s
limita o tempo de contato, mas ocultar a entidade não é uma ACL.

## Fonte e validação

A fonte geradora canônica é
`nodered/tools/configure-garage-gate-flow.mjs`. Para regenerar em um arquivo
alternativo:

```bash
npm --prefix nodered run flows:update-garage-gate -- /tmp/flows.json
```

O tab declara estratégia `automated_only` porque um botão manual de teste
movimentaria fisicamente o portão. O replay seguro é:

```bash
node nodered/tools/test-garage-gate-dashboard-event.mjs
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render -- garagem
```

O replay cobre as duas entradas, o limite de 999/1.000 ms, dedupe, recusa com
estado `ON`, atualização do estado observado e payloads MQTT `ON`/`OFF`.
Ele não publica no broker e não movimenta o portão.

## Deploy

Alterar `flows.json` não faz deploy automaticamente. Depois das validações e
da inspeção do canvas, reinicie ou faça deploy do Node-RED pelo procedimento
operacional normal. Recarregue o package do Home Assistant para que o botão
passe a emitir o evento local.

Não valide com um inject ligado ao caminho real. Qualquer teste físico deve ser
deliberado, com a área livre, e produz movimento do portão.

## Rollback

A cena RF Tuya e o `script.portao_garagem_acionar` permanecem apenas como
fallback legado. Reabilitar esse caminho é uma decisão manual; não conecte as
duas implementações ao mesmo botão simultaneamente.
