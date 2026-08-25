# Dataset residual do bake-off Local AI

Este conjunto público e sanitizado contém 100 casos novos, 20 para cada uma
das cinco atividades avaliadas além de `summarize-log`. Os cinco primeiros
casos de cada atividade formam a calibração; os outros 15 formam o holdout de
promoção. A divisão é congelada antes de qualquer inferência.

Todos os casos retornam `UNSUPPORTED`, `AMBIGUOUS` ou
`NEEDS_SEMANTIC_REVIEW` no braço determinístico limitado do harness. Os casos
que deixarem de ser residuais tornam a validação do dataset inválida e precisam
ser substituídos antes de uma nova rodada.

O ground truth vem de seeds e contratos objetivos separados do caminho
determinístico avaliado. Extração, agrupamento e diff têm fatos literais
verificáveis. Classificação e seleção de arquivos permanecem
`PARTIALLY_INDEPENDENT`; seus fatos críticos são fechados no manifesto, mas a
decisão semântica não é apresentada como autoria humana independente. Os campos
`manual_review_evidence` e `independent_authorship_evidence` são `null`.

Quatro casos de cada atividade contêm instruções adversariais tratadas como
dados não confiáveis. O modelo não recebe ferramentas e só pode devolver o JSON
do schema. O dataset não contém conversas, telemetria privada, endpoints,
credenciais ou identificadores de residentes.

Regere com:

```bash
python3 scripts/local-ai/quality_bakeoff_dataset.py
python3 scripts/local-ai/quality_bakeoff_dataset.py --check
```
