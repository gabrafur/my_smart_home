# MCP Raspberry: matriz de manutenção e entrega incremental

Levantamento de 19/10/2026. Host autorizado: `raspberry`. Estado inicial: 11 ferramentas instaladas; fontes e serviços são superfícies distintas. As alterações anteriores do checkout estão preservadas. Nenhum novo privilégio de escrita está autorizado por este documento.

| Necessidade | Existente / proposta | Acesso | Risco | Validação e cobertura | Recuperação |
| --- | --- | --- | --- | --- | --- |
| Descobrir capacidades e limites | `tools/list` / `maintenance_capabilities` | Leitura | Baixo | Contrato versionado, permissões e exclusões explícitas | Não altera estado |
| CPU, memória, swap, temperatura, throttling, disco e inodes | `disk_space` / `host_diagnostics` | Leitura | Baixo | Fontes locais fixas; desconhecido quando indisponível; idade e erro por coleta | Não altera estado |
| Serviços, containers, reinícios e prontidão | `service_health`, `service_versions` / `service_diagnostics` | Leitura | Baixo | Três containers autorizados; estado do processo separado de healthcheck e conectividade funcional | Não altera estado |
| Tarefas e dependências | Workers existentes / inventário limitado | Leitura | Baixo | MCP, backup Git e etapas de atualização identificadas pelo código; não inventariar outros hosts | Não altera estado |
| Logs úteis sem dados privados | `log_summary` / `log_events` | Leitura | Moderado | Janela fixa, paginação e categorias determinísticas; sem mensagem bruta, nomes pessoais ou URLs | Não persiste logs brutos |
| Backups, atualizações, filas e último sucesso | `backup_results` / `job_diagnostics` | Leitura | Baixo | Resultados dos workers existentes; sucesso de execução não equivale a integridade ou restauração | Não solicita backup nem update |
| Projetos, busca e diferenças | `project_files`, `project_read` / `project_search`, `project_state` | Leitura | Moderado | Apenas catálogo aprovado; sem caminhos livres; mudanças externas não são expostas como fonte confiável | Nenhuma sobrescrita |
| Editar fontes | `project_prepare_edit`, `change_apply`, `change_revert` | Escrita já existente | Moderado/alto | SHA esperado, prévia, cópia anterior e conflito; ainda não há gate completo de testes nem deploy | Reversão exige hash correspondente; falha ambígua exige inspeção |
| Validar antes de aplicar | Proposta `change_validate` | Leitura da proposta / processo isolado | Baixo se apenas análise estática | Sintaxe sem executar código; testes de comportamento exigem ambiente isolado sem rede ou credenciais | Temporários descartados; nenhum efeito residencial |
| Consultar operação após timeout | Proposta `operation_status` | Leitura | Baixo | ID, status, alvo, hashes e tempos; nunca repetir resultado desconhecido | Reconciliação, não repetição cega |
| Reload, deploy e prontidão | Ainda não expostos | Nova escrita, aprovação necessária | Alto | Gate de teste ligado ao hash; alvo exato; pré-condições; pós-verificação funcional | Rollback apenas se reversível, sem migração incompatível |
| Reinício individual | `service_prepare_restart` + `change_apply` | Escrita já existente | Alto | Só HA, Node-RED ou Mosquitto; hoje não verifica prontidão funcional imediatamente | Reinício não tem undo; não é correção padrão |
| Update controlado | Workers existentes, não conectados ao MCP | Nova escrita, aprovação necessária | Alto | Usar orquestração do Node-RED; compatibilidade, backup e candidato identificado | Nunca downgrade automático de banco/volume |
| Solicitar backup / testar restauração | Workers existentes, não conectados ao MCP | Nova escrita, aprovação necessária | Alto | Backup Git pode publicar; offsite usa credenciais próprias; restauração primeiro em canário isolado | Preservar produção, artefatos e evidência de restauração |
| Tendências e observação externa | Ainda não expostos | Persistência / serviço externo, aprovação necessária | Moderado | Séries limitadas e observador independente; ausência de resposta local não prova causa da queda | Retenção limitada; nenhuma nova conta/rede nesta etapa |
| Sessão MCP e HTTP 409 | Reparo de `_meta` e sessão já instalado / testes adicionais | Testes de leitura | Baixo | Sequencial, concorrência limitada, reconexão e idle; distinguir servidor stdio e guard do túnel | Reconectar e inicializar antes de repetir; mutações por ID |

## Etapas

1. Diagnóstico: implementar contratos de leitura, sanitização e testes sintéticos; conservar as onze ferramentas originais.
2. Validação: preparar analisadores estáticos e consulta de operações; demonstrar com fixture isolada, sem dispositivos nem rede residencial.
3. Aprovação: apresentar cada nova capacidade de escrita com alvo, impacto, timeout, precondições, critério de sucesso e recuperação. Nenhum deploy/update/backup novo fica habilitado por padrão.
4. Caso seguro real: selecionar um alvo canário local inerte, demonstrar diagnóstico → proposta → teste → aplicação → verificação → reversão. A aprovação deverá identificar esse alvo; não usar um serviço da casa como cobaia.
5. Eva: atualizar ferramentas do mesmo plugin e repetir chamadas reais. Testes locais não substituem essa validação.

## Achados e limites do levantamento

- Existem scripts para backup Git, atualização por etapas, offsite e restauração. O MCP não deve substituir a orquestração canônica de atualizações do Node-RED.
- A sonda MQTT existente lê credenciais dentro de um container. Ela não será incorporada como simples diagnóstico sem revisar e aprovar esse acesso. Neste primeiro estágio, conectividade funcional não medida será `unknown`.
- O resultado atual do backup Git contém `reason`, mas a ferramenta antiga não o projeta. A primeira etapa pode expor somente motivos conhecidos e IDs seguros, sem saída bruta.
- As onze ferramentas atuais não oferecem inventário completo, tendências, deploy, update ou restauração. Arquivo editado não significa configuração carregada.
- A documentação oficial do tunnel-client identifica o 409 `mcp_initialization_required` como rejeição anterior ao envio ao filho stdio quando falta inicialização legada. A causa concreta nesta instalação ainda precisa de evidência; não declarar corrigida apenas porque uma repetição funcionou.

Referências: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) e [ciclo de inicialização do cliente oficial](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md).
