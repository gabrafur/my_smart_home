# Retrieval e reranking com RTX

Decisão: `NOT_DEMONSTRATED`. No holdout de 150 casos snapshot-consistent, o híbrido obteve recall crítico@10 de 25.56%, MRR@10 0.1466 e nDCG@10 0.1896.

Nenhum caminho é gerado: todos os rankings usam apenas chunks do snapshot Git. Não foi criado índice persistente antes do gate.

Limitações: workload histórico Git; sem challenger instalado ou reranker compatível; tokens estimados. O primeiro harness pressionou recursos e foi substituído por batches antes da execução canônica.
