# Pivot restrito do Local AI — 25/08/2026

## Veredito

O pivot interrompe a busca ampla por LLMs generativos maiores e mantém a RTX
somente onde houve evidência específica:

| Linha | Decisão | Política resultante |
| --- | --- | --- |
| Extração estruturada residual | `PROMOTE_TO_CANARY` | capacidade de canário a 10%, desligada por padrão e com fallback GPT direto |
| `summarize-log` | `DETERMINISTIC_ONLY` | fatos determinísticos; sem resumo generativo operacional |
| Retrieval/reranking | `NOT_DEMONSTRATED` | busca determinística; sem índice vetorial operacional |
| Similaridade de erros | `SKIPPED` | assinatura exata; nenhuma sugestão semântica ou auto-merge |
| Expansão geral | `CONTINUE_RESTRICTED` | continuar apenas o canário de extração e casos futuros com gate prévio |

O run canônico é `fe45c7b8-e653-4b8b-bc31-886e3966a9c9`. O agregado sanitizado
fica em `docs/benchmarks/local-ai-restricted-pivot/latest.json`; os quatro
subdiretórios preservam dataset manifest, configuração congelada, resultados
JSON/CSV, eventos sanitizados, schema, decisão e relatório. Benchmark e shadow
declaram economia operacional igual a zero.

## Estado inicial e proteção do host

O trabalho começou na branch `main`, em
`661f631cd4451d67023b138c34b77ed3899c9b10`, sem divergência do remoto. A única
mudança concorrente era `nodered/flows.json`; ela foi mantida fora deste escopo.
Não havia modelo carregado. Ollama 0.32.1 estava acessível, o filesystem raiz
estava em 46%, havia aproximadamente 2,8 GiB de RAM disponível e o swap local
estava zerado. Home Assistant, Node-RED e MQTT estavam saudáveis. As suítes
iniciais passaram com 138 testes do helper, 25 do bridge e 13 do layout RTX.

Os modelos relevantes já instalados incluíam `qwen2.5-coder:14b`,
`nomic-embed-text:latest` e os modelos históricos North Mini Code e Devstral
Small 2. Estes dois últimos não foram reexecutados. Qwen3.8 não foi instalado ou
testado, Ollama não foi atualizado, e não houve fine-tuning nem download de
pesos.

As cargas foram sequenciais e passaram pelo wrapper de recursos do repositório.
Na primeira implementação do corpus de retrieval, o benchmark reteve snapshots
demais e fez lookup quadrático de blobs. A carga subiu, a RAM disponível caiu
para aproximadamente 232 MiB e a sonda do Node-RED ficou temporariamente
inconclusiva. Somente os processos do benchmark foram encerrados; nenhum
serviço ou host foi reiniciado. Node-RED se recuperou sozinho. O corpus foi
alterado para lookup O(n), batches de 10 casos e liberação por lote antes da
execução canônica. Esse incidente é limitação do primeiro harness, não evidência
de qualidade a favor ou contra embeddings.

## Arquitetura encontrada e arquitetura resultante

Antes do pivot, `local-ai.py` concentrava o cliente Ollama, prompts, schemas,
gates, telemetria e fallback. `routing.py` decidia elegibilidade por perfil;
`quality_bakeoff.py` e `model-registry.json` mantinham as atividades do bake-off
quality-first. `post_tool_routing.py` podia encaminhar logs grandes ao perfil
generativo promovido. `ia-bridge/usage.js`, o package
`homeassistant/packages/codex_usage.yaml` e o dashboard `chat.yaml` expunham
telemetria operacional e o benchmark anterior separadamente.

Fluxos anteriores relevantes:

```text
structured_extraction
entrada -> seleção de atividade -> modelo local em shadow -> gate -> GPT direto

summarize-log
log -> filtro de sinais -> modelo local -> gate extrativo -> contexto ou bruto

file_selection
candidatos -> modelo generativo livre -> paths validados -> GPT principal
```

Fluxos vigentes:

```text
structured_extraction
entrada -> parser determinístico -> residual -> bucket de canário habilitado
-> qwen2.5-coder:14b com JSON Schema -> validação campo a campo contra a fonte
-> aceite ou GPT direto

summarize-log
log bruto -> normalização -> fatos e snippets críticos determinísticos
-> validação de cobertura/redução -> contexto factual ou log bruto -> GPT principal

retrieval
consulta -> candidatos determinísticos -> GPT principal

benchmark de retrieval, somente offline
snapshot Git -> chunks em memória -> lexical / embedding / híbrido -> top-k real
-> métricas -> descarte dos vetores temporários
```

`restricted_runtime.py` implementa o parser-first, o validador source-anchored e
o canário. `log_facts.py` implementa a saída determinística de logs.
`pivot_dataset.py` e `pivot_benchmark.py` constroem/verificam datasets e
artefatos. `pivot_finalize.py` gera o agregado. A configuração fail-closed fica
em `model-registry.json`; o rollback não exige revert de commit.

## Fase A — extração estruturada residual

Foram criados 25 casos de calibração e 100 de promotion holdout, todos novos e
classificados pelo parser determinístico como `UNSUPPORTED` ou `AMBIGUOUS`. O
holdout contém 20 casos de cada subtipo: teste/build, diff/mudança estruturada,
configuração/documentação, evento/telemetria e comando/ferramenta. Os oráculos
vieram de JSON, schemas, campos, códigos, números e caminhos presentes na fonte;
a independência é `VERIFIED_INDEPENDENT`.

Configuração congelada: `qwen2.5-coder:14b`, digest
`9ec8897f747e246e970bc5cfdda85d22f1123dc2e3d34978a010a75968716849`,
`num_ctx=8192`, `num_predict=512`, `think=false`, `temperature=0`,
`seed=20260825`, timeout de 900 segundos e JSON Schema nativo. O runtime aceitou
esses parâmetros. Produção permaneceu desabilitada.

Hashes principais:

- dataset: `c083ced21b4828465f625864ba627fd48a6442f3025c826569e91881dc1fbaeb`;
- schema: `eb0ac088e592535351d98abcce2af598ec17110baacf0b94f7fe810ddb929333`;
- prompt: `89fc93681533c0a4c7500c211fe7ea1150b6eab827174882e94880f3e2119d88`;
- implementação avaliada: `ff297f451cab0e3a2bbdc4006d5b20ebb71eb9b94c3fbdc3fdbf818156478368`.

No holdout, 100/100 saídas foram aceitas e úteis: schema, recall crítico e
preservação numérica de 100%; zero campos críticos inventados, omissões,
fallbacks, erros críticos, falhas técnicas, timeouts ou OOM. A mediana foi
2,4585 s, com pico de 11.977 MiB de VRAM, 96% de GPU e 199,56 W; não houve CPU
offload. Todos os gates congelados passaram. A decisão é
`PROMOTE_TO_CANARY`, com estado `OFFLINE_GATE_PASSED_CANARY_NOT_RUN`.

O canário exige as flags global e independente, usa bucket SHA estável abaixo
de 10%, mantém o parser primeiro e aceita somente campos presentes na fonte.
Schema inválido, omissão, número alterado, path inventado, campo proibido,
flag desligada ou bucket fora do rollout retornam a GPT direto. A capacidade
permanece desligada por padrão no repositório.

## Ativação operacional controlada

Em 2026-08-25, um override privado ativou somente a extração estruturada em
10%. A rota operacional foi publicada como o tool MCP
`local_ai_structured_extract`, com assignment
`structured-extraction-canary-v1`, validação fail-closed e breaker persistente.
Resumo generativo de logs, retrieval, reranker, similaridade de erros,
classificação e resumo de diff permaneceram desligados. Vinte e uma sondas
passaram, incluindo inferência medida na RTX, rollback e estabilidade após
retry/restart; todas usam `execution_mode=canary_probe` e são excluídas da
amostra real. O audit encontrou zero violações, mas também zero tentativas de
produção. Portanto, o estado inicial observado é
`CANARY_ACTIVE_INSUFFICIENT_OPERATIONAL_SAMPLE`, sem autorização para elevar o
rollout. Os artefatos agregados e sanitizados estão em
[`benchmarks/local-ai-structured-extraction-canary/`](benchmarks/local-ai-structured-extraction-canary/README.md).

## Fase B — `summarize-log`

O dataset novo tem 30 casos de calibração e 90 de holdout em 12 classes
sanitizadas: pytest, Node, Home Assistant, Docker Compose, Git, YAML, scanner de
segurança, privacidade, build/OOM, shell/timeout, stack truncada e múltiplas
falhas. Os oráculos de comando, exit code, contagens, caminhos, linhas, warnings,
timeouts e causas observadas são independentes do modelo.

No holdout:

| Braço | Recall crítico | Claims não suportadas | Contexto estimado | Redução estimada |
| --- | ---: | ---: | ---: | ---: |
| Log bruto | 100% | 0 | 109.260 tokens | 0% |
| Fatos determinísticos | 100% | 0 | 12.205 tokens | 88,83% |
| Fatos + resumo local validado | 100% | 0 | 18.292 tokens | 83,26% |

Os dois braços condensados preservaram números e fatos críticos, sem erro,
omissão ou fallback. Porém, a saída local ficou 49,87% maior que a determinística,
falhando o gate congelado de pelo menos 15% de redução incremental. O benchmark
mediu 1.010,192 s de inferência, 100% de GPU, 11.894 MiB de VRAM e 199,77 W, sem
offload, timeout ou OOM. Um teste de equivalência cobre os 120 fixtures e exige
que `log_facts.py`, usado no runtime, produza exatamente o contrato determinístico
medido; o holdout reproduz os mesmos 12.205 tokens estimados. A decisão é
`DETERMINISTIC_ONLY`.

## Fase C — retrieval e reranking

O dataset Git-derived tem 30 casos de calibração e 150 de holdout; todos os 180
usam o snapshot anterior ao commit, passaram o detector de leakage e são
`SNAPSHOT_CONSISTENT`. Queries removem paths e símbolos que entregariam a
resposta. Critical files foram classificados pela necessidade contratual da
mudança; supporting files ajudam a tarefa, mas sua ausência não define o gate.

O corpus foi chunked por símbolo ou estrutura, com fallback de até 80 linhas,
overlap de 10 e 6.000 bytes. Os braços lexical, embedding e híbrido por RRF
usaram o mesmo corpus e avaliaram k=5, 10 e 20. Nenhum ranking pode criar path:
ele só ordena chunks reais do snapshot.

| Método | Recall crítico@10 | MRR@10 | nDCG@10 | Contexto@10 | `NEEDS_MORE_CONTEXT` |
| --- | ---: | ---: | ---: | ---: | ---: |
| Determinístico | 19,17% | 0,1181 | 0,1334 | 3.143,65 tokens | 90,00% |
| Embedding | 22,36% | 0,1583 | 0,1767 | 2.449,23 tokens | 84,67% |
| Híbrido | 25,56% | 0,1466 | 0,1896 | 2.969,41 tokens | 80,00% |
| Híbrido + reranker | não testado | não testado | não testado | não testado | não testado |

O híbrido melhorou ranking e alguns casos residuais, mas o gate exigia 100% de
recall crítico@10. Com 25,56%, a decisão obrigatória é `NOT_DEMONSTRATED`.
Houve zero paths inventados e zero casos de índice stale. Intervalos bootstrap
de 95% para MRR/nDCG estão no artefato. Não foi criado índice persistente nem
integração operacional.

O único embedding instalado e compatível foi `nomic-embed-text:latest`, digest
`0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`,
Apache-2.0, 137M F16, dimensão 768, no Ollama 0.32.1. Não havia challenger
compatível já instalado e o runtime não oferecia reranker; ambos ficaram
`NOT_TESTED`, sem download ou atualização. A execução final criou 1.509 vetores
novos em cache privado temporário, teve 72.950 cache hits e 54 batches. Foram
30,984 s, pico de 99% de GPU, 1.892 MiB de VRAM, 131,22 W, 1.969.483.776 bytes
de RAM remota e 759.681.024 bytes de swap remoto. O processador reportou 100%
GPU, sem offload, OOM ou timeout.

## Fase D — similaridade de erros

A condição congelada era executar somente se a Fase C resultasse em
`DEMONSTRATED`. Como o resultado foi `NOT_DEMONSTRATED`, a fase foi registrada
como `SKIPPED_NO_RETRIEVAL_ADVANTAGE`: zero casos, zero inferências e nenhuma
implementação operacional. `automatic_merge=false` é um invariante de schema e
de configuração. O fallback permanece assinatura exata determinística.

## Integração, rollback e observabilidade

As flags independentes são:

- `LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED`;
- `LOCAL_AI_SUMMARIZE_LOG_ENABLED`;
- `LOCAL_AI_RETRIEVAL_ENABLED`;
- `LOCAL_AI_RERANKER_ENABLED`;
- `LOCAL_AI_ERROR_SIMILARITY_ENABLED`.

Somente extração pode selecionar `LOCAL_PRIMARY_CANARY`, e ainda exige o master
switch existente. Logs retornam `DETERMINISTIC_LOG_FACTS`; retrieval e reranker
retornam ranking determinístico; similaridade retorna assinatura exata. Cada
flag desligada ou atividade não aprovada chega ao mesmo fallback sem alterar as
demais atividades. Relatórios e telemetria são preservados no rollback.

O bridge lê o agregado em um path configurável, sanitiza e expõe
`benchmark_restricted_pivot` sem casos, chunks, paths ou eventos. O sensor
`sensor.codex_pivot_rtx_restrito` preserva valores ausentes como ausentes. O card
**Pivot RTX — expansão restrita** separa A/B/C/D, mostra labels de medição e usa
formatação pt-BR. Ele não mistura benchmark com telemetria operacional, uso do
GPT ou número de inferências. O schema antigo do benchmark quality-first
continua compatível e em um card separado.

## Critério de parada

Devemos continuar expandindo o Local AI? **Somente de forma restrita.** A
extração residual passou integralmente um holdout independente de 100 casos e
justifica canário cauteloso. O resumo generativo de logs perdeu para o extrator
determinístico. Embeddings melhoraram médias de ranking, mas omitiram a maioria
dos arquivos críticos e falharam o gate inegociável. Portanto não há base para
novo bake-off amplo, modelos maiores, update de Ollama, fine-tuning, cascata de
verificadores, índice operacional ou similaridade semântica de erros.

## Limitações

- Extração passou em dados novos e independentes, mas sintéticos e restritos a
  100 casos de promoção; o canário real não foi executado.
- Os datasets de logs são sanitizados/sintéticos, não logs privados de produção.
- Tokens de contexto e redução são estimados; GPT direto, qualidade final do GPT
  e tokens faturados não foram executados nem medidos.
- Retrieval representa o histórico do Git no SHA inicial e não toda possível
  distribuição de tarefas futuras, embora os casos sejam snapshot-consistent.
- Não havia embedding challenger nem reranker compatível já instalado; não foi
  feita instalação externa ou atualização de runtime.
- O primeiro harness de retrieval causou pressão transitória no host antes da
  correção por batches. A execução canônica terminou estável, mas essa ocorrência
  limita afirmações sobre escalabilidade de um índice futuro.
- Similaridade de erros foi corretamente pulada; nenhuma métrica de qualidade
  semântica foi produzida.
- Latência foi medida, mas não usada como gate de promoção conforme o contrato.

## Artefatos públicos

- [extração estruturada residual](benchmarks/local-ai-restricted-pivot/structured-extraction-promotion/report.md);
- [validação factual de logs](benchmarks/local-ai-restricted-pivot/summarize-log-validation/report.md);
- [retrieval e reranking](benchmarks/local-ai-restricted-pivot/retrieval-reranking/report.md);
- [similaridade de erros](benchmarks/local-ai-restricted-pivot/error-similarity/report.md).
