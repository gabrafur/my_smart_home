# Bake-off quality-first de modelos locais

- Execução: `9b798bb9-612e-4d98-96ca-dca47063c32e`
- Data: 2026-08-25 (UTC)
- Veredito: `NOT_DEMONSTRATED`

A regressão v2 permanece apenas como consistência com fixtures. A decisão de promoção usa exclusivamente o holdout residual v3, congelado antes das inferências.

## Primary no promotion holdout

| Atividade | Modelo | Pass@1 | Úteis | Fallback | Casos críticos | Recall crítico | GPT evitado | Status |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `structured_extraction` | `qwen2.5-coder:14b` | 100.00% | 15 | 0 | 0 | 100.00% | 100.00% | `NOT_DEMONSTRATED` |
| `classification` | `qwen2.5-coder:14b` | 20.00% | 3 | 12 | 12 | 0.00% | 20.00% | `NOT_DEMONSTRATED` |
| `file_selection` | `qwen2.5-coder:14b` | 20.00% | 3 | 12 | 12 | 0.00% | 20.00% | `NOT_DEMONSTRATED` |
| `error_clustering` | `qwen2.5-coder:14b` | 0.00% | 0 | 15 | 15 | 0.00% | 0.00% | `NOT_DEMONSTRATED` |
| `diff_summary` | `qwen2.5-coder:14b` | 0.00% | 0 | 15 | 15 | 0.00% | 0.00% | `NOT_DEMONSTRATED` |
| `structured_extraction` | `north-mini-code-1.0:q4_K_M` | 100.00% | 15 | 0 | 0 | 100.00% | 100.00% | `NOT_DEMONSTRATED` |
| `classification` | `north-mini-code-1.0:q4_K_M` | 33.33% | 5 | 10 | 10 | 0.00% | 33.33% | `NOT_DEMONSTRATED` |
| `file_selection` | `north-mini-code-1.0:q4_K_M` | 13.33% | 2 | 13 | 13 | 0.00% | 13.33% | `NOT_DEMONSTRATED` |
| `error_clustering` | `north-mini-code-1.0:q4_K_M` | 0.00% | 0 | 15 | 15 | 0.00% | 0.00% | `NOT_DEMONSTRATED` |
| `diff_summary` | `north-mini-code-1.0:q4_K_M` | 20.00% | 3 | 12 | 12 | 0.00% | 20.00% | `NOT_DEMONSTRATED` |
| `structured_extraction` | `devstral-small-2:24b-instruct-2512-q4_K_M` | 100.00% | 15 | 0 | 0 | 100.00% | 100.00% | `NOT_DEMONSTRATED` |
| `classification` | `devstral-small-2:24b-instruct-2512-q4_K_M` | 46.67% | 7 | 8 | 8 | 0.00% | 46.67% | `NOT_DEMONSTRATED` |
| `file_selection` | `devstral-small-2:24b-instruct-2512-q4_K_M` | 6.67% | 1 | 14 | 14 | 0.00% | 6.67% | `NOT_DEMONSTRATED` |
| `error_clustering` | `devstral-small-2:24b-instruct-2512-q4_K_M` | 0.00% | 0 | 15 | 15 | 0.00% | 0.00% | `NOT_DEMONSTRATED` |
| `diff_summary` | `devstral-small-2:24b-instruct-2512-q4_K_M` | 20.00% | 3 | 12 | 12 | 0.00% | 20.00% | `NOT_DEMONSTRATED` |

## Decisão por atividade

| Atividade | Vencedor | Verificador | Vantagem operacional | Modo |
|---|---|---|---|---|
| `structured_extraction` | `NO_WINNER` | `null` | `NOT_DEMONSTRATED` | `shadow` |
| `classification` | `NO_WINNER` | `null` | `NOT_DEMONSTRATED` | `disabled` |
| `file_selection` | `NO_WINNER` | `null` | `NOT_DEMONSTRATED` | `shadow` |
| `error_clustering` | `NO_WINNER` | `null` | `NOT_DEMONSTRATED` | `shadow` |
| `diff_summary` | `NO_WINNER` | `null` | `NOT_DEMONSTRATED` | `disabled` |

Latência foi medida, mas `latency_is_promotion_gate=false`. Nenhuma saída de thinking foi persistida.
