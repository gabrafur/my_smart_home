# Benchmark Local AI — atividades de alto potencial (schema v2)

Execução original: `7cfc9f52-17f3-4eb7-94ce-4faf0a9fba9b` · modelo `qwen2.5-coder:14b` · artefato recalculado: `True`.

## 1. Veredito executivo revisado

Nas cinco atividades avaliadas além de `summarize-log`, a RTX demonstrou capacidade de produzir saídas utilizáveis em alguns casos, mas não demonstrou vantagem operacional incremental sobre o baseline determinístico.

Das 70 tarefas encaminhadas à IA local, 27 produziram saída aceita e selecionada no benchmark, com redução validada de contexto estimado. Isso corresponde a 38.57% entre tentativas e 27.00% sobre os 100 casos. Houve 43 fallbacks e 86 inferências.

A redução de 37.35% é estimada para um cenário GPT direto simulado; não representa tokens cobrados, economia financeira ou redução medida em chamadas reais ao GPT-5.6. Nenhuma atividade foi promovida.

## 2. Metodologia e bases de medição

- **MEDIDO:** inferência local, latência local, tokens Ollama e telemetria de GPU da execução original.
- **ESTIMADO:** tokens GPT pela aproximação `bytes UTF-8 / 4`.
- **SIMULADO:** execução GPT direta; nenhuma chamada real ao GPT-5.6 ocorreu.
- **NÃO TESTADO:** qualidade final, cobrança e latência do GPT-5.6.
- Ground truth: `INSUFFICIENT_EVIDENCE`. Foi congelado antes das inferências, mas não existe evidência versionada de anotação ou revisão independente.

## 3. Denominadores

| Escopo | Casos totais | Elegíveis | Tentativas RTX | Inferências | Aceitas | Useful rate entre tentativas | Cobertura end-to-end | Fallback |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Global | 100 | 70 | 70 | 86 | 27 | 38.57% | 27.00% | 43 |

| Atividade | Casos totais | Elegíveis | Tentativas RTX | Inferências | Aceitas | Useful rate entre tentativas | Cobertura end-to-end | Fallback | Decisão |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| structured_extraction | 20 | 16 | 16 | 16 | 9 | 56.25% | 45.00% | 7 | DETERMINISTIC_FIRST |
| classification | 20 | 14 | 14 | 14 | 0 | 0.00% | 0.00% | 14 | DETERMINISTIC_FIRST |
| file_selection | 20 | 16 | 16 | 32 | 6 | 37.50% | 30.00% | 10 | DETERMINISTIC_FIRST |
| error_clustering | 20 | 16 | 16 | 16 | 12 | 75.00% | 60.00% | 4 | DETERMINISTIC_FIRST |
| diff_summary | 20 | 8 | 8 | 8 | 0 | 0.00% | 0.00% | 8 | DETERMINISTIC_FIRST |

## 4. Erros críticos

O campo legado `critical_errors=25` contava casos únicos com ao menos uma flag crítica, não ocorrências. A recomputação identifica 32 ocorrências categóricas em 25 casos; taxa por caso entre tentativas: 35.71%; ocorrências por inferência: 0.3721.

Uma ocorrência é uma flag `critical_omission` ou `critical_hallucination`. Uma inferência híbrida extra não cria outro caso. O artefato v1 não preservou validações completas para todas as inferências local-only; portanto, `local_inferences_with_critical_error` permanece indisponível.

## 5. Comparação com o melhor baseline

O braço determinístico teve schema válido em 100/100, aceite de qualidade em 100/100, exact match em 40/100 e 0 casos unsupported. Esses valores medem consistência com fixtures cujo ground truth é `INSUFFICIENT_EVIDENCE`.

| Atividade | Qualidade RTX | Qualidade baseline | p50 RTX | p50 baseline | Fallback RTX | Vantagem operacional |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| structured_extraction | 0.9031 | 1.0000 | 5.721s | 0.000s | 43.75% | `false` |
| classification | 0.2143 | 1.0000 | 3.832s | 0.000s | 100.00% | `false` |
| file_selection | 0.8726 | 1.0000 | 5.186s | 0.000s | 62.50% | `false` |
| error_clustering | 0.7500 | 1.0000 | 5.118s | 0.000s | 25.00% | `false` |
| diff_summary | 0.0000 | 1.0000 | 28.740s | 0.000s | 100.00% | `false` |

Nenhuma atividade superou o melhor baseline segundo os critérios documentados.

## 6. Casos adversariais

Os guardrails detectaram e trataram corretamente 20/20 cenários adversariais simulados. Não houve execução do modelo nesses checks; outputs do modelo aceitos/rejeitados: 0/0.

## 7. Política operacional

Fluxo autorizado: `método determinístico → validação → GPT direto quando ambíguo, não suportado ou insuficiente`. Shadow mode não altera a saída usada pelo sistema nem contabiliza economia operacional.

| Atividade | Local AI | Fallback não resolvido | Decisão |
| --- | --- | --- | --- |
| structured_extraction | shadow | gpt-direct | DETERMINISTIC_FIRST |
| classification | disabled | gpt-direct | DETERMINISTIC_FIRST |
| file_selection | shadow | gpt-direct | DETERMINISTIC_FIRST |
| error_clustering | shadow | gpt-direct | DETERMINISTIC_FIRST |
| diff_summary | disabled | gpt-direct | DETERMINISTIC_FIRST |
| summarize_log | separate | separate | SEPARATE_BENCHMARK |

## 8. Limitações

Não houve chamada real ao GPT-5.6. A independência do ground truth não foi comprovada. O artefato v1 não reteve o output bruto local nem violações por todas as 86 inferências, impedindo reconstrução de uma taxa por inferência individual. A recomputação não alterou dataset, prompts, modelo ou lógica de validação e não reexecutou a RTX.

## 9. Artefatos e hashes

Schema `2`; dataset `321e9ee4aae5c6df2da714797b1c22bd711fd1cc1d90657dcdbc4cbe6c8872dc`; ground truth `d7ea4ea564276c9df93c886401f75d873853bf7e3ba95da5bc1fa6d2f35751fa`; schemas atuais `4f459fd7e0b4282fb19aee71dbc9c2e4af7bf232bd2d627ed7cb150e94ca099a`; schemas na execução `431fd5afd048a2ec7ba97f5b84bd3196057d6b69c72950aed32a7a66f0f2fa48`; prompts reconstruídos `f3fdd9b0f1bf3a6ac702ff5be840798263e6bc998dc4e3735ac883b0e12d1f5f`; configuração reconstruída do modelo `5a0fb6add3eae6f5292adfc96f8cd80530eee5182c379d2788299db9a2ee1aee`.

Implementação da inferência v1 `5df9c1d830a4b278431426aff6f2d98fc0daaffa882d3d6d6df8e8cf59b7f782`; implementação da recomputação `61ec8f941c83b267e239e232919b61094dabffe5b1a98dd9b018bae5eab28f76`. A base de cada hash está em `artifact_hash_basis`.

Artefato v1 preservado em `docs/benchmarks/local-ai-high-potential/history/v1-2026-08-24/latest.json`. `results_recomputed_from_existing_raw_artifacts=true`.
