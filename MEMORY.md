# Índice de memórias do projeto

Este é o índice de compatibilidade para a memória de longo prazo do
repositório. A fonte canônica está em
`.codex/memories/projeto/indice.md`. Quando uma tarefa depender do histórico do
projeto, use o índice canônico com `AGENTS.md` para localizar somente o arquivo
temático pertinente. A configuração e a documentação versionadas têm
precedência sobre estas anotações.

## Índice

| Assunto | Arquivo | Quando consultar |
| --- | --- | --- |
| Práticas de trabalho e Git | [`.codex/memories/praticas-de-trabalho/praticas-de-trabalho.md`](.codex/memories/praticas-de-trabalho/praticas-de-trabalho.md) | Alterações, testes, commits ou push |
| Automações e interface | [`.codex/memories/automacoes/automacoes-e-interface.md`](.codex/memories/automacoes/automacoes-e-interface.md) | Node-RED, Home Assistant, painéis, alarme ou portão |
| Integrações e operação | [`.codex/memories/integracoes/integracoes-e-operacao.md`](.codex/memories/integracoes/integracoes-e-operacao.md) | Veículo principal, Moni Mobile, MQTT, Bluetooth, Matter ou energia |
| Codex e Local AI | [`.codex/memories/codex-local-ai/codex-e-local-ai.md`](.codex/memories/codex-local-ai/codex-e-local-ai.md) | Helper local, RTX, hook, telemetria ou painéis Codex/RTX |
| Segurança e dados locais | [`.codex/memories/seguranca/seguranca-e-dados-locais.md`](.codex/memories/seguranca/seguranca-e-dados-locais.md) | Credenciais, arquivos privados ou acesso ao host |
| Governança da memória | [`.codex/memories/projeto/governanca-da-memoria.md`](.codex/memories/projeto/governanca-da-memoria.md) | Criar, revisar, validar ou anonimizar memória de agentes |
| Privacidade e bindings | [`.codex/memories/privacidade/papeis-bindings-e-fronteira-publica.md`](.codex/memories/privacidade/papeis-bindings-e-fronteira-publica.md) | Papéis públicos, bindings privados, scanner ou restauração sanitizada |
| Restore, bootstrap e demo | [`.codex/memories/restore/contrato-restore-bootstrap-demo.md`](.codex/memories/restore/contrato-restore-bootstrap-demo.md) | Bundle, recovery, clone novo, módulos, demo ou contexto da IA |

## Manutenção

- Inclua somente decisões reutilizáveis e confirmadas pela configuração ou
  documentação atual.
- Atualize a memória temática e seu guia em `docs/` na mesma mudança quando
  uma decisão operacional for alterada.
- Não registre segredos, identificadores privados, dados de runtime ou
  autorizações temporárias.
