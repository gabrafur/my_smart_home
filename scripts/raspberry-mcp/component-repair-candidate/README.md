# Candidato de reparo por componente

Estas fontes e esquemas são preparação isolada. As doze ferramentas propostas
não estão registradas no MCP. Não há instalador, worker de efeito ou permissão
de produção neste diretório. O transporte MCP instalado está documentado em
[RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md](../../../docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md).

## Contrato proposto

Os esquemas completos ficam em [schemas.mjs](schemas.mjs). Todos recusam host
diferente de `raspberry`, parâmetros extras e caminhos/comandos livres.

| Ferramenta | Entrada adicional ao host | Finalidade |
| --- | --- | --- |
| `component_list` | nenhuma | listar componentes disponíveis |
| `component_read` | component_id, view; artifact_id, offset e expected_digest quando aplicáveis | ler fonte revisada e versão observada |
| `component_prepare_repair` | operation_id, task_id, component_id, artifact_id, expected_source_sha256, old_text, new_text | preparar mudança vinculada à tarefa |
| `component_validate_repair` | operation_id | registrar validação isolada |
| `component_apply_repair` | operation_id, expected_loaded_sha256 | aplicar versão validada |
| `component_repair_status` | operation_id | consultar estado e resultado sanitizado |
| `component_repair_reconcile` | operation_id | reconciliar sem repetir efeito |
| `component_verify_repair` | operation_id | verificar prova funcional e registrar resultado |
| `component_revert_repair` | operation_id, expected_loaded_sha256 | reverter com backup e versão conferidos |
| `component_scope_release` | operation_id, result_hash | liberar reserva terminal com resultado confirmado |
| `component_cancel_repair` | operation_id | cancelar somente antes do efeito |
| `task_scope_list` | page_size e cursor opcionais | listar reservas sanitizadas |

`component_id` admite `localizacao_pessoas`, `observacao_host`,
`external_heartbeat` e `icloud_adapter`. `view` admite `catalog`, `topology`,
`parameters`, `source` e `version`. IDs de operação/tarefa/artefato são
hexadecimais de 32 caracteres; hashes têm 64. Os fragmentos `old_text` e
`new_text` são limitados a 4.000 caracteres, dados para revisão e não comandos.
`expected_source_sha256` identifica o artefato editável revisado; a identidade
do runtime é separada. Preparar não autoriza executar o conteúdo da mudança.

O gateway futuro precisa vincular tarefas ao registro autenticado existente,
compartilhar seus contadores e verificar componentes reservados. Os callbacks
injetáveis destes módulos são interfaces internas de teste, não argumentos
do chatbot. Booleanos ou provas fornecidos pelo cliente não substituem
observações e recibos protegidos do executor.

## Fonte, configuração carregada e execução

O hash do conjunto de artefatos revisados não é o hash dos objetos de código
carregados. O leitor informa `source_identity_kind`, `loaded_identity_kind`,
`comparison_state` e `matches_reviewed_source`; identidades incompatíveis não
são comparadas e mantêm a relação desconhecida.

No Node-RED, `nodered_scoped_configuration_v1` identifica somente o canvas
permitido. A comparação normaliza `wires` ausente como vazio e remove apenas
arrays de portas vazias no final. Preserva posições das portas conectadas,
destinos, outputs, código e demais parâmetros. O arquivo revisado original
permanece intacto. Isso prova configuração implantada, sem provar execução
ou recuperação funcional. Conteúdo carregado não revisado resulta em unknown;
seu texto ou hash privado não é exportado.

Para iCloud, a prova existente contém fingerprint dos objetos Python no
processo HA. O port deve conferir nonce já existente, revisão, idade, PID e
instante de início no namespace do contêiner fixo, sem exec, login Apple,
refresh ou leitura de localização. `entry_ready` não comprova saúde remota.
Um hash dos arquivos não substitui essa prova.

O heartbeat pode comprovar aceite HTTP pelo provedor e preservar falhas antigas
após sucesso posterior. Enquanto não emitir identidade de código carregado,
essa versão permanece unknown. Os ports reais foram exercitados somente pelo
executor administrativo existente; não estão disponíveis à Eva nas ferramentas
propostas. Arquivos privados, bindings, registros e capturas reais não integram
este diretório público.

## Gates e recibos

Aplicação e rollback exigem confirmação explícita de coordenação; aplicação
também exige recursos confirmados. Ausência, número ou texto no lugar de true
não concede autorização. Intenção é persistida antes do efeito. Resposta
incerta mantém a reserva; reconciliar exige operação exata, recibo verificado
e executor terminal. Ver o hash esperado sozinho não comprova aplicação ou
ausência de envio. Reservas não expiram para liberar efeitos incertos.

Prova funcional exige falha anterior e sucesso posterior da mesma chamada,
componente e operação corretos, tempos finitos/coerentes, regressões verificadas
e ausência de testes domésticos adicionais. Heartbeat exige recibo do destino.
Saúde do contêiner, notificação removida ou notLoaded não encerram a tarefa.

## Teste e ativação futura

```sh
node --test --test-concurrency=1 scripts/raspberry-mcp/component-repair-candidate/candidate.test.mjs scripts/raspberry-mcp/component-repair-candidate/schemas.test.mjs
```

Os testes usam SQLite temporário, relógios e efeitos falsos. Não chamam rede,
daemon, Home Assistant ou dispositivos. Participam de make validate-public.

Antes de ativar a ampliação: concluir ports/executor, reservas e orçamentos
compartilhados; preparar diff, hashes, identidade, validade e revogação; obter
a aprovação específica exigida; então instalar pela cadeia existente e validar
submissão, resultado e prova natural pelo cliente MCP real. Não copiar estas
fontes sobre uma política ativa nem interpretar a publicação como aprovação.
