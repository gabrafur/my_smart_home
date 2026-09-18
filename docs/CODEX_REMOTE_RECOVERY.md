# Recuperação automática do acesso remoto ao Codex

O acesso remoto ao Codex neste host é observado pelo tab
`monitoramento_internet`. O tab `monitoramento_vpn` continua sendo o único
responsável pela saúde e pela recuperação do Tailscale; o fluxo descrito aqui
não consulta, reinicia nem reconfigura a VPN.

## Arquitetura

1. `scripts/codex-remote-health-publisher.mjs` roda no host a cada minuto e
   publica no MQTT um relatório sanitizado e retido sobre o SSH/Dropbear, o
   binário do Codex e o socket de controle do App Server.
2. O Node-RED recebe o relatório, combina-o com o estado canônico da internet e
   só autoriza recuperação quando a internet está online, o SSH está saudável,
   o binário existe, o App Server não está pronto e o cooldown terminou.
3. O efeito final cria um pedido no diretório de trigger montado exclusivamente
   para essa operação. A ponte do host o coleta sem conceder shell genérico ao
   container.
4. `scripts/codex-remote-recovery.mjs` verifica novamente o socket. Se ele já
   estiver ativo, encerra sem ação; caso contrário, remove somente o socket
   local obsoleto e inicia o App Server do Codex. O worker nunca encerra um
   processo saudável, reinicia o host, o SSH ou o Tailscale.
5. O estado recuperado encerra o incidente persistente no observador global.

Produção e teste percorrem as mesmas decisões até o gate final. Os controles
`TESTE 7` e `TESTE 8` simulam, respectivamente, App Server ausente e recuperado;
em teste o pedido termina no dry-run e não executa nada no host.

## Instalação e verificação

Instale ou reconcilie as duas tarefas periódicas do usuário:

```sh
scripts/install-codex-remote-recovery-bridge.sh
```

Valide os componentes sem interromper uma sessão ativa:

```sh
node scripts/codex-remote-health-publisher.test.mjs
node scripts/codex-remote-recovery.test.mjs
node nodered/tools/test-internet-monitor-flow.mjs nodered/flows.json
npm --prefix nodered run flows:render-strict -- monitoramento_internet_tab
```

Um pedido manual é seguro para smoke test porque o worker faz uma nova leitura
antes de agir. Com o App Server ativo, o resultado esperado contém
`status=healthy action=none reason=app_server_ready`.
