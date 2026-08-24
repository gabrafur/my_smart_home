# Benchmark RTX de atividades de alto potencial — revisão metodológica

- Data da inferência original: 24/08/2026
- Schema publicado: `local-ai-high-potential-v2`
- Execução original: `local-ai`, `qwen2.5-coder:14b`
Escopo: cinco classes além de `summarize-log`

Este relatório substitui semanticamente a versão v1. A evidência anterior foi
preservada no [diretório histórico v1](benchmarks/local-ai-high-potential/history/v1-2026-08-24/README.md).
A migração recalculou agregados a partir dos resultados por caso e dos eventos
v1; não reexecutou a RTX e não realizou chamadas ao GPT-5.6.

## 1. Veredito executivo revisado

Nas cinco atividades avaliadas além de `summarize-log`, a RTX demonstrou
capacidade de produzir saídas utilizáveis em alguns casos, mas não demonstrou
vantagem operacional incremental sobre o baseline determinístico.

Das 70 tarefas encaminhadas à IA local, 27 produziram saída aceita e selecionada
no benchmark, com redução validada de contexto estimado. Isso representa 38,57%
entre tentativas e cobertura end-to-end de 27,00% nos 100 casos. As outras 43
tentativas exigiram fallback. O fluxo realizou 86 inferências, pois os 16 casos
elegíveis de seleção de arquivos compararam o braço local-only com o híbrido.

Foram identificadas 32 ocorrências categóricas de erro crítico em 25 casos
únicos: 21 flags de omissão e 11 de alucinação, com ambas presentes em sete
casos. O campo v1 `critical_errors=25` era, na realidade, uma contagem de casos,
não de ocorrências.

A latência local acumulada foi 513,553 s, com p50 de 5,184 s e p95 de 28,774 s.
O braço determinístico foi aceito pelas fixtures em 100/100 casos, com score
1,00 e p50 armazenada como 0,000 s. Esse resultado é de consistência com o ground
truth atual; sua independência metodológica não foi comprovada.

A redução de 37,35% representa contexto GPT estimado no cenário simulado. Não
representa economia financeira, tokens cobrados nem redução medida em chamadas
reais ao GPT-5.6. Nenhuma atividade foi promovida para produção.

## 2. Metodologia, componentes e bases de medição

### Componentes e nomes reais

| Classe | Atividades reais | Implementação avaliada | Produção |
| --- | --- | --- | --- |
| Extração estruturada | `extract-errors`, `extract-diff-symbols`, `extract-commands`, `extract-metrics`, `extract-components`, `extract-telemetry` | `high_potential_benchmark.py::deterministic_extract`, `local_prompt` | não habilitada |
| Classificação | `classify-task`, `classify-diff` | `high_potential_benchmark.py::deterministic_classify`, `local_prompt` | não habilitada |
| Seleção de arquivos | `triage-files`, `select-context`; alias existente `inspect-files` | `deterministic_file_selection`, `hybrid_file_source`; `local-ai.py::response_format` | não habilitada |
| Agrupamento de erros | `cluster-errors`, `deduplicate-errors`; alias existente `classify-error` | `deterministic_cluster`; `local-ai.py::response_format` | não habilitada |
| Resumo factual de diff | `summarize-diff`; alias existente `review-diff` | `deterministic_diff`; `local-ai.py::response_format` | não habilitada |

`summarize-log` não entra em nenhum denominador deste benchmark e conserva sua
avaliação separada.

### Fluxo de dados e fontes de verdade

```text
dataset.jsonl + inputs.json
  → expected_output do dataset
  → deterministic_output / run_local
  → evaluate_output + schema por caso
  → aggregate + reconcile_inference_events
  → latest.json / CSV / events.jsonl / report.md
  → sanitizeHighPotentialBenchmark
  → sensor.codex_benchmark_rtx_alto_potencial
  → painel uso-rtx
  → este relatório
```

O dataset é a fonte dos casos e do ground truth. Resultados por caso e eventos
são a evidência das inferências. `aggregate` é a fonte das métricas; a
reconciliação conta um `job_id` uma única vez e acusa conflitos de identidade.
O `latest.json` v2 é a fonte publicada. Bridge, sensor e painel apenas sanitizam,
transportam e apresentam esse subconjunto; não recalculam qualidade.

### Classificação da evidência

- **MEDIDO:** inferências locais da execução v1, tokens Ollama, duração local e
  amostras de GPU/VRAM/potência.
- **ESTIMADO:** tokens de contexto GPT por `ceil(bytes UTF-8 / 4)`.
- **SIMULADO:** cenários GPT direto e GPT após roteamento; o GPT-5.6 não foi
  chamado.
- **NÃO TESTADO:** qualidade final, latência, cobrança e tokens reais do GPT-5.6.
- **RECALCULADO:** nomes, denominadores, hashes e agregados v2 derivados da
  evidência v1, sem nova inferência.

Nomenclatura principal v2:

| Nome v1 | Nome principal v2 | Observação |
| --- | --- | --- |
| `avoided_gpt_tokens` | `estimated_avoided_gpt_tokens` | estimativa, não tokens medidos no GPT |
| `token_savings_ratio` | `estimated_gpt_context_reduction_ratio` | cenário GPT simulado |
| `weighted_token_savings` | `estimated_weighted_gpt_context_reduction` | pondera pela soma de tokens |
| `useful_rtx_rate` | `useful_rtx_rate_among_attempts` | denominador RTX tentada |
| inexistente | `end_to_end_useful_coverage` | denominador de todos os casos |
| `critical_errors` | `cases_with_critical_error` | o v1 contava casos, não ocorrências |

Os nomes v1 sobrevivem apenas dentro de `legacy_metric_aliases`, marcado
`deprecated=true`; CSV, bridge e painel usam os nomes v2.

### Proveniência e independência do ground truth

Classificação: `INSUFFICIENT_EVIDENCE` para as cinco classes.

Evidência concreta:

- `expected_output` é construído pelas fixtures de
  `high_potential_dataset.py::build_dataset`; o gerador não chama as funções
  `deterministic_*` avaliadas;
- o harness carrega os arquivos antes de executar qualquer braço e o ground
  truth atual está congelado pelo hash
  `d7ea4ea564276c9df93c886401f75d873853bf7e3ba95da5bc1fa6d2f35751fa`;
- gerador, dataset e implementação determinística foram introduzidos juntos no
  commit `be11ce933f126ce5a11a759be21ba52ca9851ef3`, posterior ao timestamp interno
  da execução v1;
- não existe evidência versionada de data de autoria, protocolo de anotação,
  revisor manual ou autoria independente;
- `manual_review_evidence` e `independent_authorship_evidence` permanecem `null`.

Assim, é possível afirmar que as fixtures existiam e eram carregadas antes das
inferências, mas não que foram criadas ou revisadas independentemente do braço
determinístico. O resultado 100/100 não pode ser apresentado como comparação de
qualidade independente.

## 3. Denominadores globais e por atividade

| Escopo | Casos totais | Elegíveis | Tentativas RTX | Inferências | Aceitas/úteis | Useful rate/tentativas | Cobertura end-to-end | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Global | 100 | 70 | 70 | 86 | 27 | 38,57% | 27,00% | 43 |
| Extração | 20 | 16 | 16 | 16 | 9 | 56,25% | 45,00% | 7 |
| Classificação | 20 | 14 | 14 | 14 | 0 | 0,00% | 0,00% | 14 |
| Seleção de arquivos | 20 | 16 | 16 | 32 | 6 | 37,50% | 30,00% | 10 |
| Agrupamento de erros | 20 | 16 | 16 | 16 | 12 | 75,00% | 60,00% | 4 |
| Resumo factual de diff | 20 | 8 | 8 | 8 | 0 | 0,00% | 0,00% | 8 |

Fórmulas publicadas:

```text
useful_rtx_rate_among_attempts = 27 / 70 = 38,57%
end_to_end_useful_coverage = 27 / 100 = 27,00%
class_eligibility_rate = 70 / 100 = 70,00%
fallback_rate_among_attempts = 43 / 70 = 61,43%
inferences_per_attempted_case = 86 / 70 = 1,2286
```

Os 30 casos não elegíveis continuam no denominador end-to-end e contribuem zero
para a cobertura útil. Uma saída aceita conta como útil somente quando foi
selecionada pelo benchmark, reduziu o contexto estimado e não acionou fallback.

Contexto do cenário simulado:

| Métrica | Valor | Base |
| --- | ---: | --- |
| Contexto GPT direto | 237.627 tokens | ESTIMADO/SIMULADO |
| Contexto GPT roteado | 148.879 tokens | ESTIMADO/SIMULADO |
| Tokens GPT potencialmente evitados | 88.748 tokens | ESTIMADO |
| Redução estimada ponderada por tokens | 37,35% | ESTIMADO/SIMULADO |
| Redução estimada ponderada por frequência | 34,61% | ESTIMADO/SIMULADO |

A redução global é `soma(baseline) - soma(roteado)` dividida pela soma do
baseline; não é uma média simples de percentuais por tarefa.

## 4. Erros críticos

| Métrica | Valor | Denominador/escopo |
| --- | ---: | --- |
| Ocorrências categóricas críticas | 32 | 21 omissões + 11 alucinações |
| Casos com ao menos um erro crítico | 25 | 25/70 tentativas = 35,71% |
| Ocorrências por inferência | 0,3721 | 32/86 inferências |
| Inferências individuais com erro | indisponível | v1 não reteve validação do braço local-only |
| Saídas rejeitadas/partial/invalid | 43 | 43/70 tentativas = 61,43% |

Uma ocorrência é uma categoria de violação (`critical_omission` ou
`critical_hallucination`). Um caso pode conter duas ocorrências. Uma inferência
é uma chamada local identificada por `job_id`. Um caso híbrido pode conter duas
inferências, mas continua sendo uma tarefa. Rejeição e fallback são resultados
do caso selecionado, não novas ocorrências.

Entre os 43 fallbacks, 25 resultados foram rejeitados com flags críticas, 12
foram `partial` e seis foram `invalid` por JSON/schema. Os seis inválidos não
possuem flags semânticas recuperáveis no v1; não foram reclassificados
retroativamente como omissões.

## 5. Comparação com o melhor baseline

O braço determinístico produziu schema válido e passou o gate atual em 100/100,
teve recall crítico 1,00 e zero `unsupported`. O exact match estrito foi 40/100:
20 extrações e 20 resumos de diff. Classificação e seleção adicionam
`confidence`; agrupamento usa IDs/rótulos de causa equivalentes pelo avaliador,
mas diferentes do JSON esperado. `accepted` não significa apenas JSON válido.

Esses números permanecem sujeitos a `INSUFFICIENT_EVIDENCE` para independência
do ground truth.

| Atividade | Qualidade RTX | Qualidade baseline | p50 RTX | p50 baseline | Fallback RTX | Vantagem operacional |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Extração | 0,9031 | 1,0000 | 5,721 s | 0,000 s | 43,75% | não |
| Classificação | 0,2143 | 1,0000 | 3,832 s | 0,000 s | 100,00% | não |
| Seleção de arquivos | 0,8726 | 1,0000 | 5,186 s | 0,000 s | 62,50% | não |
| Agrupamento de erros | 0,7500 | 1,0000 | 5,118 s | 0,000 s | 25,00% | não |
| Resumo factual de diff | 0,0000 | 1,0000 | 28,740 s | 0,000 s | 100,00% | não |

`rtx_operational_advantage` só pode ser verdadeiro quando qualidade RTX não é
inferior ao baseline, não há erro crítico, existe redução validada, p50 é no
máximo 10 s, fallback é no máximo 10%, o ground truth é comprovadamente
independente e existe benefício que o baseline não oferece. Nenhuma atividade
atendeu ao conjunto.

Resposta operacional: **não, a RTX não superou o melhor método disponível em
nenhuma das cinco atividades.**

## 6. Casos adversariais

Os guardrails detectaram e trataram corretamente os 20 cenários adversariais
simulados. Isso não significa que o modelo respondeu corretamente a 20 casos:
essa bateria executou guardrails determinísticos, não outputs do modelo.

```text
adversarial_scenarios_total = 20
adversarial_guardrails_passed = 20
adversarial_model_outputs_accepted = 0
adversarial_model_outputs_rejected = 0
```

## 7. Política operacional

Fluxo autorizado:

```text
método determinístico → validação → GPT direto se ambíguo, não suportado ou insuficiente
```

Não foi autorizado inserir a RTX como fallback intermediário. Shadow mode é
somente pesquisa: não altera a saída operacional e não contabiliza economia.

| Atividade | Decisão | Local AI | Produção | Fallback não resolvido |
| --- | --- | --- | --- | --- |
| `structured_extraction` | `DETERMINISTIC_FIRST` | `shadow` | desabilitada | `gpt-direct` |
| `classification` | `DETERMINISTIC_FIRST` | `disabled` | desabilitada | `gpt-direct` |
| `file_selection` | `DETERMINISTIC_FIRST` | `shadow` | desabilitada | `gpt-direct` |
| `error_clustering` | `DETERMINISTIC_FIRST` | `shadow` | desabilitada | `gpt-direct` |
| `diff_summary` | `DETERMINISTIC_FIRST` | `disabled` | desabilitada | `gpt-direct` |
| `summarize_log` | `SEPARATE_BENCHMARK` | fora deste benchmark | não alterada | fora deste benchmark |

## 8. Limitações

- Não houve chamadas reais ao GPT-5.6; tokens, contexto roteado e redução GPT
  são estimados e simulados.
- A independência do ground truth não foi comprovada.
- O v1 não armazenou outputs brutos locais, nem a validação completa das 16
  chamadas local-only. Não é possível contar inferências individuais com erro.
- Os casos inválidos sem output não permitem reconstrução de violações
  semânticas; ausência de flag não prova ausência de omissão.
- A p50 determinística 0,000 s reflete resolução/arredondamento do artefato, não
  latência literalmente nula.
- A recomputação não alterou dataset, inputs, prompts, modelo ou gate. Uma nova
  inferência só se justifica se esses elementos mudarem ou se um ground truth
  independente for criado.

## 9. Artefatos, schema e hashes

O schema subiu de v1 para v2 porque denominadores, proveniência, erros e bases de
medição mudaram de forma incompatível. O bridge mantém leitura do v1, preserva
campos desconhecidos como indisponíveis e não deriva casos críticos a partir de
ocorrências.

Artefatos v2:

- [relatório gerado v2](benchmarks/local-ai-high-potential/report.md);
- `docs/benchmarks/local-ai-high-potential/latest.json`;
- `cases.csv`, `activity-table.csv`, `classification-confusion-matrix.csv`;
- `events.jsonl`;
- schema `scripts/local-ai/benchmarks/high-potential/schemas/report-v2.json`.

Hashes do artefato recalculado são publicados em `artifact_hashes`. O dataset
permanece `321e9ee4aae5c6df2da714797b1c22bd711fd1cc1d90657dcdbc4cbe6c8872dc` e o
ground truth permanece
`d7ea4ea564276c9df93c886401f75d873853bf7e3ba95da5bc1fa6d2f35751fa`. O hash
de schemas da execução v1 é preservado separadamente do conjunto atual, que inclui
o novo schema do relatório. Hashes de prompt e configuração do modelo são
reconstruídos de função/constantes versionadas e recebem essa base explicitamente
em `artifact_hash_basis`; não são apresentados como campos que o v1 tenha medido.

```text
results_recomputed_from_existing_raw_artifacts = true
benchmark_rerun_reason = null
ground_truth_provenance.status = INSUFFICIENT_EVIDENCE
```
