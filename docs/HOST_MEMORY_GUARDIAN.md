# Guardião de memória do host

O tab `guardiao_memoria_host` do Node-RED protege a disponibilidade do servidor
sem conceder ao container acesso a `/proc`, ao namespace de PIDs, a `sudo` ou
à capability `CAP_KILL`. O Node-RED solicita uma avaliação a cada 60 segundos;
um worker no host, executado como o usuário comum, revalida todas as condições
antes de enviar qualquer sinal.

## Escopo fechado

O guardião não é um limpador genérico de processos. A única raiz permitida é
um `extensionHost` antigo do VS Code Remote. Seus filhos, como servidores de
linguagem, Copilot ou Codex iniciados por aquela sessão, fazem parte da mesma
árvore e são encerrados junto com ela.

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
4. `TESTE 4: candidato observado`;
5. `TESTE 5: encerramento aprovado`;
6. `TESTE 6: falha do worker`.

Todos os caminhos terminam em `TESTE FINAL: sinais bloqueados`, com
`simulated: true` e `dispatched: false`. Eles não criam marcador no host e não
enviam `SIGTERM` ou `SIGKILL`. A regressão do canvas fica em
`nodered/tools/test-host-memory-guardian-flow.mjs`; o algoritmo e a ponte têm
fixtures em `scripts/host-memory-guardian.test.mjs` e
`scripts/host-memory-guardian-request.test.mjs`.

O tab participa do observador global. Falha do worker ou da ponte produz erro
centralizado; uma limpeza bem-sucedida registra
`HOST_MEMORY_GUARDIAN_TERMINATED` no log do Node-RED.
