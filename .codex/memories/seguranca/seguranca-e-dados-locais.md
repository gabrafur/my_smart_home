# Segurança e dados locais

- Nunca versione credenciais, tokens, coordenadas, chaves, registros de
  dispositivos, bancos ou outros dados de runtime. `.gitignore` e os guias de
  instalação e segurança são a fonte de verdade.
- Use arquivos privados documentados em vez de inserir segredos em código,
  flows, documentação ou memória. Nunca imprima valores de credenciais.
- Autorizações de conversas anteriores não substituem confirmação para ações
  sensíveis, destrutivas, externas ou irreversíveis.

<!-- memory-record {"id":"raspberry-mcp-fronteira-de-leitura","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-19","evidence":[{"file":"scripts/raspberry-mcp/core.mjs","sha256":"317deaea155b658edbad5fd1202d245e35964b0d753cec2726bc24a056a803c6"},{"file":"scripts/raspberry-mcp/server.mjs","sha256":"1b69e9269cddc289979aabf954a2f8ad5b6b2a2419b42b844df6d72a254fb30c"},{"file":"scripts/raspberry-mcp/install-local.py","sha256":"fa86d7e7d5c9eccc718946e282fca6d2c19ae6f6b0c1d29a99f631e4107fd1ca"},{"file":"docs/RASPBERRY_READONLY_MCP.md","sha256":"e8f94f464ac77f8c43e344d005840ac9cc7ae44e62ff0631521a7ec25702d65b"}]} -->
## Fronteira de leitura do MCP Raspberry

O adaptador em scripts/raspberry-mcp separa coleta local de atendimento MCP stdio. O servidor consulta somente snapshot sanitizado em caminho fixo; as cinco ferramentas aceitam apenas o host lógico raspberry e serviços enumerados. Logs retornam contagens, nunca linhas brutas. O instalador administrativo install-local.py prepara isolamento e socket Unix sem configurar túnel ou credenciais; validação sintética não comprova implantação. O relay tem destino fixo. A arquitetura e os gates de conta ChatGPT, ativação e revogação estão em docs/RASPBERRY_READONLY_MCP.md; acesso remoto do Codex não comprova disponibilidade na conversa ChatGPT.

<!-- /memory-record -->
