# Portão da garagem — botão de pulso único no Home Assistant

Complemento de [`PORTAO_GARAGEM_RELE_LOCAL.md`](PORTAO_GARAGEM_RELE_LOCAL.md), que
descreve a migração do RF Tuya (nuvem) para o relé Zigbee local. Este documento
cobre o **botão do Home Assistant** criado em 2026-08-07 e as proteções contra
pulso duplicado.

## Por que isso é delicado

`switch.rele_acionador_portao` (Tuya `TS0001`, `_TZ3000_c8wtsv3p`, IEEE
`0xa4c138c06568e60a`) é um **contato seco ligado na botoeira (BT)** da central do
portão. Ele **não é um switch comum**: cada `ON` entrega um pulso físico e a
central executa a próxima ação do ciclo dela — abrir, fechar, parar ou inverter.
Dois `ON` = duas ações no motor.

**Não existe sensor de posição do portão.** Não há `cover` nem contato magnético
na instalação. O estado do relé representa *só* o pulso de comando; nunca se pode
inferir se o portão está aberto ou fechado a partir dele.

## Como o acionamento funciona hoje

Duas fontes independentes disparam o mesmo relé:

| Fonte | Caminho | Formato no MQTT |
|---|---|---|
| Botão Zigbee físico `botao_portao_garagem` | Node-RED, aba `garagem` (dedupe 900 ms → ON → delay 700 ms → OFF) | `{"state":"ON"}` (JSON) |
| Botão do dashboard `button.acionar_portao_da_garagem` | `script.portao_garagem_pulso` no HA | `ON` / `OFF` (cru, via `switch.turn_on`) |

Os dois publicam em `zigbee2mqtt/rele_acionador_portao/set`. O formato do payload
é útil para distinguir a origem ao depurar com `mosquitto_sub`.

O caminho antigo (cena RF Tuya `scene.acionar_portao` chamada por
`script.portao_garagem_acionar`) está **desabilitado** — ver "Rollback".

## Largura do pulso: 700 ms

O `TS0001` **não honra `on_time`/`onWithTimedOff`** (fica preso em ON e o comando
demora segundos esperando uma resposta que o firmware nunca manda). O pulso é
feito **por software**: `ON` → `delay` → `OFF`.

700 ms é o valor já validado em produção no Node-RED (nó `pulso: manter fechado
~0.7s`); o script do HA reusa exatamente o mesmo. Ajustável na variável
`largura_pulso_ms` de `script.portao_garagem_pulso`.

> A cena Tuya **não tinha** largura de pulso para copiar — ela só emitia o código
> RF uma vez, como apertar um controle; quem definia a largura era a central.

## Entidades

| Entidade | Papel |
|---|---|
| `button.acionar_portao_da_garagem` | **Único ponto de entrada do usuário.** Template button; `press` chama o script com `origem: botao_dashboard` |
| `script.portao_garagem_pulso` | Toda a lógica e todas as guardas. `mode: single`, `max_exceeded: silent` |
| `switch.rele_acionador_portao` | O relé. **Oculto** (`hidden_by: user`) e fora dos assistentes de voz |
| `input_datetime.portao_garagem_ultimo_pulso` | Timestamp do último pulso — base do cooldown |
| `input_text.portao_garagem_ultimo_pulso_origem` | Quem pediu o último pulso |
| `automation.portao_garagem_carimbar_pulso_qualquer_origem` | Arma o cooldown do HA também para pulsos do Node-RED |
| `automation.portao_garagem_seguranca_rele_preso_em_on` | Rede de segurança: força `OFF` se o relé ficar `on` > 5 s |
| `scene.acionar_portao` | Cena RF Tuya legada — **desabilitada**, não excluída |

## A sequência

```
clique
  ├─ guarda 1: relé unavailable/unknown? → log + notificação, PARA (nenhum ON)
  ├─ guarda 2: dentro do cooldown de 3 s? → log, PARA (nenhum ON)
  ├─ guarda 3: relé já está ON?          → manda OFF, notifica, PARA (nenhum ON)
  ├─ carimba timestamp + origem (ANTES do ON)
  ├─ switch.turn_on   ← o ÚNICO ON da execução
  ├─ delay 700 ms
  ├─ switch.turn_off
  └─ +500 ms: ainda ON? → reforça OFF (reenviar OFF é seguro; reenviar ON não)
```

## Proteção contra pulso duplicado (em camadas)

1. **`mode: single` + `max_exceeded: silent`** — chamada concorrente é
   *descartada*, nunca enfileirada (`queued`/`restart` gerariam um segundo ON).
2. **Cooldown por timestamp (3 s)**, gravado **antes** do `ON`. Baseado em
   timestamp, não em delay ou flag: se uma execução morrer no meio, o cooldown
   já está valendo, e ele **nunca trava permanentemente** (é uma comparação de
   tempo, não um estado que precisa ser limpo).
3. **Cooldown compartilhado entre as duas fontes** — a automação
   `portao_garagem_carimbar_pulso_qualquer_origem` carimba o timestamp em
   *qualquer* `off → on` do relé, então um pulso do Node-RED também bloqueia o
   botão do HA pelos 3 s seguintes.
4. **Guarda de estado inicial** — se o relé já está `on`, o script **não manda
   ON**: abre o contato, notifica e aborta. O próximo clique é que pulsa.
5. **Guarda de disponibilidade** — `unavailable`/`unknown` vira erro registrado,
   não um `ON` às cegas.
6. **Zero retry de `ON`** em qualquer caminho. Só o `OFF` é reenviado.
7. **Rede de segurança** — relé `on` por mais de 5 s → `OFF` forçado. Cobre HA
   reiniciado no meio do pulso. Essa automação **só emite `OFF`**.
8. **Nada dispara no startup** — não há trigger de `homeassistant.start`, e o
   `power_on_behavior` do relé já está em `off` (uma queda de energia não fecha
   o contato sozinha).

### Limitação conhecida

O Node-RED **não** consulta o cooldown do HA (ele publica direto no MQTT para
manter a latência < 100 ms). Ou seja: um clique no botão do HA seguido de um
aperto no botão Zigbee físico **gera dois pulsos**. Isso é o comportamento
correto — são dois comandos deliberados de um humano —, mas vale saber que a
serialização é unidirecional: Node-RED → bloqueia o HA, HA → não bloqueia o
Node-RED. Fechar isso exigiria rotear o botão físico pelo HA, o que reintroduz
latência e uma dependência que a migração para o relé local quis justamente
eliminar.

## Restrição de acesso direto ao relé

Aplicado:

- `hidden_by: user` no registry → some dos dashboards (o painel padrão é
  auto-gerado, então era ali que ele aparecia) e da busca da UI;
- `should_expose: false` para `conversation`, `cloud.alexa` e
  `cloud.google_assistant` → não dá mais para acionar o relé por voz (antes
  estava exposto ao Assist);
- nenhum dashboard/script/cena referencia o relé fora do script novo.

> ⚠️ **Essas três configurações vivem em `homeassistant/.storage/core.entity_registry`,
> que é ignorado pelo git** (o `.storage/` inteiro é, de propósito). Elas **não são
> restauradas** por um `git clone` numa Pi nova — reaplique manualmente pela UI
> (Configurações → Entidades) ou pela API WebSocket:
>
> ```json
> {"type":"config/entity_registry/update","entity_id":"switch.rele_acionador_portao","hidden_by":"user"}
> {"type":"homeassistant/expose_entity","entity_ids":["switch.rele_acionador_portao"],
>  "assistants":["conversation","cloud.alexa","cloud.google_assistant"],"should_expose":false}
> {"type":"config/entity_registry/update","entity_id":"scene.acionar_portao","disabled_by":"user"}
> ```
>
> O que **está** versionado (o package YAML) já é seguro sozinho: sem essas três
> linhas o relé volta a aparecer na UI e a cena Tuya volta a existir, mas o botão
> e todas as guardas continuam funcionando.

**Limitação que não dá para contornar:** o Home Assistant **não tem ACL por
entidade** para chamadas de serviço. Um usuário **administrador** sempre poderá
chamar `switch.turn_on` em `switch.rele_acionador_portao` pelas Ferramentas de
Desenvolvedor ou pela API REST/WebSocket — ocultar a entidade afeta só a
interface. As opções reais para travar isso de verdade seriam:

- criar um usuário **não-admin** para o uso do dia a dia (não-admins não têm
  Ferramentas de Desenvolvedor);
- desabilitar a entidade no registry — mas aí o **script também** para de
  funcionar, então não serve.

A rede de segurança (item 7) limita o estrago de um `ON` manual: o contato é
aberto automaticamente em 5 s e uma notificação é criada.

## Testes executados (2026-08-07)

Todos com `mosquitto_sub -t 'zigbee2mqtt/rele_acionador_portao/set'` gravando o
tráfego real.

| Teste | Resultado |
|---|---|
| Cooldown armado + 3 chamadas ao script em rajada + 1 clique no botão | **0 publicações** no `/set`; 4 registros `pulso IGNORADO` no logbook. Portão não se moveu |
| **5 chamadas simultâneas** ao script (cooldown livre) | **exatamente 1 `ON` + 1 `OFF`**; portão abriu (confirmado visualmente) |
| **1 clique + double-click 400 ms depois** | **exatamente 1 `ON` + 1 `OFF`**; segundo clique descartado |
| Estado final do relé após cada pulso | `off` |
| Reinício do HA com a config nova | `button.acionar_portao_da_garagem` nasce em `unknown`; **nenhum** `ON` no startup |
| Relé `unknown` logo após o restart | Guarda 1 recusaria o pulso (caminho não exercitado fisicamente) |

Não exercitados fisicamente (exigiriam movimentar o portão de propósito):
guarda 3 (relé já ligado) e a automação de relé preso em `ON`. Ambos são
condições de estado simples que só emitem `OFF`.

## Rollback

1. **Reativar a cena Tuya** (ela foi só desabilitada, nunca excluída):
   Configurações → Dispositivos e serviços → Entidades →
   `scene.acionar_portao` → reabilitar. Ou pela API WebSocket:
   `config/entity_registry/update` com `disabled_by: null`.
   `script.portao_garagem_acionar` (mantido no package como legado) volta a
   funcionar na hora.
2. **Reexibir o relé**: mesmo caminho, `hidden_by: null`.
3. **Remover o botão novo**: `git checkout homeassistant/packages/portao_garagem.yaml`
   e `docker compose restart homeassistant`.
4. O fluxo `garagem` do Node-RED **não foi tocado** — o botão Zigbee físico
   continua funcionando em qualquer cenário de rollback.
