# Bake-off quality-first de modelos locais — 2026-08-25

## Veredito

Nenhum candidato demonstrou vantagem operacional suficiente para promoção em
produção. As cinco atividades permanecem com a política anterior e com
`production_enabled=false`:

| Atividade | Resultado | Modo preservado | Motivo dominante |
|---|---|---|---|
| `structured_extraction` | `NO_WINNER` | `shadow` | os três modelos fizeram 15/15; nenhum candidato superou o baseline |
| `classification` | `NO_WINNER` | `disabled` | erros críticos, recall crítico zero, macro-F1 e useful rate insuficientes |
| `file_selection` | `NO_WINNER` | `shadow` | omissões críticas e useful rate insuficiente |
| `error_clustering` | `NO_WINNER` | `shadow` | nenhum caso útil e root cause não preservada |
| `diff_summary` | `NO_WINNER` | `disabled` | 12/15 casos críticos em cada challenger |

`summarize-log` não participou deste bake-off. Sua promoção e seu benchmark
permanecem separados e inalterados.

## Estado inicial e hardware

- Repositório `my_smart_home`, branch `main`, `HEAD` inicial
  `602922b3680b2566a027f9a661f098e2737c2ddc`, sem divergência de `origin/main`.
- Ollama remoto `0.32.1`; a CLI não está instalada no host ARM do Home
  Assistant.
- GPU RTX 4070 com 12.282 MiB de VRAM.
- WSL com cerca de 31,2 GiB de RAM e 8 GiB de swap; havia mais de 949 GB livres
  no volume de modelos.
- O host Home Assistant iniciou com 2,8 GiB disponíveis e filesystem em 66%,
  sempre acima dos pisos de segurança. Home Assistant, Node-RED e MQTT
  permaneceram disponíveis.
- O baseline foi descarregado antes do primeiro pull. Todos os modelos foram
  descarregados entre etapas e nenhum ficou carregado no encerramento.

## Candidatos e exclusões

| Chave | Tag | Resultado técnico |
|---|---|---|
| `current_baseline` | `qwen2.5-coder:14b` | executado; Q4_K_M; digest `9ec8897f…16849` |
| `north_mini_code_1_0` | `north-mini-code-1.0:q4_K_M` | executado; Q4_K_M; digest `d8b269ad…0b60f` |
| `devstral_small_2_24b` | `devstral-small-2:24b-instruct-2512-q4_K_M` | executado; Q4_K_M; digest `24277f07…63c8` |
| `qwen3_8_27b` | `qwen3.8:27b` | `NOT_RUN_RUNTIME_INCOMPATIBLE`; o pull exigiu Ollama mais novo e nenhuma atualização/reinicialização foi feita |
| `qwen3_coder_next_optional` | `qwen3-coder-next:q4_K_M` | `NOT_RUN_RESOURCE_CONSTRAINT`; a tag oficial de 52 GB não cabe com margem segura em RAM+swap |

As páginas oficiais usadas para confirmar tags/capacidades foram
[Qwen3.8](https://ollama.com/library/qwen3.8),
[North Mini Code](https://ollama.com/library/north-mini-code-1.0),
[Devstral Small 2](https://ollama.com/library/devstral-small-2/tags) e
[Qwen3 Coder Next](https://ollama.com/library/qwen3-coder-next/tags).

## Dataset, oracles e separação metodológica

O conjunto residual v3 contém 100 casos públicos sintéticos, 20 por atividade:

- 25 casos de calibração e 75 de promotion holdout, congelados antes da
  primeira inferência;
- 20 casos com prompt injection e 20 casos predefinidos para repetição de
  estabilidade;
- estados residuais exclusivamente `UNSUPPORTED`, `AMBIGUOUS` ou
  `NEEDS_SEMANTIC_REVIEW`;
- schemas e validadores por atividade, separados das saídas dos modelos;
- oracles objetivos para extração, clustering e diff; evidência apenas
  parcialmente independente para classificação e seleção de arquivos;
- nenhuma evidência registrada de autoria humana independente ou revisão
  manual externa.

Por isso, os resultados não são apresentados como acurácia externa
independente. Os 100 casos antigos foram executados integralmente para cada
modelo, mas continuam sendo apenas regressão contra fixtures com
`INSUFFICIENT_EVIDENCE` de independência.

Hashes congelados:

| Objeto | SHA-256 |
|---|---|
| dataset | `d604f86ffcca132abea87cdd7694ad018097a1fd9fd0877bba95782d67a78711` |
| inputs | `5ddcda5c4ce460faf882efe71ed6054e1ec6c02d3ed2f2a9ec134b5e8bd6131a` |
| ground truth | `62a7d76c7f40cb0f8b547a1f157997b3be228d49bba98cde947e796c63d04ce5` |
| schemas | `658d88f79ac6f65884b3cf3a39a0d234008e561926e8204ecf438b2c3034ac7a` |
| oracle manifest | `005a8fff083f1824d4bd30e3192e1f871ae6eb48d3747b6d674fe183a2131b22` |

## Configuração congelada

Todos os modelos/atividades selecionaram o mesmo perfil após calibração:

```text
num_ctx=8192
num_predict=512
think=false
temperature=0
seed=20260825
timeout_seconds=900
keep_alive=10m
structured_output=JSON Schema
```

O hash canônico da configuração é
`1cf1dc02eb9ed0732311e4cd3b76bc77d4f3e457826c8c8f5bbe3273eae466be`.
O modo thinking foi comparado quando disponível, mas não venceu a calibração.
Nenhum texto de thinking foi persistido nos artefatos públicos.

## Volume executado

| Fase | Inferências |
|---|---:|
| calibração: cinco casos × cinco atividades × variantes aplicáveis | 250 |
| regressão: 100 fixtures por modelo | 300 |
| promotion holdout: 75 casos + 20 repetições por modelo | 285 |
| verifier: dois candidatos por atividade, corpus controlado e erros naturais | 148 |
| **total** | **983** |

O journal privado é retomável por `journal_key`; o artefato público
`events.jsonl` contém os mesmos 983 checkpoints sem `output` nem `thinking`.

## Calibração

Pass@1 nos cinco casos de calibração por atividade:

| Modelo | Extração | Classificação | Arquivos | Clustering | Diff |
|---|---:|---:|---:|---:|---:|
| baseline | 100% | 40% | 20% | 0% | 0% |
| North | 100% | 40% | 20% | 0% | 20% |
| Devstral | 100% | 60% | 20% | 0% | 20% |

A calibração foi usada somente para congelar parâmetros. Nenhum threshold foi
ajustado depois de observar regressão, holdout ou verifier.

## Regressão das 100 fixtures antigas

Aceitação das fixtures por atividade, sempre 20 casos por célula:

| Modelo | Extração | Classificação | Arquivos | Clustering | Diff |
|---|---:|---:|---:|---:|---:|
| baseline | 50% | 0% | 35% | 80% | 20% |
| North | 35% | 0% | 35% | 60% | 0% |
| Devstral | 65% | 0% | 25% | 80% | 5% |

Esses números medem consistência com fixtures antigas sob o novo harness. Eles
não substituem o resultado determinístico 100/100 e não foram usados como
evidência de promoção.

## Primary no promotion holdout

| Atividade | Modelo | Pass@1 | Úteis | Fallback | Casos críticos | Consistência | p50 |
|---|---|---:|---:|---:|---:|---:|---:|
| extração | baseline | 100,00% | 15 | 0 | 0 | 100,00% | 1,517 s |
| extração | North | 100,00% | 15 | 0 | 0 | 100,00% | 4,218 s |
| extração | Devstral | 100,00% | 15 | 0 | 0 | 100,00% | 17,441 s |
| classificação | baseline | 20,00% | 3 | 12 | 12 | 100,00% | 1,085 s |
| classificação | North | 33,33% | 5 | 10 | 10 | 75,00% | 3,591 s |
| classificação | Devstral | 46,67% | 7 | 8 | 8 | 100,00% | 11,508 s |
| arquivos | baseline | 20,00% | 3 | 12 | 12 | 100,00% | 1,281 s |
| arquivos | North | 13,33% | 2 | 13 | 13 | 100,00% | 10,358 s |
| arquivos | Devstral | 6,67% | 1 | 14 | 14 | 75,00% | 13,076 s |
| clustering | baseline | 0,00% | 0 | 15 | 15 | 100,00% | 1,828 s |
| clustering | North | 0,00% | 0 | 15 | 15 | 50,00% | 5,885 s |
| clustering | Devstral | 0,00% | 0 | 15 | 15 | 75,00% | 16,417 s |
| diff | baseline | 0,00% | 0 | 15 | 15 | 100,00% | 2,940 s |
| diff | North | 20,00% | 3 | 12 | 12 | 100,00% | 6,548 s |
| diff | Devstral | 20,00% | 3 | 12 | 12 | 100,00% | 25,941 s |

Os 15 casos de cada atividade são o primeiro passe do holdout; as quatro
repetições adicionais por atividade alimentam somente as métricas de
estabilidade. Uma resposta rejeitada vale zero economia e cai em GPT direto.

## Benchmark de verifier

O corpus de verifier contém cinco propostas corretas e cinco mutações
controladas por atividade. Quando disponíveis, acrescenta até dois erros
naturais por primary/atividade. `ABSTAIN` não conta como detecção; somente
`REJECT` válido conta.

| Atividade | Verifier | Casos | Falsos aceites críticos | Recall de erro | Falso rejeite | Erros naturais/recall | Aprovado isoladamente |
|---|---|---:|---:|---:|---:|---:|---|
| extração | baseline | 10 | 0 | 100,00% | 20,00% | 0/0,00% | não |
| extração | North | 10 | 0 | 100,00% | 0,00% | 0/0,00% | sim |
| classificação | Devstral | 16 | 3 | 72,73% | 0,00% | 6/66,67% | não |
| classificação | North | 16 | 1 | 90,91% | 40,00% | 6/100,00% | não |
| arquivos | baseline | 16 | 0 | 100,00% | 0,00% | 6/100,00% | sim |
| arquivos | North | 16 | 0 | 100,00% | 80,00% | 6/100,00% | não |
| clustering | baseline | 16 | 2 | 81,82% | 40,00% | 6/66,67% | não |
| clustering | Devstral | 16 | 2 | 81,82% | 0,00% | 6/66,67% | não |
| diff | North | 16 | 0 | 100,00% | 100,00% | 6/100,00% | não |
| diff | Devstral | 16 | 0 | 100,00% | 100,00% | 6/100,00% | não |

North em extração e baseline em seleção de arquivos passaram os gates isolados
de verifier, mas não foram ligados ao pipeline: não existe primary vencedor
nessas atividades, e extração não tinha erros naturais para demonstrar redução
de risco de um primary. Portanto, todas as decisões finais mantêm
`verifier_model=null` e `verifier_status=NOT_PROVEN`.

## Recursos e estabilidade técnica

| Modelo | Chamadas em todas as fases | VRAM máxima | RAM total usada no WSL | Swap usado | Potência máxima | CPU offload | Timeout/OOM |
|---|---:|---:|---:|---:|---:|---|---|
| baseline | 312 | 11.982 MiB | 10,16 GiB | 0,70 GiB | 200,25 W | não | 0/0 |
| North | 353 | 11.906 MiB | 10,27 GiB | 0,71 GiB | 198,35 W | sim | 0/0 |
| Devstral | 318 | 11.964 MiB | 10,32 GiB | 0,71 GiB | 199,12 W | sim | 0/0 |

RAM e swap são os totais observados no WSL durante a amostragem, não memória
incremental atribuível exclusivamente ao modelo. North e Devstral usaram
offload para CPU. Não houve OOM nem timeout, mas o custo de latência e a pressão
operacional foram muito maiores que no baseline. Latência foi medida e usada
somente como último desempate, nunca como substituta de qualidade.

## Roteamento implementado e rollback

O `model-registry.json` da release fixada de `local-ai-rtx` é o registro central. O helper
`model_registry.py` valida-o fail-closed e seleciona por atividade:

1. determinístico primeiro;
2. Local AI apenas quando restar residual e houver vencedor promovido;
3. no máximo uma tentativa primary por padrão;
4. verifier separado somente se aprovado;
5. validação determinística obrigatória;
6. qualquer ausência, divergência ou rejeição segue diretamente para
   `gpt-direct`;
7. sem recursão e sem cadeia de modelos locais.

A feature flag central é `LOCAL_AI_QUALITY_PIPELINE_ENABLED`. Com a flag falsa,
registro inválido ou `production_enabled=false`, o roteador nunca chama o
primary local. O rollback consiste em desabilitar essa única flag. Como não
houve vencedor, o registro preserva `shadow/disabled`, modelos/verifiers nulos e
produção desabilitada nas cinco atividades.

## Telemetria e dashboard

O bridge aceita os schemas históricos v1/v2 e o schema v3. O caminho default
agora lê `docs/benchmarks/local-ai-quality-bakeoff/latest.json` e expõe somente
inventário, dataset/hashes, 15 linhas de primary, dez de verifier e cinco
decisões. `benchmark_events`, perfis completos e respostas não são enviados ao
Home Assistant.

O card **Benchmark RTX — quality-first por atividade** mostra:

- base de medição e limitações do ground truth;
- primary por modelo/atividade;
- verifier e falsos aceites/rejeites;
- decisão e gates reprovados por atividade;
- modelos executados ou não executados;
- separação explícita de `summarize-log` e da telemetria operacional.

Todos os números renderizados no Markdown usam
`format_number_ptbr`; estados numéricos canônicos permanecem numéricos.

## Reprodução

Use um run id novo e execute sequencialmente no host protegido:

```bash
make benchmark-local-ai-quality-bakeoff-unit
make benchmark-local-ai-quality-bakeoff-calibration QUALITY_BAKEOFF_RUN_ID=<uuid>
make benchmark-local-ai-quality-bakeoff-regression QUALITY_BAKEOFF_RUN_ID=<uuid>
make benchmark-local-ai-quality-bakeoff-holdout QUALITY_BAKEOFF_RUN_ID=<uuid>
make benchmark-local-ai-quality-bakeoff-verifier QUALITY_BAKEOFF_RUN_ID=<uuid>
```

O target composto executa as mesmas etapas, sempre por
`scripts/run-resource-safe.sh`. Não execute outro benchmark, suíte ampla ou
instalação em paralelo. Antes da fase completa, verifique `uptime`, `free -h` e
`df -h /`.

## Artefatos

- `docs/benchmarks/local-ai-quality-bakeoff/latest.json`: relatório canônico;
- [`report.md`](benchmarks/local-ai-quality-bakeoff/report.md): relatório compacto gerado;
- `results.csv`: primary holdout em formato tabular;
- `events.jsonl`: 983 eventos públicos sanitizados;
- `promotion-decision.json`: decisão final por atividade;
- `residual-calibration-results.json`, `regression-results.json`,
  `residual-holdout-results.json`, `verifier-results.json`: fases sanitizadas;
- `frozen-config.json`: configuração congelada;
- `local-ai-research/benchmarks/quality-bakeoff-v1/`: dataset, inputs, schemas e
  oracle manifest versionados.

Run id canônico:
`9b798bb9-612e-4d98-96ca-dca47063c32e`.
