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
por software com dois comandos simples. O nó `change`
`Aplicar largura da política` fornece `msg.delay` ao nó `delay`; não existe uma
segunda largura escondida em JavaScript.

## Entradas

As duas entradas convergem em `Adaptar envelope do pedido`, passam pelo
`switch` `Ação é single, probe ou inválida?`, carregam a política visual e são
avaliadas sem efeitos em `Avaliar tempos e estado (sem efeitos)`:

| Fonte | Caminho |
|---|---|
| Botão Zigbee físico | MQTT `action=single` → Node-RED |
| `button.acionar_portao_da_garagem` | evento local `portao_garagem_pulso_solicitado` → Node-RED |

O botão template do Home Assistant só emite o evento. O antigo
`script.portao_garagem_pulso`, seus helpers de timestamp e a automação que
sincronizava o cooldown foram removidos; não há mais dois controladores
concorrentes.

## Política visual, temporização e dedupe

O grupo `0. Política visual — edite os valores` é a fonte única dos quatro
parâmetros. Cada `inject` mostra nome, unidade e valor padrão:

- largura do pulso: **700 ms**;
- dedupe do mesmo aperto Zigbee: **900 ms**;
- cooldown entre pulsos aceitos: **1.000 ms**, contado desde o início do pulso;
- coalescência de comando/estado MQTT: **500 ms**; o observador atualiza o
  mesmo timestamp sem produzir um segundo pulso.

O validador aceita apenas inteiros dentro dos limites documentados no próprio
canvas. Também exige `pulso < cooldown` e
`coalescência <= dedupe <= cooldown`. Um valor inválido gera erro observável e
não substitui a última política persistente válida.

A janela deixa 300 ms entre o `OFF` esperado e a próxima aceitação. O
normalizador grava `portao_garagem_last_pulse_ms` antes do `ON`, fechando a
corrida entre o botão físico e o botão do dashboard.

## Proteções

1. Payloads diferentes de `single` seguem para um terminal diagnóstico sem
   efeitos.
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

O bloco `Decisão: pulso, OFF seguro ou bloqueio?` torna os três resultados
visíveis. Depois dele, gates independentes separam produção de `test_mode`.
Somente produção pode chegar ao MQTT, ao Logbook ou à notificação. O pulso
aceito é registrado no Logbook pelo próprio Node-RED com origem, largura e
cooldown vindos da política.

O estado de teste usa `garage_gate_test_state_v1`, separado da produção. O
estado canônico de produção usa `garage_gate_state_v1`. Durante a migração, os
timestamps legados continuam sendo lidos e espelhados para preservar restart e
rollback sem abrir uma segunda implementação da regra.

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

O tab declara `manual_full_dry_run`. A sequência visual obrigatória é: reset,
pulso aceito, duplicado em 500 ms, cooldown em 950 ms, limite em 1.000 ms e
relé sintético já ligado. Todos os caminhos reutilizam a adaptação, a política,
a decisão e os gates de produção; terminam em
`TESTE FINAL: nenhum efeito enviado`, com `simulated: true` e
`dispatched: false`. O replay automatizado é:

```bash
node nodered/tools/test-garage-gate-flow.mjs
node nodered/tools/test-garage-gate-dashboard-event.mjs
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render -- garagem
```

Os replays cobrem as duas entradas, política válida e inválida, o limite de
999/1.000 ms, dedupe, recusa com estado `ON`, migração do estado persistente,
atualização do estado observado, payloads MQTT `ON`/`OFF` e topologia do
dry-run.
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
