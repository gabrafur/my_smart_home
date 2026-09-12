# Alertas Codex canônicos no Node-RED

O tab `alertas_codex` é a única fonte das decisões de nível e entrega dos
alertas do Codex. O Home Assistant continua produzindo telemetria bruta e
mantém as entidades históricas; `sensor.codex_nivel_de_alerta` apenas consome o
valor publicado em `input_text.codex_nivel_alerta_canonico`.

## Política visual

O grupo `0. Política visual — edite os valores` contém os valores canônicos:

- aviso de uso: 70%, entre 10% e 95%;
- uso crítico: 90%, entre 20% e 100%, sempre maior que o aviso;
- eficiência mínima de cache: 60%, entre 0% e 100%;
- saldo mínimo de créditos extras: 10, entre 1 e 100;
- cooldown crítico: 1 h, entre 1 h e 24 h;
- cooldown dos demais alertas: 6 h, entre 1 h e 48 h;
- retry de entrega pendente: 60 s, entre 10 s e 600 s.

Valores inválidos não substituem a última política persistente válida. Os
antigos `input_number.codex_alerta_*` foram preservados para compatibilidade e
histórico, mas não participam mais da decisão e não aparecem no dashboard.

## Fluxo e efeitos

A telemetria é acumulada em snapshots isolados de produção e teste. Blocos
`switch` visíveis mostram disponibilidade, nível atual, habilitação do resumo,
fonte que mudou, existência de candidato, cooldown e os dois gates finais.

O Node-RED publica o nível canônico e, quando permitido, executa quatro efeitos:
push para `mobile_primary`, atualização do último texto/horário e notificação
persistente. O cooldown só começa depois que Home Assistant aceita ao menos um
canal. Uma pendência permanece persistente e é reavaliada a cada 60 s, mas o
intervalo real de liberação vem da política visual.

## Teste seguro e rollback

No canvas, execute `TESTE 1: reset`, depois atenção, duplicidade,
indisponibilidade e resumo. Os eventos passam pelo snapshot, pelas decisões e
pelo cooldown reais. Os gates desviam a publicação e os quatro serviços para o
terminal que registra `CODEX_ALERT_DRY_RUN`, `simulated: true` e
`dispatched: false`.

Para rollback, restaure o gerador, `flows.json`, o pacote e o dashboard pelo
Git; reinicie primeiro o Home Assistant e depois somente o Node-RED. Nenhuma
entidade histórica foi removida.

## Validação

```bash
cd nodered
npm run flows:update-codex-alerts
npm run flows:validate
npm run flows:validate-layout
npm run flows:render-strict -- alertas_codex
node tools/test-notification-reliability.mjs
```
