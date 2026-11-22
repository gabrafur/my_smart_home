# Papéis lógicos no lugar de identificadores pessoais

Fontes executáveis rastreadas não nomeiam pessoas, contas nem máquinas pessoais.
Dois papéis lógicos substituem esses valores:

| Papel | O que representa | De onde vem o valor real |
| --- | --- | --- |
| `host_operator` | Conta Linux sem privilégio que executa o Codex, é dona do checkout e do socket de controle | `HOME` do próprio processo, `RASPBERRY_HOST_OPERATOR`/`SUDO_USER` em operadores Root, ou o uid fixado no enrollment selado |
| `workstation_primary` | PC principal do proprietário | Política Root do broker (`script.pc_desligar`) e alias SSH privado `workstation-primary` |

`make privacy-check` rejeita, pela regra `retired-personal-identifier`, o
identificador pessoal aposentado em qualquer arquivo rastreado. A regra publica
só o comprimento e o SHA-256 da palavra, não o valor.

## Onde cada valor é resolvido

| Componente | Antes | Agora | Override existente/novo |
| --- | --- | --- | --- |
| `scripts/codex-remote-{activity,recovery,health-publisher}.mjs` | caminho fixo na home | `os.homedir()` do usuário do cron; recusa root sem override (`codex_operator_paths_unresolved`) | `CODEX_REMOTE_CONTROL_SOCKET`, `CODEX_REMOTE_CODEX_BIN` (inalterados) |
| `scripts/storage-maintenance.sh` | home fixa | `HOME` do chamador; como root, a home do dono do checkout; vazio falha em `user-home` | `STORAGE_MAINTENANCE_USER_HOME` (inalterado) |
| `scripts/validate-on-pc.sh` | host SSH pessoal | alias `workstation-primary` | `VALIDATION_PC` (inalterado) |
| `codex-account-status` (broker e unit) | socket e `User=`/`Group=` fixos | unit é template renderizado na instalação; broker usa `HOME` que o systemd define para `User=` | `CODEX_APP_SERVER_CONTROL_SOCKET` (novo) |
| `codex-peer-reenroll` | socket e `package.json` fixos | home do uid `executable_uid` do enrollment Root selado; `ConditionPathExists` renderizado | — |
| `ha-lights` | alvo de ação com nome pessoal | `workstation_primary`, com alias legado opcional e privado | arquivo `HA_LIGHTS_LEGACY_ACTION_ALIASES_FILE` |
| `probe-diagnostics-sandbox.py` | `User=` fixo | `RASPBERRY_HOST_OPERATOR` ou `SUDO_USER` | — |
| `runtime-source/` (snapshots auditados) | home real | marcador `/home/<HOST_OPERATOR>` ou fixture `/home/fixture`, registrado em `SOURCE-MAP.json` | não instalável |

`scripts/raspberry-mcp/host_operator.py` resolve a conta (explícita,
`RASPBERRY_HOST_OPERATOR`, depois `SUDO_USER`; nunca root, nunca padrão fixo) e
renderiza `@HOST_OPERATOR_USER@`, `@HOST_OPERATOR_GROUP@` e
`@HOST_OPERATOR_HOME@`, recusando placeholder desconhecido ou restante.

## Contrato implantado que muda

Units e política do broker são instaladas no Raspberry a partir destas fontes;
os scripts executados direto do checkout (`codex-remote-*`,
`storage-maintenance.sh`, `validate-on-pc.sh`) mudam com o `git pull`, sem
reinstalação. Para eles, o resultado só é igual ao anterior quando rodam como
`host_operator` (que é como os crons instalados por
`install-codex-remote-recovery-bridge.sh` e
`install-storage-maintenance-cron.sh` rodam). Se algum job rodar como root,
defina os overrides antes de atualizar.

A ação `pc_<nome>` deixa de existir na política e na rota rastreadas. Se a
instrução da Eva ou outro prompt privado ainda citar o nome antigo, mantenha um
alias temporário (abaixo) até atualizar esse prompt. O conector lista as
ferramentas pelo `tools/list`, então um prompt que não cita o alvo não precisa
de alias.

## Redeploy no Raspberry (sem reinício de serviço)

Pré-requisitos: checkout atualizado em `/mnt/data/docker`, evidência prévia
capturada e nenhuma operação MCP em andamento. Todos os passos rodam como Root
pelo operador revisado `scripts/raspberry-mcp/host-identity/migrate.py`, com
fontes fixadas por SHA-256 e compare-and-swap contra os bytes exatos publicados
anteriormente (qualquer outro byte instalado recusa com
`installed_bytes_unexpected`).

1. Alias legado opcional, privado e fora do Git (só se um prompt depender do
   nome antigo). O arquivo deve pertencer a root e não ser gravável por grupo
   ou outros:

   ```bash
   sudo install -m 0600 -o root -g root /dev/null /etc/raspberry-ha-lights-aliases.json
   ```

   Conteúdo: `{"<alvo_antigo>": "workstation_primary"}` (até 4 aliases, só
   para ações registradas).

2. Plano somente leitura:

   ```bash
   sudo env HA_LIGHTS_LEGACY_ACTION_ALIASES_FILE=/etc/raspberry-ha-lights-aliases.json python3 -I -B /mnt/data/docker/scripts/raspberry-mcp/host-identity/migrate.py prepare
   ```

   Rodando `sudo` a partir da conta `host_operator`, `SUDO_USER` identifica a
   conta; de outra sessão, acrescente `RASPBERRY_HOST_OPERATOR=<conta>` depois
   de `env`. Sem alias, omita `HA_LIGHTS_LEGACY_ACTION_ALIASES_FILE`.
   Cada arquivo aparece como `legacy`, `current` ou `absent`
   (`codex-peer-reenroll` ainda não instalado é ignorado, nunca criado).

3. Aplicar: mesmo comando com `apply`. Guarda as imagens anteriores em
   `/var/lib/raspberry-mcp-host-identity/`, grava os arquivos renderizados e
   roda só `systemctl daemon-reload` (recarrega arquivos de unit; não reinicia
   serviço). O broker de luzes lê a política por conexão; `codex-account-status`
   e o re-enroll também rodam por conexão/timer.

4. Verificar: `verify` confere bytes instalados e pede `ha_actions_read` ao
   broker, exigindo `workstation_primary` registrado.

5. A rota nova vale na próxima conexão do frontend. Reiniciar
   `raspberry-mcp-tunnel.service` para forçar isso, e atualizar a lista de
   ferramentas no conector, **exige aprovação explícita do proprietário**; o
   operador não faz isso. Com alias, conexões antigas continuam funcionando
   porque a política instalada aceita os dois nomes.

6. Quando os prompts usarem só `workstation_primary`, esvazie o arquivo de
   alias (`{}`) ou remova a variável e rode `apply` de novo; o operador aceita
   a renderização anterior registrada em `applied-aliases.json`.

`rollback` restaura as imagens anteriores guardadas e roda `daemon-reload`.
O ledger de limites do broker é indexado pelo alvo; a troca de nome zera o
espaçamento mínimo de 30 s apenas para a ação do PC.

## Testes

`host-identity/test_migrate.py` (resolução, renderização, aliases, pinos),
`ha-lights/lights-route.test.mjs` (alias renderizado nunca chega ao broker),
`codex-peer-reenroll/test_reenroll.py` (home pelo uid do enrollment),
`codex-account-status/account-route.test.mjs`, `codex-remote-activity.test.mjs`,
`storage-maintenance.test.mjs` e `privacy-check.test.mjs`.

## Limitação

O histórico Git anterior continua contendo o identificador; limpar o histórico
exige procedimento separado, revisado e com reescrita coordenada.
