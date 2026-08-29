# Portão da garagem — migração para acionamento local (relé Zigbee)

## Contexto / problema

O acionamento do portão tinha **latência alta** (segundos) entre o clique (botão
físico Zigbee ou app) e o portão de fato acionar. A causa foi confirmada por
investigação: o fluxo `garagem` do Node-RED chamava `script.portao_garagem_acionar`
no Home Assistant, que dispara `scene.turn_on` numa **cena Tuya (tap-to-run)**.
A integração Tuya (SDK `tuya_sharing`) envia **todo** comando/cena pela **nuvem
Tuya nos EUA** (`apigw.tuyaus.com`) — daí o round-trip de segundos.

## Por que não deu para ficar local pelo hardware Tuya

O acionador RF é um blaster **Tuya UFO-R2-RF-V2** (`controlador_garagem`,
categoria `wnykq`) com a "Porta da garagem" como **sub-device RF** (`rf_garage_door`).
Investigação (chaves locais extraídas, rede confirmada — bridge em `IP_DA_BRIDGE`,
protocolo v3.3):

- o bridge **não responde a leitura de status local** (`No response`);
- a API Tuya retorna **`2009 "not support this device"`** para specifications/functions
  do bridge e do sub-device;
- os códigos RF ficam **na nuvem** (a API de IR `/v2.0/infrareds/.../remotes` vem
  vazia porque é RF, não IR).

**Veredito:** o UFO-R2 é *cloud-only*; não há caminho local para o RF do portão.

## Solução adotada

Um **relé Zigbee de contato seco** (`rele_acionador_portao`, Tuya `TS0001`,
`_TZ3000_c8wtsv3p`) ligado nos terminais de **botoeira (BT)** da central do portão,
em paralelo com o controle — um "botão virtual" 100% local via zigbee2mqtt. Sem
nuvem, latência esperada < 100 ms.

## Comportamento de "botoeira de campainha" (pulso momentâneo)

Implementado na aba `garagem` do Node-RED. A fonte geradora canônica é
`tools/configure-garage-gate-flow.mjs`:

```
botao_portao_garagem (JSON) ─┐
botao_portao_garagem/action ──┤
botão do dashboard (evento) ─┴─▶ validar pedido (dedupe 900ms + cooldown 1s)
        └─▶ botoeira: liga o rele  ──▶ mqtt out (rele set)
                    └─(delay 0.7s)─▶ botoeira: solta o contato (OFF) ──▶ mqtt out
```

**Importante — o pulso é por SOFTWARE, não pelo dispositivo.** O relé
`TS0001` (`_TZ3000_c8wtsv3p`) só expõe `state` liga/desliga; ele **não honra**
o comando Zigbee `onWithTimedOff` (`on_time`). Tentar usar `on_time` causou dois
problemas observados: o relé **não voltava para OFF** (ficava ligado) e o comando
**demorava segundos** (o z2m ficava aguardando uma resposta que o firmware nunca
envia, até dar timeout).

Solução adotada (rápida e confiável):

- **Liga**: publica `{"state":"ON"}` (comando simples — resposta imediata).
- **Pulso**: nó `delay` de **700 ms**.
- **Desliga**: publica `{"state":"OFF"}` — fecha o pulso de ~0,7 s.
- **Debounce**: reaproveita a função `normalizar clique e evitar duplicado`
  (janela de 900 ms). Ajustável na constante `dedupeMs` da função.
- **Cooldown**: 1 s desde o início do último pulso aceito, compartilhado pelas
  entradas física e do dashboard.
- **Largura do pulso**: 700 ms, ajustável no nó `pulso: manter fechado ~0.7s`.

> Não usar `on_time`/`onWithTimedOff` neste relé — só comandos `state` ON/OFF.

## O que foi aposentado

Removidos do fluxo (a cena de nuvem e seu tratamento de erro/retry):
`acionar_portao_garagem` (api-call-service da cena), `catch`, `tentar novamente ate 2x`,
`aguardar antes de tentar novamente`, `notificar erro portao`. Recuperáveis via git
ou pelo backup `/data/flows.json.bak-relay` (dentro do container nodered).

O `script.portao_garagem_acionar` e a `scene.acionar_portao` continuam existindo no
HA porém **não são mais usados** pelo Node-RED.

> **Atualização 2026-08-29:** a `scene.acionar_portao` segue **desabilitada** no
> registry. O botão do dashboard agora só emite um evento local; o pulso e suas
> guardas pertencem à aba `garagem` do Node-RED. Ver
> [`PORTAO_GARAGEM_BOTAO_PULSO.md`](PORTAO_GARAGEM_BOTAO_PULSO.md) para o botão
> `button.acionar_portao_da_garagem`, as guardas contra pulso duplicado e o
> procedimento de rollback.

## Deploy e teste

Valide primeiro com o replay offline descrito em
[`PORTAO_GARAGEM_BOTAO_PULSO.md`](PORTAO_GARAGEM_BOTAO_PULSO.md). Ele não publica
no broker. Qualquer teste direto por MQTT movimenta o portão e deve ser feito
somente de forma deliberada, com a área livre.

## Arquivo de ownership

`nodered/flows.json` pertence a `node-red` (uid 1000). Regenere a aba com o
script canônico dentro do container ou gere um arquivo alternativo para revisão;
não mantenha uma segunda cópia manual do fluxo.
