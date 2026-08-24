# Benchmark Local AI — atividades de alto potencial

Execução: `7cfc9f52-17f3-4eb7-94ce-4faf0a9fba9b` · modelo `qwen2.5-coder:14b` · modo `benchmark`.

`summarize-log` foi excluído da métrica principal e nenhuma atividade foi habilitada em produção.

## Cenários e medição

- Cenário A (GPT direto): contexto e tokens simulados/estimados; não houve chamada paga ao GPT-5.6.
- Cenário B (RTX): inferência, tokens Ollama, latência e GPU medidos; o resultado aceito é o contexto que seguiria ao GPT.
- Cenário C (determinístico): parser, regras, busca/ranking ou assinaturas executados e comparados ao mesmo ground truth.

## Dataset

100 casos: 70 reais anonimizados e 30 sintéticos; 60 de calibração e 40 de holdout.

## Resultado global

Foram avaliados 100 casos; 70 tentaram RTX, 27 foram aceitos e 43 usaram fallback.
Useful RTX rate: 38.6%. Economia ponderada pela soma dos tokens: 37.3%; economia ponderada pela frequência declarada: 34.6%.
Baseline: 237627 tokens; roteados: 148879; evitados: 88748. Fallback: 61.4%; erros críticos: 25. Latência p50/p95: 5.184s/28.774s.

## Por atividade

| Atividade | Casos | Qualidade | Useful RTX | Economia | Fallback | p50 | p95 | Decisão |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| structured_extraction | 20 | 90.3% | 56.2% | 57.7% | 43.8% | 5.721s | 9.796s | DETERMINISTIC_FIRST |
| classification | 20 | 21.4% | 0.0% | 0.0% | 100.0% | 3.832s | 8.561s | DETERMINISTIC_FIRST |
| file_selection | 20 | 87.3% | 37.5% | 44.9% | 62.5% | 5.186s | 7.423s | DETERMINISTIC_FIRST |
| error_clustering | 20 | 75.0% | 75.0% | 68.5% | 25.0% | 5.118s | 7.167s | DETERMINISTIC_FIRST |
| diff_summary | 20 | 0.0% | 0.0% | 0.0% | 100.0% | 28.740s | 30.868s | DETERMINISTIC_FIRST |

## Métricas objetivas

- **structured_extraction:** `schema_validity=1.0`, `critical_field_recall=0.8125`, `critical_hallucinations=7`, `field_precision=0.8698`, `field_recall=0.9531`, `field_f1=0.9031`, `numeric_preservation=1.0`, `invented_fields=7`, `omitted_fields=3`.
- **classification:** `schema_validity=1.0`, `critical_field_recall=0.8571`, `critical_hallucinations=0`, `accuracy=0.0`, `label_precision=0.2857`, `label_recall=0.1905`, `label_f1=0.2143`, `critical_route_recall=0.8571`, `abstention_rate=0.7143`, `eligibility_false_positives=4`, `eligibility_false_negatives=4`, `unsafe_false_positives=0`, `macro_f1=0.1818`.
- **file_selection:** `schema_validity=1.0`, `critical_field_recall=0.375`, `critical_hallucinations=0`, `precision_at_k=1.0`, `recall_at_k=0.7917`, `critical_file_recall=0.7917`, `mean_reciprocal_rank=1.0`, `irrelevant_files=0`, `critical_files_omitted=12`.
  Híbrido versus local-only: aceite 37.5% versus 12.5%; qualidade 0.8726 versus 0.7655.
- **error_clustering:** `schema_validity=1.0`, `critical_field_recall=0.75`, `critical_hallucinations=4`, `pairwise_precision=0.75`, `pairwise_recall=0.75`, `pairwise_f1=0.75`, `cluster_purity=0.9375`, `false_merges=4`, `false_splits=0`, `critical_false_merges=4`, `root_cause_preservation=0.8333`.
- **diff_summary:** `schema_validity=0.25`, `critical_field_recall=0.75`, `critical_hallucinations=0`, `factual_precision=0.0`, `critical_fact_recall=0.0`, `evidence_validity=1.0`, `unknown_recall=1.0`.

## Comparação determinística

O cenário determinístico foi aceito em 100/100 casos, com score médio 1.0000 e latência p50 abaixo de 1 ms.

## Configuração recomendada

```yaml
- activity: structured_extraction
  decision: DETERMINISTIC_FIRST
  model: qwen2.5-coder:14b
  minimum_input_tokens: 800
  maximum_input_tokens: 6000
  confidence_threshold: 0.9
  required_validation: true
  fallback: gpt-direct
  production_enabled: false
  reason: O método determinístico atingiu qualidade igual ou superior com menor latência.
- activity: classification
  decision: DETERMINISTIC_FIRST
  model: qwen2.5-coder:14b
  minimum_input_tokens: 800
  maximum_input_tokens: 6000
  confidence_threshold: 0.9
  required_validation: true
  fallback: gpt-direct
  production_enabled: false
  reason: O método determinístico atingiu qualidade igual ou superior com menor latência.
- activity: file_selection
  decision: DETERMINISTIC_FIRST
  model: qwen2.5-coder:14b
  minimum_input_tokens: 800
  maximum_input_tokens: 6000
  confidence_threshold: 0.9
  required_validation: true
  fallback: gpt-direct
  production_enabled: false
  reason: O método determinístico atingiu qualidade igual ou superior com menor latência.
- activity: error_clustering
  decision: DETERMINISTIC_FIRST
  model: qwen2.5-coder:14b
  minimum_input_tokens: 800
  maximum_input_tokens: 6000
  confidence_threshold: 0.9
  required_validation: true
  fallback: gpt-direct
  production_enabled: false
  reason: O método determinístico atingiu qualidade igual ou superior com menor latência.
- activity: diff_summary
  decision: DETERMINISTIC_FIRST
  model: qwen2.5-coder:14b
  minimum_input_tokens: 800
  maximum_input_tokens: 6000
  confidence_threshold: 0.9
  required_validation: true
  fallback: gpt-direct
  production_enabled: false
  reason: O método determinístico atingiu qualidade igual ou superior com menor latência.
```

## Casos adversariais

20/20 guardrails passaram em simulação determinística.

## Limitações

O braço GPT direto usa volume de contexto simulado; tokens GPT são estimados por bytes/4. A qualidade da resposta final do GPT-5.6 não foi testada. Os pesos de frequência são declarados, não derivados de conversas privadas. A inferência RTX, a latência e o sampler são medidos; os casos adversariais de indisponibilidade/timeout são simulados. Não há promoção automática do roteador.
