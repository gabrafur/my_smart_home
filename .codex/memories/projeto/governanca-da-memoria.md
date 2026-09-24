# Governança da memória versionada

A memória dos agentes é arquitetura documentada, mas nunca supera código,
configuração, testes, documentação operacional ou decisões arquiteturais
vigentes. Quando houver divergência, corrija a memória; não adapte o sistema
apenas para preservar uma anotação antiga.

`.codex/memories/` é a única exceção pública dentro do runtime privado
`.codex/`. `MEMORY.md` permanece como índice de compatibilidade conciso e
`.codex/memories/projeto/indice.md` como índice canônico. Todo arquivo temático
deve aparecer nos dois índices.

Registre somente decisões reutilizáveis, invariantes, riscos recorrentes,
procedimentos de recovery e razões para comportamentos não óbvios. Use papéis
lógicos como `resident_primary`, `mobile_primary`, `vehicle_primary`,
`garage_gate`, `exterior_light` e `security_panel`; não registre nomes,
identificadores privados, rotinas, logs, transcripts ou dados reais da
residência.

Histórico privado não é fonte da revisão automática. Quando o conhecimento só
existir nele, reporte `knowledge_not_versioned` sem ler ou copiar o conteúdo.

Consulte [o contrato operacional](../../../docs/MEMORIA_VERSIONADA_AGENTES.md)
e rode `make validate-public` depois de qualquer mudança na memória ou nas
instruções dos agentes.

<!-- memory-record {"id":"captura-e-revisao-publica","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-09-24","evidence":[{"file":"ia-bridge/history.js","sha256":"d47565b6015beea1453baad79f8e04fea4626498c4f8fdc99a74cade2f436d02"},{"file":"scripts/ai-context-recovery.mjs","sha256":"91eb0f7a235aed323043160db5ac172841389a35cb46b435151c230a25249e21"},{"file":"scripts/memory-review.mjs","sha256":"0efffc8a179bc92b2e0b026d0b5bc695e93c520d3c1e5c38376d8b74321a1606"},{"file":"scripts/memory-review.test.mjs","sha256":"21d10a7039c21040dad39ccbc0aa8eab071ac4b14b99d43cf1ce4e595b0ece1c"},{"file":"docs/MEMORIA_VERSIONADA_AGENTES.md","sha256":"584c8772379367da5f71b2d21477f1fece0defd4929f361f59556c4441ad71e3"}]} -->
## Captura e revisão entre tarefas

O histórico do bridge é privado e não alimenta a memória temática por si. O checker de restore comprova disponibilidade de arquivos, não uso por outra sessão. Os hooks de revisão exigem checkpoint por turno quando aprovados e ativos no cliente; não leem transcripts. O agente seleciona fatos públicos verificados e o reconciliador atualiza notas por ID com evidência. Sem ativação comprovada, não alegue captura automática. A revisão semanal depende de execução bem-sucedida e não garante atualização após cada conversa. Consulte `docs/MEMORIA_VERSIONADA_AGENTES.md` e `docs/CODEX_PROJECT_MEMORY_AUDIT.md`.

UserPromptSubmit prepara o checkpoint e orienta a revisão antes da resposta final via additionalContext interno. Stop apenas verifica o recibo do mesmo turno e o fingerprint atual, sem decision: block ou reason que gerariam prompt visível no chat. O agente não anuncia a revisão; falhas reais continuam explícitas. Reentrega do evento preserva o checkpoint. Mudança de definição requer revisão dos hooks no cliente; testes sintéticos não comprovam ativação.

As restrições de fontes públicas e de efeitos do contexto injetado são exclusivas da revisão de memória. Elas não bloqueiam consultas operacionais autorizadas a logs, histórico de notificações, bancos de dados ou configuração privada. A tarefa segue suas demais regras, e conteúdo privado não é copiado para arquivos públicos. Consulte `docs/MEMORIA_VERSIONADA_AGENTES.md`.

<!-- /memory-record -->
