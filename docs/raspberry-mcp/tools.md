# Descoberta, ferramentas e esquemas

O contrato adicional `operating_policy_v1`, quando carregado na instalação,
descreve os próximos passos pelas ferramentas existentes. Cada ação distingue
`ready`, `blocked`, `unsupported` e `requires_confirmation`, com razão e origem
da decisão. O campo informa admissão, validade, orçamento compartilhado,
operações pendentes e confirmações de armazenamento separadamente. Não cria
autoridade, scheduler ou ferramenta de shell. Ausência ou falha desse campo
não pode ser substituída por uma conclusão baseada apenas em `tools/list`.

A versão de fonte e seus testes não comprovam que um frontend persistente já
carregou o código. Confirme a resposta MCP real, nas representações estruturada
e textual, preservando os gates e as confirmações do cliente. O contrato usa
papéis e estados independentes do modelo; os nomes `codex_task_*` identificam
somente o backend de tarefas implementado atualmente.

`tools/list` no servidor e no conector efetivamente usado é a fonte do catálogo
atual. A tabela abaixo é uma captura histórica, com 38 nomes; não promete que
um intermediário publique todos nem exclui extensões posteriores. Compare também
`maintenance_capabilities` antes de planejar um efeito. Nomes, disponibilidade,
anotações e argumentos não podem ser inferidos só pelo título de uma ferramenta.

Os argumentos seguem JSON Schema fechado. Referências e enums autorizados são
emitidos pelo servidor; placeholders documentais não são IDs executáveis.
Preservar `readOnlyHint`, `destructiveHint`, `idempotentHint` e `openWorldHint`
na passagem pelo transporte. Essas anotações orientam o cliente, enquanto a
autorização continua sendo validada pelo broker. Uma ferramenta idempotente pode
deixar resultado incerto: consultar o mesmo ID, sem repetir a ação com nova chave.

O [catálogo documental sanitizado](../../scripts/raspberry-mcp/portable-http/catalog.template.json)
e as [fontes exportadas](../../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json)
permitem revisar a implementação. Catálogos de candidato e cópias exportadas
não comprovam a versão carregada, a admissão ou a execução real.

## Protocolo e descoberta

O aceite de cliente independente negociou MCP `2025-06-18`, inicialização e
listagem de 38 ferramentas no socket real. O `serverInfo` ainda usa o nome
histórico `raspberry-readonly` e versão `0.1.0`; isso não descreve a autoridade
atual das extensões. Consultar os descritores e capacidades reais.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cliente-mcp","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"maintenance_capabilities","arguments":{"host":"raspberry"}}}
```

Cada mensagem stdio ocupa uma linha JSON; saída de diagnóstico não pode ser
misturada ao stdout do protocolo. Nomes podem receber prefixo do conector no
cliente. Usar os nomes devolvidos por ele, sem presumir que um nome instalado
no servidor já foi publicado pelo intermediário.

Os esquemas completos,com identidades específicas substituídas por marcadores, estão em
[`catalog.template.json`](../../scripts/raspberry-mcp/portable-http/catalog.template.json).
O arquivo é um modelo documental;os marcadores não são IDs executáveis. Para outra instalação, exportar novamente `tools/list`:
IDs de threads, allowlists, revisões e políticas são específicos do servidor.
Não preencher enums autorizados com IDs inventados. Os objetos de argumentos
rejeitam propriedades extras.

## Índice completo do catálogo capturado

Os detalhes de tipos,limites e enums ficam no modelo de esquemas mencionado acima. Esta tabela lista todos os campos obrigatórios do catálogo local capturado,sem copiar identidades privadas para os exemplos.

| Ferramenta | Campos obrigatórios |
| --- | --- |
| `service_health` | `host` |
| `service_versions` | `host` |
| `disk_space` | `host` |
| `backup_results` | `host` |
| `log_summary` | `host`, `service` |
| `project_files` | `host`, `category`, `offset` |
| `project_read` | `host`, `file_id`, `offset` |
| `project_prepare_edit` | `host`, `file_id`, `expected_sha256`, `old_text`, `new_text` |
| `service_prepare_restart` | `host`, `service` |
| `change_apply` | `host`, `change_id` |
| `change_revert` | `host`, `change_id` |
| `maintenance_capabilities` | `host` |
| `host_diagnostics` | `host` |
| `service_diagnostics` | `host`, `service` |
| `operation_status` | `host`, `change_id` |
| `change_validate` | `host`, `change_id` |
| `operation_submit` | `host`, `operation`, `idempotency_key`, `expected_revision` |
| `ha_notifications` | `host`; opcionais `notification_id`, `offset`, `expected_digest` |
| `events_status` | `host` |
| `codex_thread_read` | `host`, `thread_id` |
| `codex_thread_status` | `host`, `thread_id` |
| `codex_thread_send` | `host`, `thread_id`, `operation_id`, `intent` |
| `admin_action_apply` | `host`, `action`, `idempotency_key` |
| `admin_action_status` | `host`, `action`, `idempotency_key` |
| `admin_action_reconcile` | `host`, `action`, `idempotency_key` |
| `admin_action_revoke` | `host`, `action`, `idempotency_key` |
| `codex_task_create` | `host`, `operation_id`, `task_key`, `objective`, `acceptance` |
| `codex_task_send` | `host`, `operation_id`, `task_id`, `text` |
| `codex_task_status` | `host`, `operation_id`, `kind` |
| `codex_task_reconcile` | `host`, `operation_id`, `result_hash` |
| `codex_task_revoke` | `host` |
| `codex_task_list` | `host`, `page_size`, `cursor` |
| `codex_repair_submit` | `host`, `operation_id`, `task` |
| `codex_repair_status` | `host`, `operation_id` |
| `codex_repair_result` | `host`, `operation_id` |
| `codex_repair_reconcile` | `host`, `operation_id`, `result_hash` |
| `codex_repair_revoke` | `host` |
| `codex_repair_capabilities` | `host` |

