# Caminhos permanentes e preservação de evidências

O ponto de entrada permanente é [README.md](README.md). Os nomes operacionais
não levam datas; datas de observação ficam no conteúdo ou nos recibos a que ele
se refere. Referências antigas continuam resolvendo por arquivos curtos de
compatibilidade, sem duplicar o manual.

| Caminho anterior em `docs/` | Destino em `docs/raspberry-mcp/` |
| --- | --- |
| [RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md](../RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md) | `README.md`, `architecture.md`, `installation.md`, `tools.md`, `operations.md` e referências temáticas |
| [RASPBERRY_READONLY_MCP.md](../RASPBERRY_READONLY_MCP.md) | `reference/read-only-base.md` |
| [RASPBERRY_CODEX_TASKS.md](../RASPBERRY_CODEX_TASKS.md) | `reference/task-control.md` |
| [RASPBERRY_MCP_MAINTENANCE_MATRIX.md](../RASPBERRY_MCP_MAINTENANCE_MATRIX.md) | `maintenance/matrix.md` |
| [RASPBERRY_MCP_MAINTENANCE_STAGE1.md](../RASPBERRY_MCP_MAINTENANCE_STAGE1.md) | `maintenance/stage1.md` |
| [RASPBERRY_MCP_EVIDENCE_STAGE2.md](../RASPBERRY_MCP_EVIDENCE_STAGE2.md) | `maintenance/evidence-stage2.md` |
| [RASPBERRY_MCP_OPERATIONS_PROPOSAL.md](../RASPBERRY_MCP_OPERATIONS_PROPOSAL.md) | `maintenance/proposals.md` |

O manual antes monolítico foi dividido por headings, preservando os contratos e
links de evidência por tema. A história Git conserva o conteúdo anterior. Os
índices públicos apontam para os novos destinos; referências históricas de memória
mantêm seus hashes originais e não devem ser apresentadas como verificação dos
novos bytes. A documentação geral de saúde do Raspberry permanece no seu próprio
[manual](../RASPBERRY_PI_SYSTEM_HEALTH.md), pois também atende produtores que não
pertencem ao MCP.

Fontes, manifests, licenças e README de cada pacote permanecem próximos ao código
em `scripts/raspberry-mcp/`; o índice operacional referencia esses contratos, sem
copiar o pacote para `docs/`. Pacotes `*-candidate` e `runtime-source` continuam
identificando candidatos e exportações sanitizadas; a localização no repositório
não os transforma em instaladores da política ativa.

Não foram renomeados, apagados ou arquivados planos congelados, aprovações, IDs,
recibos, backups ou estado privado. Esses artefatos têm identidade própria e são
necessários para reconciliação. Um índice privado pode localizá-los sem expor seu
conteúdo; qualquer arquivamento deve aguardar o fechamento das operações que os
referenciam. A retirada futura dos arquivos de compatibilidade exige reconciliar
os consumidores e a evidência histórica explicitamente.
