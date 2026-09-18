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

O tab participa do observador global. Falha do worker, limpeza parcial, ponte
indisponível ou resultado vencido produz erro centralizado. A recuperação de
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
