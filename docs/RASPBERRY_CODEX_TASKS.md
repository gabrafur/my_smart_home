# Tarefas e threads Codex pelo MCP do Raspberry

> Este documento acompanha o candidato preservado em `task-control/`, que usa
> `codex_threads_list`. A versão instalada observada em 25/10/2026 usa
> `codex_task_list` e acrescenta a delegação administrativa `eva-admin-`.
> Consulte o [manual atual](RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md) e a
> [proveniência das fontes ativas](../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json).
> Não aplicar o manifesto histórico do candidato sobre a política instalada.

Esta extensão fica em `scripts/raspberry-mcp/task-control/`. O catálogo do
cliente só passa a representar esta versão depois de instalar o release.
A presença de descritores não prova execução nem conclusão de uma tarefa.

## Escopo e reconciliação

O broker conserva a validade, boot, identidade do socket, assinatura pessoal,
limites e allowlist da política instalada. Não consulta outros computadores.
A listagem cobre somente as threads da allowlist existente e as identidades
registradas pelo adaptador. A cobertura do host é explicitamente parcial.
Adicionar outras threads exige aprovação específica e outra política; a
listagem não altera o escopo, a validade ou a admissão de envios.

Uma criação com identidade durável confirmada pode estar bloqueada para envio.
`durable_blocked` com `reason=profile_mismatch` significa que o perfil retornado
pelo daemon não corresponde a `workspaceWrite`, sem rede, no projeto fixo.
O adaptador mantém o bloqueio; não modifica o perfil nem recria a thread.
`thread_not_ready` e `profile_unconfirmed` também impedem envio.

A checagem de criação pode usar `thread/resume` para inspecionar o perfil, sem
iniciar um turno. A **listagem** usa exclusivamente `thread/read` e
`thread/turns/list` com `itemsView=notLoaded`, sem resume, criação, nomeação,
envio ou leitura de itens/histórico bruto.

`codex_task_status` distingue criação confirmada, envio ausente do registro,
envio aceito, turno `inProgress`, resultados `completed`/`failed`/`interrupted`
e incerteza. `notLoaded` é apenas um estado de carregamento do daemon.
Um envio sem recibo retorna `state=not_recorded` e
`send_state=not_sent_by_adapter`; essa afirmação se limita ao adaptador.
Recibos incertos já registrados nunca são reenviados, inclusive após restart.

## Ferramentas e esquemas

Os esquemas executáveis completos estão em
[`task-tools.mjs`](../scripts/raspberry-mcp/task-control/task-tools.mjs).
Todos os objetos de entrada rejeitam propriedades adicionais. `host` é sempre
`raspberry`; IDs de operação/tarefa são 32 caracteres hexadecimais minúsculos.

| Ferramenta MCP | Campos obrigatórios além de `host` | Efeito |
| --- | --- | --- |
| `codex_threads_list` | `limit`: inteiro 1–50; `cursor`: string opaca até 512 caracteres ou `null` | Somente leitura |
| `codex_task_status` | `kind`: `creation` ou `turn`; `operation_id`: ID | Observação e atualização de recibo |
| `codex_task_create` | `operation_id`: ID; `task_key`: chave; `objective`: texto até 4.000 caracteres; `acceptance`: texto até 1.500 | Criação, sem enviar objetivo |
| `codex_task_send` | `operation_id`: ID; `task_id`: ID; `text`: texto até 6.000 caracteres | Envio sob os gates existentes |
| `codex_task_reconcile` | `operation_id`: ID; `result_hash`: SHA-256 hexadecimal | Reconhecimento de recibo terminal; nunca envia |
| `codex_task_revoke` | Nenhum | Bloqueio de novos envios, preservando recibos |

O cliente conectado pode prefixar esses nomes com o nome do plugin.

Uma primeira página usa:

```json
{"host":"raspberry","limit":20,"cursor":null}
```

A resposta inclui `observed_at`, `collection_error`, `coverage`, `scope`,
`ordering`, `pagination_consistency`, `data`, `next_cursor`, `authorized_count`,
`latest_created_thread_id`, `latest_adapter_created_thread_id`,
`latest_executed_thread_id`, `latest_execution_coverage` e `automatic_retry`.
Horários são segundos Unix; ausência de informação é `null`.

Cada item inclui `thread_id`, `safe_title`, `origin`, `source`, `created_at`,
`last_activity`, `state`, `can_accept_input`, `task_id`, `operation_id`,
`operation_state`, `last_execution`, `observed_at` e `collection_error`.
Threads do adaptador também incluem `creation_state`.
`can_accept_input` descreve a capacidade observada no daemon; não autoriza o
envio pelo adaptador. Cada item declara
`adapter_send_requires_fresh_profile_validation=true`.

Títulos nativos ficam ocultos. Somente rótulos fixos das tarefas do adaptador
podem ser retornados. `open_link=null`: esta integração ainda não fornece ou
valida links de abertura, portanto não declara plataforma compatível.
Nenhuma URL é sintetizada.

Ordenação: atividade decrescente, com desempate por ID crescente. O cursor
vincula o limite da página ao conjunto autorizado. Mudança desse conjunto
invalida o cursor. A paginação é ao vivo, sem snapshot: uma atividade nova
entre páginas pode mudar a posição de uma thread. Falhas mantêm a linha com
estado desconhecido e erro explícito; a atividade pode ser desconhecida.
Uma falha na leitura dos registros retorna `registry_collection_failed` e
`authorized_count=null`, sem tentar descobrir threads fora do escopo.

`last_execution` descreve somente o último turno persistido observado e
contém ID, estado e início. O indicador de última execução compara esses
inícios, não horários de criação nem ausência de carregamento. Sua cobertura
é limitada aos últimos turnos das threads autorizadas, com erro explícito
quando a coleta não foi integral. Envio incerto continua incerto mesmo se
outro turno da thread tiver concluído.

## Instalação e validação

O instalador exige a política e os arquivos base com hashes exatos. Preserva
todos os campos de autorização e atualiza apenas hashes do código desta
extensão. Não altera bancos ou recibos. Cria backup dos arquivos substituídos,
faz releitura e restaura os arquivos se a aplicação falhar. Reinicia somente
`raspberry-mcp-tunnel.service`; o broker continua ativado por socket.

```sh
python3 -B scripts/raspberry-mcp/task-control/install.py --check
sudo python3 -I -S -B scripts/raspberry-mcp/task-control/install.py --apply
```

`--check` não instala. Se a política, boot ou validade mudar, prepare e revise
um novo release; não ajuste os hashes automaticamente para contornar o gate.
O comando root depende de acesso administrativo real ao host. Não é coberto
pelos executores MCP de outras migrações ou pelos antigos helpers selados.

Teste direcionado, também descoberto por `scripts/test-all.mjs`:

```sh
./scripts/run-resource-safe.sh node --test scripts/raspberry-mcp/task-control/task-rpc.test.mjs
```

As regressões cobrem perfil incompatível, confirmação de identidade, criação
incerta, envio incerto após reabrir o banco, turno em andamento e terminal,
paginação, ordenação, threads antigas/novas, `notLoaded`, falhas de coleta,
privacidade e preservação byte a byte dos bancos durante a listagem.
Os testes do instalador usam somente diretórios temporários: verificam
prévia sem escrita, recusa de release alterado e validade expirada,
preservação da autorização e rollback tanto após falha de restart quanto
após uma substituição já efetivada antes de uma falha de sincronização.

Depois da instalação, consulte pelo cliente MCP conectado o recibo de criação,
o envio original e todas as páginas de `codex_threads_list`. Compare com o
daemon e confirme que a listagem não acrescentou tarefas ou envios. Essa
verificação real permanece obrigatória mesmo com todos os testes sintéticos
aprovados. Não envie um turno artificial para comprovar a listagem.

Contrato de leitura do daemon:
[documentação oficial OpenAI](https://learn.chatgpt.com/docs/app-server).
