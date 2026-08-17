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
