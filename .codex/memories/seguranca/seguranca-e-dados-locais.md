# Segurança e dados locais

- Nunca versione credenciais, tokens, coordenadas, chaves, registros de
  dispositivos, bancos ou outros dados de runtime. `.gitignore` e os guias de
  instalação e segurança são a fonte de verdade.
- Use arquivos privados documentados em vez de inserir segredos em código,
  flows, documentação ou memória. Nunca imprima valores de credenciais.
- Autorizações de conversas anteriores não substituem confirmação para ações
  sensíveis, destrutivas, externas ou irreversíveis.

<!-- memory-record {"id":"raspberry-mcp-fronteira-de-leitura","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-25","evidence":[{"file":"scripts/raspberry-mcp/core.mjs","sha256":"f3e476b7e4027c68b4e987d12798c93714033e34e46fa33d2dfe13c9863f69d2"},{"file":"scripts/raspberry-mcp/server.mjs","sha256":"1b69e9269cddc289979aabf954a2f8ad5b6b2a2419b42b844df6d72a254fb30c"},{"file":"scripts/raspberry-mcp/install-local.py","sha256":"f259e148d218bf21401025cf40d4b7ec6d8f2a6589dfeb1f992a866e25b7f8cc"},{"file":"docs/RASPBERRY_READONLY_MCP.md","sha256":"6083b6f86422165e2bc06190e71d99b1a403fc9e912782a9f815c1b913652326"}]} -->
## Fronteira da base de leitura do MCP Raspberry

A base original de scripts/raspberry-mcp/core.mjs e server.mjs separa coleta local e atendimento stdio e define cinco leituras de snapshot sanitizado. Esse contrato histórico não representa sozinho o catálogo das camadas posteriores de manutenção e tarefas. Consulte tools/list e maintenance_capabilities na integração ativa para conhecer interfaces, limites e autorização realmente disponíveis. O instalador administrativo install-local.py prepara isolamento e socket Unix sem configurar túnel ou credenciais; não deve ser reaplicado sobre uma instalação existente. O relay tem destino fixo. docs/RASPBERRY_READONLY_MCP.md documenta a base e ampliações; instalação, catálogo do cliente e execução real exigem evidências distintas. Acesso remoto do Codex não comprova disponibilidade na conversa de outro chatbot.

<!-- /memory-record -->

<!-- memory-record {"id":"procmon-modo-atomico-e-evidencia-interrompida","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-25","evidence":[{"file":"scripts/raspberry-mcp/procmon-observability/README.md","sha256":"343c3d5933dd5411dc4e1403bd52910758c5fcb2db1388b1df8e9941a88c748b"},{"file":"scripts/raspberry-mcp/runtime-source/procmon-observability/observed_collector.py","sha256":"6ec3a67e7d034d77dedc2124f8cef46b2262c9ac51da3ac9fd3beb2eb50d219e"},{"file":"scripts/raspberry-mcp/procmon-observability/test_atomic_mode.py","sha256":"baee47a64490ffad5a0416c426c8dece95ec5e651ecebf8eb01b4ce5780c53a0"},{"file":"scripts/raspberry-mcp/procmon-observability/invocation_audit.py","sha256":"40731a78e5d3876113a3124946e09b108604546f0bef87e508b1179e018fc783"},{"file":"scripts/raspberry-mcp/procmon-observability/test_signal_io.py","sha256":"03271049fb61115fa03674baa4bc7736ca7d31a2e3633d0fd2b1258924d347a2"},{"file":"scripts/host-observation/test_accounting.py","sha256":"0b0365c3d6980b8fb73dd8627b3486d79e616f954d19bd5799002e756831c418"}]} -->
## Modo atômico e preservação da coleta interrompida

Na instrumentação do procmon, o arquivo público deve nascer com o modo exigido pelo próprio coletor: uma interrupção antes do fchmod pode deixar um temporário vazio que o gate estrito corretamente rejeita. O wrapper ajusta apenas o umask durante a chamada atômica e o restaura; não modifica o coletor original nem relaxa modos, limites ou gates. Recuperação administrativa confirma identidade e preserva o temporário intacto em quarentena, sem promovê-lo a amostra. Retorno de ciclos naturais não preenche lacunas históricas nem comprova continuidade de 24h. A regressão isolada prova a janela de criação, não o sinal ou caller histórico.

Conclusão de invocação e amostra durável são evidências distintas: publicação pode falhar depois da gravação da amostra. Correlacione início, fim e telemetria por boot e invocação; ausência de telemetria não implica custo zero. Distinga CPU desde o observador, CPU do processo até a emissão e CPU da unidade inteira. Memória sem contador continua desconhecida. Adaptadores de sinais e fsync devem preservar handlers, agenda e limites originais. Aumentar frequência exige verificar retenção antes.

<!-- /memory-record -->

<!-- memory-record {"id":"mcp-observacao-e-contagem-nao-provam-execucao","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-25","evidence":[{"file":"docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md","sha256":"867c16e48eb2ca866140876b3cfd7d3f6fb19ca96f0bd63d69c8e1439a3aba08"},{"file":"scripts/raspberry-mcp/runtime-source/repair-control/health_summary.py","sha256":"decebe0c0d713db85d4fbd6553d1bb2a7dfeb53fe9ee31aec3bcfd790b843788"},{"file":"scripts/raspberry-mcp/runtime-source/native-events/registry.py","sha256":"df3e345815f2dd0d1fa79df1c415fcd42c59e4d0d4afebe70ab125e222b5ee18"},{"file":"scripts/raspberry-mcp/event-delivery-health.test.mjs","sha256":"77e02abe62408a822f6309c788e05b0ed0ef943d41489a625a256af66e5e7d9e"}]} -->
## Observação MCP, contagem e execução são evidências distintas

O MCP projeta somente metadados de arquivos fixos protegidos, com owner/modo/limite e schema; state observed descreve disponibilidade da observação, sem provar saúde global ou autoridade. Contexto da aplicação não é aprovação administrativa. O resumo sanitizado da coordenadora exposto por maintenance_capabilities tem validade de cinco minutos e informa trabalho declarado; quando stale mantém reservas sem liberar trabalho, e não autoriza envio nem comprova execução. Registros retidos de Events incluem eventos já enviados; pendência elegível usa o mesmo principal ativo, tópico, janela e início da assinatura do dispatcher. Qualquer intent existente exclui o evento, inclusive resultado incerto, sem virar retry. Respostas antigas com apenas o total mantêm pendência desconhecida. Orçamento disponível, callback aceito, entrega ao destino e execução do assistente continuam provas separadas. Consultas de contagem não podem apagar histórico nem alterar assinatura, IDs ou limites.

<!-- /memory-record -->
