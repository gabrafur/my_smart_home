# Monitoramento e notificações das VPNs

O tab `monitoramento_vpn` acompanha as VPNs instaladas no host residencial e
notifica quando um túnel deixa de operar mesmo com a internet disponível. No
inventário de implantação de 2026-08-30, a única VPN instalada é o Tailscale,
representado publicamente pelo papel lógico `vpn_primary`.

## Arquitetura

O Node-RED roda em container e não recebe acesso privilegiado ao serviço de VPN
do host. O publicador `scripts/vpn-health-publisher.mjs` executa no host uma vez
por minuto, consulta somente o estado local do Tailscale e publica no tópico
retained <code>nodered&#47;infrastructure&#47;vpn&#47;host-health</code> um documento
sanitizado.

O relatório contém apenas papel lógico, tipo da VPN, estado booleano, motivo
normalizado e horário, mais a lista `key_expiry` descrita abaixo. Endereços,
nomes de host, usuários, tags e topologia da tailnet nunca entram no MQTT, nos
flows, nos logs públicos ou no Git. O instalador
idempotente `scripts/install-vpn-health-monitor-cron.sh` mantém o bloco do
`crontab` e usa `flock` para impedir sobreposição.

## Decisão e notificações

O tab combina o relatório do host com o estado retained produzido pelo tab
`monitoramento_internet`:

- internet diferente de `online`: a falha da VPN fica suprimida, pois o alerta
  causal já pertence ao monitor de internet;
- internet `online` e VPN indisponível por dois minutos: abre um incidente;
- relatório do host sem atualização por três minutos: abre incidente de
  telemetria, desde que a internet permaneça online;
- VPN saudável por um minuto após incidente: envia recuperação;
- incidente aberto é deduplicado e só repete após 24 horas.

Esses tempos são definidos uma única vez no grupo visual de política: falha
120 s (limite 1–600), recovery 60 s (1–300), relatório stale 180 s (30–900) e
lembrete 86.400 s (300–172.800). Um valor inválido é rejeitado sem substituir
a última política válida. Supressão pela internet, saúde do relatório,
confirmação, incidente aberto, lembrete e recovery são `switch` nomeados; o
JavaScript remanescente apenas valida o schema, aplica a mutação atômica de
estado ou adapta os três tópicos MQTT.

Queda e recuperação usam três hubs independentes: notificação persistente no
Home Assistant, duas chamadas móveis com um destinatário explícito em cada uma
e anúncio no target lógico Alexa. Na recuperação, o hub persistente apenas
remove o alerta da queda; nenhum aviso de "recuperada" fica no Home Assistant. O estado também é publicado via MQTT Discovery como
`binary_sensor.vpn_primary_connection` e
`sensor.vpn_primary_connection_state`.

## Validade das chaves do Tailscale

Cada aparelho da tailnet tem uma chave que vence (180 dias por padrão). Quando
ela vence, o aparelho é deslogado em silêncio: o servidor continua no ar, mas o
celular deixa de alcançá-lo e o app do Home Assistant parece fora do ar. Em
27/11/2026 isso aconteceu com o iPhone do proprietário.

O publicador inclui `key_expiry`: uma entrada por chave com vencimento, com
apenas `scope` (`host` para o Raspberry Pi, `device` para os demais),
`platform` (`ios`, `android`, `windows`, `macos`, `linux` ou `other`),
`shared` (aparelho de outra conta com acesso compartilhado) e `expires_at`.
Aparelhos sem vencimento (por exemplo, com "Disable key expiry") não aparecem.

A rotina fica no tab `atualizacoes_diarias`, grupo **VPN: validade das chaves
do Tailscale**, gerada por `nodered/tools/install-vpn-key-expiry-flow.mjs`
(chamado pelo gerador do tab):

- o `mqtt in` guarda só a lista sanitizada em contexto persistente;
- a avaliação roda todo dia às 09:00 e 120 s depois de o Node-RED subir;
- o parâmetro visual avisa a 14, 7, 3, 1 e 0 dias (`notify_days`) e ignora
  relatório com mais de 48 h (`report_max_age_hours`); a saúde do relatório
  continua com este tab `monitoramento_vpn`;
- cada chave abre um aviso persistente e um push no celular principal uma vez
  por faixa, pelo monitor global (alertas técnicos não vão ao celular
  secundário);
- chave renovada, com vencimento desativado ou fora da janela remove o aviso
  persistente, sem push;
- o texto diz qual aparelho (Raspberry Pi, plataforma ou compartilhado), a
  data, a consequência e como evitar (`login.tailscale.com` → Machines →
  Disable key expiry, ou entrar de novo no app).

Os botões `TESTE 1` a `TESTE 3` e o `RESET` usam contexto próprio e terminam no
dry-run do tab. Regressão: `node nodered/tools/test-vpn-key-expiry-flow.mjs`.

## Monitor existente de internet

O tab `monitoramento_internet` permanece responsável pela conectividade geral.
Ele exige três ciclos negativos contra três destinos independentes, abre uma
única notificação, exige dois ciclos positivos para recuperação e preserva o
dedupe após restart. A regressão isolada confirma que queda e recuperação
chegam aos hubs canônicos sem duplicação.

## Teste seguro

No tab `monitoramento_vpn`, execute na ordem:

1. `TESTE 1: reset`;
2. `TESTE 2: internet online`;
3. `TESTE 3: VPN offline`;
4. `TESTE 4: avaliar +121 s`;
5. `TESTE 5: VPN online`;
6. `TESTE 6: avaliar +61 s`.

Todos os efeitos terminam no dry-run compartilhado com `simulated: true` e
`dispatched: false`. Para o cenário negativo, use reset, `TESTE 2B: internet
offline`, VPN offline e avaliação: nenhuma notificação de VPN deve ser criada.

Validação e implantação:

```bash
node --test scripts/vpn-health-publisher.test.mjs
node nodered/tools/test-vpn-key-expiry-flow.mjs
npm --prefix nodered run flows:update-vpn-monitor
npm --prefix nodered run flows:update-daily-host-updates
npm --prefix nodered run flows:update-global-observer
npm --prefix nodered run flows:test-vpn-monitor
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render-strict -- monitoramento_vpn
scripts/install-vpn-health-monitor-cron.sh
node scripts/vpn-health-publisher.mjs --publish
```

Uma VPN adicional exige um coletor sanitizado no publicador, papel lógico no
avaliador e regressões próprias. Não reutilize nomes, endereços ou peers reais
na configuração versionada.
