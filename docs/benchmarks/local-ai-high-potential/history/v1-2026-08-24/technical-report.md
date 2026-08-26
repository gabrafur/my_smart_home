# Benchmark RTX de atividades de alto potencial — 2026-08-24

## 1. Veredito executivo

A RTX não deve ser promovida para nenhuma atividade avaliada além de
`summarize-log`. O `qwen2.5-coder:14b` produziu contexto utilizável em 27 das 70
tarefas tentadas (38,6%), mas 43 exigiram fallback e 25 tiveram omissão ou
alucinação crítica. O método determinístico passou 100/100 casos com latência
p50 abaixo de 1 ms. Todas as cinco classes recebem `DETERMINISTIC_FIRST`, com
Local AI desabilitada em produção.

Os 88.748 tokens estimados evitados representam somente resultados aceitos no
contrafactual. Não são economia operacional nem faturável: o GPT-5.6 não foi
chamado e a qualidade de sua resposta final não foi medida. `summarize-log` foi
excluído de todos os totais principais.

## 2. Atividades descobertas e testadas

O roteador reconhece `review-diff`, `inspect-files`, `classify-error`,
`analyze-tests`, `summarize-document`, `summarize-memory` e `summarize-log`.
Não havia implementações próprias para os outros nomes pedidos; elas foram
adicionadas somente ao harness.

| Nome pedido | Nome real | Implementação | Entrada/saída | Elegibilidade e validação | Fallback/telemetria |
| --- | --- | --- | --- | --- | --- |
| `extract-structured` | `benchmark:extract-structured` | `high_potential_benchmark.py::local_prompt` e `deterministic_extract` | teste, diff, comando, métrica, documento ou evento → um de seis schemas | benchmark 800–6.000 tokens; schema, F1, valores, nomes e caminhos | GPT direto; evento isolado; classe `structured_extraction` |
| `classify-task` | `benchmark:classify-task` | `local_prompt` e `deterministic_classify` | tarefa → labels, elegibilidade, revisão, abstention e confiança | somente benchmark; accuracy, macro-F1, rota crítica e falso positivo inseguro | GPT direto; classe `classification` |
| `classify-diff` | `benchmark:classify-diff` | mesma implementação | diff → mesmo schema | igual | igual |
| `triage-files` | `inspect-files` em produção; alias no benchmark | produção em `local-ai.py::response_format/run_analysis`; benchmark em `local_prompt` | tarefa/candidatos → arquivos, full-context e confiança | produção não benéfica; precision@k, recall@k, critical-file recall e MRR | GPT direto; classe `file_selection` |
| `select-context` | `inspect-files` em produção; alias no benchmark | mesma implementação | inventário → mesmo schema | igual | igual |
| `cluster-errors` | aproximação `classify-error`; cluster no benchmark | `local_prompt` e `deterministic_cluster` | registros/ruído → clusters, representante e causa | somente benchmark; pairwise F1, pureza, merge/split e causa | GPT direto; classe `error_clustering` |
| `deduplicate-errors` | aproximação `classify-error`; dedupe no benchmark | mesma implementação | mesmos registros → mesmo schema | igual | igual |
| `summarize-diff` | `review-diff` em produção; resumo factual no benchmark | produção em `local-ai.py::response_format/run_analysis`; benchmark em `local_prompt` | diff → `observed`, `inferred`, `unknown` | produção não benéfica; schema, precisão, fatos críticos e evidência extrativa | GPT direto; classe `diff_summary` |

O modelo de todas as inferências foi `qwen2.5-coder:14b`. Todos os eventos
contêm `execution_mode: benchmark`, `benchmark_run_id` e
`excluded_from_production_metrics: true`. O bridge lê apenas o agregado
sanitizado; respostas e entradas não são persistidas.

## 3. Dataset

- 100 casos, 20 por classe.
- 70 reais anonimizados/derivados de caminhos, símbolos, contratos e formatos
  públicos do repositório; 30 sintéticos determinísticos.
- 60 casos de calibração e 40 de holdout.
- 30 casos pequenos ou não elegíveis permaneceram no denominador global.
- Pesos de frequência: extração 1,20; classificação 1,40; seleção 1,10; erros
  0,80; diff 1,00. Casos pequenos recebem metade do peso.

O dataset está em
[`local-ai-research/benchmarks/high-potential/`](../../../../../local-ai-research/benchmarks/high-potential/README.md)
e é reproduzido por `python3 scripts/local-ai/high_potential_dataset.py --check`.

## 4. Resultados globais

| Métrica | Resultado | Base |
| --- | ---: | --- |
| Tarefas avaliadas / elegíveis | 100 / 70 | harness/regra determinística |
| Inferências locais | 86 | medida; inclui 16 braços local-only |
| Saídas aceitas / rejeitadas | 27 / 43 | schema e ground truth |
| Fallbacks / useful RTX rate | 43 / 38,6% | medido |
| Tokens baseline / roteados / evitados | 237.627 / 148.879 / 88.748 | estimados por bytes/4 |
| Economia por tokens / frequência | 37,3% / 34,6% | soma e pesos declarados |
| Economia no estrato elegível | 38,2% | estimada |
| Latência p50 / p95 | 5,184 s / 28,774 s | medida |
| Delta acumulado / tokens por segundo adicional | 513,553 s / 172,812 | medido/estimado |
| Erros críticos | 25 | ground truth determinístico |
| GPU observada | 86/86 inferências | sampler remoto |
| Pico GPU / VRAM / potência | 100% / 11.768 MiB / 185,45 W | medido |

Calibração: 39 tentativas, 16 aceites, 13 erros críticos e 52.937 tokens
estimados evitados. Holdout: 31 tentativas, 11 aceites, 12 erros críticos e
35.811 tokens estimados evitados. Nenhum prompt ou threshold foi alterado entre
os conjuntos.

## 5. Resultados por atividade

| Atividade | Casos | Qualidade | Useful RTX | Economia | Fallback | p50/p95 | Decisão |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Extração estruturada | 20 | 90,3% | 56,2% | 57,7% | 43,8% | 5,721/9,796 s | `DETERMINISTIC_FIRST` |
| Classificação | 20 | 21,4% | 0,0% | 0,0% | 100,0% | 3,832/8,561 s | `DETERMINISTIC_FIRST` |
| Seleção de arquivos | 20 | 87,3% | 37,5% | 44,9% | 62,5% | 5,186/7,423 s | `DETERMINISTIC_FIRST` |
| Agrupamento de erros | 20 | 75,0% | 75,0% | 68,5% | 25,0% | 5,118/7,167 s | `DETERMINISTIC_FIRST` |
| Resumo factual de diff | 20 | 0,0% | 0,0% | 0,0% | 100,0% | 28,740/30,868 s | `DETERMINISTIC_FIRST` |

Métricas críticas:

- Extração: schema 100%, recall crítico 81,2%, F1 90,3%, preservação numérica
  100%, sete campos inventados e três omitidos.
- Classificação: accuracy 0%, macro-F1 18,2%, recall de rota crítica 85,7%,
  quatro falsos positivos e quatro falsos negativos de elegibilidade.
- Seleção: precision@k 100%, recall@k/critical-file recall 79,2%, MRR 1,0 e
  12 arquivos críticos omitidos. O híbrido elevou aceite de 12,5% para 37,5%,
  ainda abaixo do threshold.
- Erros: pairwise F1 75,0%, pureza 93,8%, quatro falsos merges críticos e
  preservação de causa de 83,3%.
- Diffs: schema 25%, precisão factual/recall crítico 0%; seis respostas foram
  JSON inválido.

## 6. Comparação determinística

O cenário determinístico atingiu 100/100 ground truths, score médio 1,0 e p50
abaixo de 1 ms. Parsers/regex foram superiores na extração; regras estáticas na
classificação; busca/mapeamento de contratos na seleção; normalização/assinatura
no agrupamento; e `git diff` mais regras observáveis no resumo.

O reranking híbrido melhorou seleção, mas não eliminou omissões críticas. Pode
permanecer somente como experimento offline sobre candidatos já seguros.

## 7. Erros e inconsistências

- 25 casos com omissão ou alucinação crítica.
- Sete invenções e três omissões de campo na extração.
- Oito classificações erradas de elegibilidade e macro-F1 de 18,2%.
- 12 omissões de arquivos críticos e quatro merges de causas diferentes.
- Seis respostas de diff com JSON inválido e nenhum resumo factual aceito.
- 37 candidatos reduziram tokens, mas foram rejeitados por qualidade; todos
  contabilizaram economia útil zero.
- Nenhuma ausência de sampler virou zero; as 86 inferências reais foram
  `observed`.
- Os 20 cenários adversariais passaram como simulações de guardrail.

## 8. Configuração recomendada

```yaml
activities:
  - activity: extract-structured
    decision: DETERMINISTIC_FIRST
    model: qwen2.5-coder:14b
    minimum_input_tokens: 800
    maximum_input_tokens: 6000
    confidence_threshold: 0.90
    required_validation: true
    fallback: gpt-direct
    production_enabled: false
    reason: parser perfeito; RTX omitiu e inventou campos críticos
  - activity: classify-task-and-diff
    decision: DETERMINISTIC_FIRST
    model: qwen2.5-coder:14b
    minimum_input_tokens: 800
    maximum_input_tokens: 6000
    confidence_threshold: 0.90
    required_validation: true
    fallback: gpt-direct
    production_enabled: false
    reason: macro-F1 0,182 e zero saídas aproveitadas
  - activity: triage-files-and-select-context
    decision: DETERMINISTIC_FIRST
    model: qwen2.5-coder:14b
    minimum_input_tokens: 800
    maximum_input_tokens: 6000
    confidence_threshold: 0.90
    required_validation: true
    fallback: gpt-direct
    production_enabled: false
    reason: 12 arquivos críticos omitidos; híbrido falhou em 62,5%
  - activity: cluster-and-deduplicate-errors
    decision: DETERMINISTIC_FIRST
    model: qwen2.5-coder:14b
    minimum_input_tokens: 800
    maximum_input_tokens: 6000
    confidence_threshold: 0.90
    required_validation: true
    fallback: gpt-direct
    production_enabled: false
    reason: quatro falsos merges; assinatura determinística perfeita
  - activity: summarize-diff
    decision: DETERMINISTIC_FIRST
    model: qwen2.5-coder:14b
    minimum_input_tokens: 800
    maximum_input_tokens: 6000
    confidence_threshold: 0.95
    required_validation: true
    fallback: gpt-direct
    production_enabled: false
    reason: zero saídas úteis, schema 25% e p95 de 30,868 s
```

## 9. Alterações realizadas

- Harness, gerador, fixtures, schemas, validadores, testes e artefatos em
  `scripts/local-ai/` e `docs/benchmarks/local-ai-high-potential/`.
- Alvos Make separados para unit, integration, simulated, local-ai e dashboard.
- Bridge expõe somente o resumo sanitizado, separado da telemetria operacional.
- Sensor `sensor.codex_benchmark_rtx_alto_potencial` e card na view `uso-rtx`,
  com base measured/estimated/simulated/insufficient_sample e números pt-BR.

## 10. Validações reproduzíveis

```bash
make benchmark-local-ai-high-potential-unit
make benchmark-local-ai-high-potential-integration
make benchmark-local-ai-high-potential-simulated
make benchmark-local-ai-high-potential-dashboard
make benchmark-local-ai-high-potential-local-ai
```

`make benchmark-local-ai-high-potential` executa os cinco estágios
sequencialmente, com `run-resource-safe.sh` e preflight antes da bateria real.

## 11. Limitações

- Medido: inferência RTX, tokens Ollama, latência, GPU/VRAM/potência, schemas e
  métricas contra ground truth.
- Estimado: tokens GPT por bytes/4 e deltas.
- Simulado: braço GPT direto, indisponibilidade, timeout, retry, sampler ausente
  e duplicidade de `job_id`.
- Não testado: chamada/qualidade final do GPT-5.6, custo monetário real, tráfego
  operacional e modelos locais alternativos.

Os pesos são declarados e não vêm de conversas privadas. O resultado autoriza
manter os perfis desabilitados, não provar impossibilidade futura.

## 12. Artefatos

- [Relatório Markdown](report.md)
- [Resultado JSON](latest.json)
- [CSV por caso](cases.csv)
- [Matriz de confusão](classification-confusion-matrix.csv)
- [Tabela por atividade](activity-table.csv)
- [Eventos de benchmark](events.jsonl)

O JSON contém os hashes e o `benchmark_run_id`
`7cfc9f52-17f3-4eb7-94ce-4faf0a9fba9b`. Nenhum prompt, entrada ou resposta
local foi persistido nos artefatos de resultados.
