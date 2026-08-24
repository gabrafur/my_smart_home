# Dataset de benchmark RTX — alto potencial

Este diretório contém 100 fixtures públicas e anonimizadas para cinco classes:
extração estruturada, classificação, seleção de arquivos, agrupamento de erros e
resumo factual de diffs. `summarize-log` não participa da métrica principal.

- 70 casos são derivados de caminhos, contratos, símbolos e formatos já
  versionados no repositório; nenhum dado de runtime privado é incluído.
- 30 casos são sintéticos e determinísticos, incluindo 20 contratos
  adversariais.
- 60 casos formam o conjunto de calibração e 40 formam o holdout.
- `dataset.jsonl` contém metadados e ground truth; `inputs.json` contém somente
  entradas públicas; `schemas/` contém os contratos de saída e o schema v2 do
  relatório.

## Proveniência do ground truth

Os `expected_output` são construídos pelas funções de fixtures em
`high_potential_dataset.py`; o gerador não chama as funções
`deterministic_*` avaliadas pelo harness. O ground truth existe em arquivo e é
carregado antes das inferências, com hash SHA-256 estável.

Isso não comprova anotação independente: dataset, outputs esperados e braço
determinístico foram introduzidos no mesmo commit, e não foi localizada evidência
versionada de revisão manual ou por um anotador independente. O status auditado
é, portanto, `INSUFFICIENT_EVIDENCE` para todas as cinco classes. O resultado
determinístico 100/100 mede consistência com as fixtures, não uma comparação de
qualidade cuja independência esteja comprovada.

## Fluxo e fontes de verdade

```text
dataset.jsonl + inputs.json
  → expected_output (ground truth congelado no dataset)
  → deterministic_output / run_local
  → evaluate_output + schemas de atividade
  → aggregate + reconcile_inference_events
  → latest.json / CSV / events.jsonl / report.md
  → ia-bridge/usage.js::sanitizeHighPotentialBenchmark
  → sensor.codex_benchmark_rtx_alto_potencial
  → dashboard uso-rtx
  → relatório técnico versionado
```

O `latest.json` v2 é a fonte de verdade publicada para agregados. Os resultados
por caso e eventos reconciliados são as evidências subjacentes; o bridge apenas
sanitiza e limita os campos, o sensor os transporta e o painel os apresenta.

Regere os arquivos com `python3 scripts/local-ai/high_potential_dataset.py` e
confira reprodutibilidade com `python3 scripts/local-ai/high_potential_dataset.py
--check`. O harness nunca escreve prompt, entrada ou saída local na telemetria:
os artefatos registram apenas métricas, hashes e resultados objetivos.

Para recalcular o schema v2 a partir da evidência medida v1, sem nova inferência,
use `make benchmark-local-ai-high-potential-recompute`. O comando preserva o
artefato de origem sob `docs/benchmarks/local-ai-high-potential/history/`.
