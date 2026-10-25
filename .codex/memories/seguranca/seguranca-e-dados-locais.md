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
