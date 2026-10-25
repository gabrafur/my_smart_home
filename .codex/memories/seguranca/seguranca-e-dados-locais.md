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

<!-- memory-record {"id":"procmon-modo-atomico-e-evidencia-interrompida","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-25","evidence":[{"file":"scripts/raspberry-mcp/procmon-observability/README.md","sha256":"fe603f25932d834ab4588936dcf388e17c6b839807341f3e37e24462cc1585d8"},{"file":"scripts/raspberry-mcp/runtime-source/procmon-observability/observed_collector.py","sha256":"f2219f4e52a291070ecec182e0ce2d6f345f94458712df6d745184f0d680f7fe"},{"file":"scripts/raspberry-mcp/procmon-observability/test_atomic_mode.py","sha256":"baee47a64490ffad5a0416c426c8dece95ec5e651ecebf8eb01b4ce5780c53a0"}]} -->
## Modo atômico e preservação da coleta interrompida

Na instrumentação do procmon, o arquivo público deve nascer com o modo exigido pelo próprio coletor: uma interrupção antes do fchmod pode deixar um temporário vazio que o gate estrito corretamente rejeita. O wrapper ajusta apenas o umask durante a chamada atômica e o restaura; não modifica o coletor original nem relaxa modos, limites ou gates. Recuperação administrativa confirma identidade e preserva o temporário intacto em quarentena, sem promovê-lo a amostra. Retorno de ciclos naturais não preenche lacunas históricas nem comprova continuidade de 24h. A regressão isolada prova a janela de criação, não o sinal ou caller histórico.

<!-- /memory-record -->
