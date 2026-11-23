# Guardião de memória do host

O tab `guardiao_memoria_host` do Node-RED protege a disponibilidade do servidor
sem conceder ao container acesso a `/proc`, ao namespace de PIDs, a `sudo` ou
à capability `CAP_KILL`. O Node-RED solicita uma avaliação a cada 60 segundos;
um worker no host, executado como o usuário comum, revalida todas as condições
antes de remover temporários abandonados ou enviar qualquer sinal.

No canvas, os intervalos ativos de solicitação (60 s), leitura (30 s), atrasos
iniciais (75 s/90 s) e timeout das pontes (15 s) aparecem no grupo de
parâmetros e fontes. Resultados com mais de 180 segundos são rejeitados como
vencidos. Presença, validade, vigência, duplicidade, status do worker e
produção/teste são decisões `switch` nomeadas. A assinatura
do último resultado continua persistente para sobreviver ao restart do
Node-RED, enquanto o replay usa uma chave isolada e volátil.

## Escopo fechado

O guardião não é um limpador genérico de processos. Ele possui duas superfícies
explicitamente permitidas:

- diretórios temporários criados pelas ferramentas versionadas deste
  repositório, conforme `scripts/temporary-artifact-prefixes.txt`;
- um `extensionHost` antigo do VS Code Remote e seus filhos, como servidores de
  linguagem, Copilot ou Codex iniciados por aquela sessão.

Um temporário só é removido quando tem prefixo conhecido, pertence ao mesmo
usuário do worker, está sem alteração há pelo menos duas horas, não contém
arquivos de outro usuário nem outro filesystem e não aparece como `cwd`, raiz
ou descritor aberto de nenhum processo do usuário. Symlinks nunca são seguidos.
Cada ciclo remove no máximo 1.000 diretórios e 768 MiB; a limpeza é acionada
quando a memória disponível cai abaixo de 60% ou quando os candidatos somam ao
menos 256 MiB. O diretório é renomeado atomicamente antes da remoção.

A enumeração de `/proc` lê somente nomes, sem solicitar metadados de entradas
que podem desaparecer durante a leitura. O snapshot e a proteção de temporários
usam o mesmo leitor limitado; falhas preservam o código do sistema operacional
no motivo sanitizado, sem divulgar caminhos ou argumentos.

A enumeração inicial de `/proc`, usada para impedir a remoção de temporários
ativos, aceita no máximo três tentativas com espera curta e limitada. Isso
absorve falhas transitórias do kernel sem ampliar o escopo da limpeza; se as
três leituras falharem, o ciclo continua falhando fechado e nenhuma remoção é
executada.

Home Assistant, Node-RED, Docker, containerd, SSH, MQTT, Zigbee2MQTT, Matter,
Tailscale, systemd e qualquer processo de outro usuário são bloqueados pela
denylist e pelas verificações de UID. Um descendente essencial torna toda a
ação inelegível.

Uma árvore só pode ser encerrada quando todas estas condições forem verdadeiras:

- o `extensionHost` está desconectado e existe há pelo menos 30 minutos;
- se houver uma sessão conectada, o candidato desconectado é mais antigo que a
  sessão conectada mais nova;
- a árvore antiga consome pelo menos 256 MiB de RSS;
- a mesma árvore permanece praticamente ociosa por dois ciclos separados por
  pelo menos 45 segundos;
- não houve outra ação do guardião nos últimos 15 minutos;
- PID, tempo de início, UID, conexão, pressão de memória e árvore continuam
  iguais numa revalidação imediatamente anterior aos sinais.

O encerramento de uma sessão desconectada não depende de pressão de memória:
isso garante que fechar a única janela remota também devolva RAM ao host. Sob
pressão (`MemAvailable` abaixo de 1.536 MiB **e** de 20% da RAM total), o
guardião continua publicando os estados de diagnóstico mesmo quando não há
candidato seguro.

Dados ausentes ou ambíguos impedem a ação. Uma sessão conectada nunca é
candidata. O worker envia `SIGTERM` primeiro,
aguarda dois segundos e usa `SIGKILL` apenas nos mesmos PIDs que ainda existam
com o mesmo tempo de início, evitando reutilização de PID.

## Fronteira Node-RED → host

O container grava apenas um marcador coalescido em
`.local-state/host-memory-guardian/`. O cron do usuário executa
`scripts/process-host-memory-guardian-request.sh`, que chama
`scripts/host-memory-guardian.mjs` e publica uma linha sanitizada de resultado.
Comandos, variáveis de ambiente, endereços e conteúdo de conversas não retornam
ao Node-RED.

Uma resposta vazia ou inválida da ponte continua sendo falha, sem reenvio
automático. O diagnóstico preserva somente a razão classificada, o código de
saída, o sinal do processo e a duração desde a preparação do pedido; não
publica stdout, stderr, comandos ou caminhos.
Um aceite textual com código de saída não zero não é aceito como confirmação.
O retorno posterior de um resultado fresco comprova apenas aquele ciclo, sem
atribuir retrospectivamente a causa de uma falha anterior.

O processador conserva os resultados terminais do worker em
`result-history.log`, limitado por padrão às últimas 200 linhas (cerca de três
horas). `daily-minimum.log` guarda, para cada dia UTC dos últimos 30, o resultado
com menor memória disponível; só é regravado quando o mínimo do dia cai, e
permite conferir o pico da janela de atualizações da madrugada.

Por contêiner, `scripts/container-memory-peaks.mjs` (cron de 10 em 10 minutos,
instalado por `scripts/install-container-memory-peaks-cron.sh`) lê `memory.peak` do
cgroup v2 de cada contêiner e guarda o maior valor de cada dia, por 30 dias, em
`.local-state/host-memory-guardian/container-peaks.json`. O kernel zera esse pico
quando o contêiner reinicia, e as atualizações noturnas reiniciam contêineres; por
isso a gravação é periódica. Exige o controlador de memória do cgroup
(`cgroup_enable=memory`, ativo desde 17/11/2026). Só lê: serve para dimensionar
limites por contêiner com base em dados reais. Na primeira leitura, `ai-bridge`
tinha pico de 3,7 GiB, acima do Home Assistant (1,1 GiB). Esse histórico
não registra as fases da solicitação feita pelo container: o helper apenas
publica o marcador e retorna, sem esperar o worker. Portanto, um resultado
saudável do worker não explica uma interrupção anterior do helper. Remover um
marcador temporário órfão também não comprova corrigir a origem de um SIGTERM;
essa investigação exige evidência da solicitação interrompida.

A solicitação usa `exec` para substituir a shell intermediária pelo helper:
o limite de 15 segundos passa a sinalizar o processo que possui o lock. Os
handlers de HUP, INT e TERM encerram o helper com código não zero e liberam o
lock no handler de saída; uma interrupção não deve continuar até publicar aceite.
Isso corrige o lifecycle da interrupção, mas SIGTERM isolado não distingue
limite de tempo, deploy e sinal externo. Duração próxima do limite é evidência
adicional, não uma atribuição automática de causa. Não há retry automático.

O lock curto do pedido se recupera automaticamente quando fica órfão por mais
de 120 segundos e não existe pedido pendente ou em processamento. Isso evita
que uma recriação do container deixe o guardião permanentemente em `busy`.

Instalação da ponte do usuário:

```bash
scripts/install-host-memory-guardian-bridge.sh
```

Depois de atualizar o `docker-compose.yml`, recrie somente o serviço Node-RED
para montar os dois helpers e o diretório de troca. Não reinicie a stack
residencial inteira.

## Interrupções por travamento do host

O SIGTERM registrado em `execution_interrupted` vem do limite de 15 segundos
do nó `exec`, não de outro processo. O helper do pedido é instantâneo, mas as
duas ocorrências observadas em 15/11 (por volta de 19:53 e 23:47 UTC)
coincidiram com travamentos do host inteiro. Nesse intervalo o journal ficou
sem registros, e o timer do procmon, que dispara a cada 50 segundos com
precisão de 1 segundo, atrasou 7 e 19 segundos. O sistema roda em cartão SD,
sem swap e sem PSI no kernel. O kernel não registrou tarefa bloqueada (ele
registra só bloqueios acima de 120 segundos), então a causa provável é
contenção de escrita no armazenamento durante trabalho pesado simultâneo, e
não falha do guardião. Para conferir uma nova ocorrência, compare o horário do
aviso com o atraso do timer `raspberry-procmon`. Um intervalo sem registros no
journal, isolado, não prova travamento.

O nó `Resposta da ponte inválida` classifica esse caso. Um `SIGTERM` com pelo
menos 14 segundos decorridos, ou seja, no limite do `exec`, conta como
travamento do host. Uma ou duas ocorrências na mesma hora geram apenas um aviso
no log do Node-RED (`host_memory_guardian_request_transient
reason=host_stall_timeout`) e um status amarelo, sem alerta no celular. A
terceira ocorrência na mesma hora volta a ser falha, com o mesmo texto
`host_memory_guardian_request_unrecognized reason=execution_interrupted` que o
sanitizador de avisos já reconhece, e o status passa a "travamentos recorrentes
do host". Um sinal antes do limite ou outro sinal continua sendo falha imediata.
A contagem fica em memória (`memoryOnly`) e recomeça a cada reinício do
Node-RED. O próximo ciclo do guardião refaz a verificação normalmente. Não há
retry imediato.

### Histórico do cartão SD

As travas de 22/11/2026 (18:02 e 20:23 UTC) repetiram o padrão: CPU ociosa,
memória livre e dezenas de processos em estado D esperando o cartão SD, que
respondia escritas depois de segundos. Desde 23/11 cada resultado do guardião
traz também `sd_read_ms` e `sd_write_ms` (latência média por operação no último
intervalo), `sd_busy_percent` (tempo em que o `mmcblk0` esteve ocupado) e
`blocked_tasks` (processos em estado D no instante da coleta). Os contadores
vêm de `/proc/diskstats` e o ponto anterior fica no `state.json`; o primeiro
ciclo, um reinício do host ou um intervalo acima de 15 minutos registram
`unknown`. Como o journal fica em memória, o `result-history.log` é a fonte para
reconstruir uma trava depois: uma linha ausente marca o minuto em que o próprio
guardião não conseguiu rodar, e a linha seguinte mostra a latência acumulada.

A aba `alerta_cartao_sd` do Node-RED lê a mesma linha a cada 30 s e avalia cada
leitura nova uma vez. Duas leituras seguidas com `sd_write_ms` acima de 500 ou
`blocked_tasks` acima de 5 criam o aviso persistente
`raspberry_pi_cartao_sd_lento` no Home Assistant, pelo hub; três leituras
normais seguidas o removem. Picos isolados, que aparecem algumas vezes por hora
(no histórico de 23/11, 9 de 200 leituras e nunca duas seguidas), não avisam.
Leituras `unknown` não somam nem zeram a contagem. O estado fica no contexto
persistente (`sd_card_alert_state_v1`). Os botões `TESTE` usam estado próprio em
memória e terminam no dry-run do hub; a regressão está em
`nodered/tools/test-sd-card-alert-flow.mjs`.

## Testes seguros

No grupo `TESTE — pedidos e resultados completos em dry-run`, execute na ordem:

1. `TESTE 1: reset`;
2. `TESTE 2: solicitar limpeza`;
3. `TESTE 3: memória saudável`;
4. `TESTE 4: temporários recuperados`;
5. `TESTE 5: candidato observado`;
6. `TESTE 6: encerramento aprovado`;
7. `TESTE 7: repetir encerramento`, que comprova a deduplicação;
8. `TESTE 8: falha do worker`;
9. `TESTE 9: resultado vencido`.

Todos os caminhos terminam em `TESTE FINAL: sinais bloqueados`, com
`simulated: true` e `dispatched: false`. Eles não criam marcador no host e não
enviam `SIGTERM` ou `SIGKILL`. A regressão do canvas fica em
`nodered/tools/test-host-memory-guardian-flow.mjs`; o algoritmo e a ponte têm
fixtures em `scripts/host-memory-guardian.test.mjs` e
`scripts/host-memory-guardian-request.test.mjs`.

O alerta de falha canônica informa o tipo de falha e o motivo sanitizado do
worker, distinguindo resultado vencido, limpeza parcial e contrato inválido.
O diagnóstico permanece no caminho central de deduplicação e entrega.

O tab participa do observador global. O primeiro resultado após uma partida do
Node-RED só é avaliado quando o `request_id` corresponde a um pedido aceito no
ciclo atual; resultados anteriores ficam em espera e não viram falso
`stale_result`. Falha do worker, limpeza parcial, ponte indisponível ou resultado
vencido abre um incidente centralizado, e o primeiro resultado saudável encerra
explicitamente a notificação persistente. A recuperação de
temporários registra `HOST_MEMORY_GUARDIAN_RECLAIMED`; o encerramento de uma
sessão registra `HOST_MEMORY_GUARDIAN_TERMINATED` no log do Node-RED.

O JavaScript remanescente no tab é deliberadamente pequeno: adapta as duas
respostas textuais, classifica a vigência, mantém somente a assinatura
persistente, monta o registro de auditoria e registra erros/status. As decisões
de remover temporários ou encerrar processos permanecem
no worker do host porque dependem de `/proc`, UID, tempo de início e revalidação
atômica; movê-las ao container ampliaria privilégios e reduziria a segurança.

O guardião não executa `drop_caches`, não cria swap, não reinicia serviços e não
mata processos arbitrários por consumo. Cache de páginas já é recuperado pelo
kernel; essas ações aumentariam latência ou colocariam a automação residencial
em risco sem comprovar que a memória pertence a um artefato abandonado.
