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
  entradas públicas; `schemas/` contém o contrato de cada tipo de saída.

Regere os arquivos com `python3 scripts/local-ai/high_potential_dataset.py` e
confira reprodutibilidade com `python3 scripts/local-ai/high_potential_dataset.py
--check`. O harness nunca escreve prompt, entrada ou saída local na telemetria:
os artefatos registram apenas métricas, hashes e resultados objetivos.
