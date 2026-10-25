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
   estiver ativo, encerra sem ação; caso contrário, inicia o App Server do
   Codex, que reconcilia seus próprios sockets obsoletos. O worker nunca encerra um
   processo saudável, reinicia o host, o SSH ou o Tailscale.
5. O estado recuperado encerra o incidente persistente no observador global.

O caminho anunciado pelo Codex pode ser um link simbólico para um socket
físico protegido. Tanto a sonda quanto o recovery resolvem esse link e procuram
o caminho exato no `ss`, inclusive ao verificar o PID antes de um restart
explícito. Comparar somente o alias ou aceitar prefixos pode declarar ausente
um servidor saudável. O recovery não remove o alias; o argumento `--listen`
usa o caminho configurado, também quando há um override de socket.

O restart explícito e a atualização agendada usam `--preflight-restart` para
consultar a [API de metadados do App Server](https://learn.chatgpt.com/docs/app-server).
São usadas somente `thread/loaded/list`, `thread/read` sem histórico e
`thread/goal/get`. Turno ou meta ativa adia a atualização antes da instalação;
o mesmo gate é conferido antes de encerrar o processo. Estado desconhecido,
paginação incompleta e `notLoaded` também adiam, sem serem interpretados como
conclusão. A saída contém apenas estado e razão enumerados, sem objetivos,
títulos, histórico ou credenciais.

Código 75 significa adiamento. O worker preserva o identificador do pedido e
um marcador de restart já criado; não reinstala uma versão já confirmada só
porque seu restart aguarda. A observação é instantânea e não cria um bloqueio
atômico para novos clientes. Nenhuma consulta inicia inferência, retoma uma
thread ou altera a meta.

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

## Falha de consulta não confirma ausência

A consulta do listener tem três estados: `present`, `absent` e `unknown`.
Falha, timeout, sinal, saída inválida ou erro ao resolver o alias permanecem
`unknown`. Recovery e restart retornam `deferred` (código 75), sem iniciar um
processo substituto nem enviar sinal quando a observação inicial é incerta.
Após um SIGTERM autorizado, erro de consulta também impede iniciar outro
processo: somente ausência observada permite seguir. Incerteza após o início
não é registrada como recuperação concluída.

O produtor de saúde usa `schema_version: 2` e informa `listener_state`; em
estado desconhecido, `healthy` é `null`. O Node-RED valida a consistência,
impede recovery e não conta uma falha confirmada com esse relatório. Relatório
legado positivo continua legível; um legado negativo não confirma ausência,
pois o produtor antigo confundia erro de `ss` com listener ausente.

Atualize primeiro os dois consumidores de relatório no Node-RED e depois o
produtor. Os testes cobrem a cadeia produtor → normalização → decisão com
relatórios sintéticos e proíbem lançamento/sinal durante falhas de consulta.
Não é necessário reiniciar o App Server para carregar estes scripts; mantenha
os gates de turno/meta ativa e não provoque uma queda para testar a correção.


Para atualizar somente a fonte dos dois consumidores e os dois exemplos de
relatório, preservando a geometria e todas as ligações aprovadas, use
`node tools/install-internet-monitor-flow.mjs flows.json flows.json --refresh-remote-report`
dentro de `nodered`, depois valide observabilidade e layout. Esse modo rejeita
nós ausentes ou exemplos que não sejam de teste; mudanças de topologia seguem
o gerador completo e sua revisão visual.
