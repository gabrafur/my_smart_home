# Benchmark Local AI — 2026-08-16

Endpoint testado: `http://192.168.0.153:11435` (Ollama remoto). GPU: NVIDIA
GeForce RTX 4070, 12.282 MiB de VRAM. A suíte `local-ai-bounded-v1` usa quatro
casos sintéticos e não sensíveis: revisão de diff, saída de testes, trechos de
arquivos e resumo de log. Um caso só conta como sucesso se o JSON obedecer ao
schema da tarefa.

| Modelo | Schemas | Throughput agregado | Pico GPU | Pico VRAM | CPU offload | Decisão |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `qwen2.5-coder:1.5b-base` | 2/4 (50%) | 159,92 tok/s | 42% | 2.757 MiB | não | rejeitado: schema instável |
| `qwen2.5-coder:7b` | 4/4 (100%) | 49,83 tok/s agregado; 91–93 tok/s por caso | 91% | 7.355 MiB | não | **selecionado** |
| `qwen3:8b` | 4/4 (100%) | 41,91 tok/s agregado; 65–70 tok/s por caso | 96% | 11.719 MiB | não | alternativa, pouca folga de VRAM |
| `qwen3:14b` | 1/4 (25%) | 41,16 tok/s no único caso válido | 96% | 10.374 MiB | não | rejeitado: schema instável |

O selecionado continua `qwen2.5-coder:7b`: cumpriu todos os schemas, foi mais
rápido que o outro candidato confiável e manteve aproximadamente 4.927 MiB de
folga para a RTX. Não houve download, remoção ou alteração de modelos.

As amostras de `ollama ps` informaram `100% GPU` em todos os casos; nenhuma
amostra indicou CPU offload. A métrica de “tokens OpenAI evitados” no painel é
uma estimativa de redução do contexto (bytes UTF-8/4 neste host), não custo ou
tokens faturados pela OpenAI.
