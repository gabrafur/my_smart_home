# Benchmark Local AI — 2026-08-16 (atualizado em 2026-08-23)

Decisão vigente: `qwen2.5-coder:14b`. O benchmark histórico abaixo explica a
seleção anterior de 7B; a seção **A/B com gate de qualidade — 2026-08-23**
registra a reavaliação que motivou a troca.

Endpoint testado: `http://GPU_HOST:11435` (Ollama remoto; endereço real fica
na configuração privada). GPU: NVIDIA
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

## Reavaliação operacional e correção — 2026-08-23

Na primeira observação, o preflight canônico retornava
`LOCAL_AI_UNAVAILABLE reason=endpoint_unreachable`, embora Windows, WSL e
`ollama.service` estivessem ativos. A regra persistente do portproxy estava
correta, mas o serviço Windows IP Helper não tinha materializado o listener
TCP. Um reinício desacoplado desse serviço restaurou o endpoint; reiniciá-lo na
própria sessão SSH não era confiável porque a conexão era encerrada no meio da
operação.

A correção durável é o helper versionado `recover-endpoint.mjs`, habilitado
somente na configuração privada da máquina. Em chamada MCP, ele pode enviar
Wake-on-LAN e faz no máximo duas tentativas idempotentes: inicia o WSL/Ollama já
instalado, reconcilia apenas o portproxy do endereço exato e, quando necessário,
reinicia o IP Helper em tarefa desacoplada. Ele não instala software, amplia o
firewall, cria listener curinga nem reinicia o host. Polling passivo do bridge
não dispara a recuperação.

O teste controlado removeu somente a regra publicada, confirmou o endpoint
indisponível e então chamou o MCP real. O preflight recuperou a publicação em
7,3 s e retornou `LOCAL_AI_AVAILABLE`; o bridge voltou a expor estado
disponível. A tarefa temporária usada no Windows foi removida depois do teste.

## Benchmark fresco — 2026-08-23

Os quatro modelos já instalados foram executados sequencialmente pela mesma
suíte canônica, sem download, remoção ou troca permanente do modelo ativo:

| Modelo | Schemas | Throughput agregado | Pico GPU | Pico VRAM | CPU offload |
| --- | ---: | ---: | ---: | ---: | --- |
| `qwen2.5-coder:1.5b-base` | 2/4 (50%) | 158,55 tok/s | 55% | 7.879 MiB | não |
| `qwen2.5-coder:7b` | 4/4 (100%) | 77,64 tok/s | 89% | 7.915 MiB | não |
| `qwen3:8b` | 4/4 (100%) | 49,03 tok/s | 94% | 8.991 MiB | não |
| `qwen3:14b` | 1/4 (25%) | 41,24 tok/s | 97% | 11.394 MiB | não |

O resultado fresco mantém `qwen2.5-coder:7b`: é o candidato com 4/4 schemas
mais rápido e com menor pico de VRAM. O modelo ativo foi restaurado ao fim dos
testes.

## Protocolo A/B para o MCP

É possível medir o efeito da RTX sem alterar o modelo ativo. O teste deve ser
pareado, sequencial e composto apenas por fixtures sintéticas e não sensíveis:

1. Fixar o mesmo modelo principal, reasoning, instruções e limite de saída em
   sessões isoladas.
2. No controle, enviar ao modelo principal a saída determinística bruta. No
   tratamento, aplicar `local_ai_route` e `local_ai_compress_context` e enviar
   somente o JSON estruturado retornado pelo MCP.
3. Alternar a ordem das duas condições para reduzir efeitos de aquecimento e
   executar os mesmos casos de diff, testes, inventário de arquivos e logs.
4. Avaliar às cegas retenção de fatos críticos, correção da conclusão e
   fidelidade a arquivos e linhas. Medir separadamente tokens de contexto no
   modelo principal, latência local, latência total, falhas, GPU, VRAM e CPU
   offload.
5. Tratar falha local como falha do braço de tratamento, sem convertê-la
   silenciosamente em sucesso por fallback. Benchmarks continuam fora do
   contador operacional de economia.

Critérios conservadores para promover uma alternativa são: 4/4 schemas no
benchmark, nenhuma omissão crítica, qualidade não inferior ao controle por mais
de 5 pontos percentuais, redução mediana de contexto de pelo menos 50%, falhas
de no máximo 5%, ausência de CPU offload e pico de VRAM abaixo de 85% da placa.
O teste deve executar uma condição por vez no host residencial.

## Resultado A/B — 2026-08-23

O controle foi o conteúdo bruto de quatro fixtures sintéticas idênticas; o
tratamento foi somente o JSON devolvido por chamadas reais do MCP, todas com
`job_id`, telemetria registrada, `100% GPU` e sem CPU offload. Tokens são a
estimativa de contexto do projeto (bytes UTF-8/4), não tokens faturados.

| Caso com `qwen2.5-coder:7b` | Controle | Tratamento | Redução | Latência local |
| --- | ---: | ---: | ---: | ---: |
| revisão de diff | 2.012 | 418 | 79,2% | 6,046 s |
| saída de testes | 2.655 | 276 | 89,6% | 4,253 s |
| inventário de arquivos | 2.181 | 234 | 89,3% | 3,590 s |
| log de aplicação | 3.165 | 106 | 96,7% | 3,218 s |
| **Total** | **10.013** | **1.034** | **89,7%** | **17,107 s** |

Houve redução material de 8.979 tokens estimados, mas **não houve manutenção
integral da qualidade**. O JSON cumpriu o schema nos quatro casos, porém a
revisão interpretou ao contrário a conversão de TTL, o inventário omitiu um
arquivo crítico e o resumo do log preservou `CACHE_WRITE_TIMEOUT` somente após
uma repetição, ainda omitindo o WARN de retry e outros detalhes. Apenas a
análise de testes reteve claramente todos os sinais essenciais. Portanto,
4/4 schemas não pode ser tratado como 4/4 qualidade semântica.

Um A/B temporário com `qwen3:8b` reduziu 10.013 para 1.091 tokens estimados
(89,1%). Ele interpretou melhor o diff, mas foi mais lento (28,679 s), precisou
de uma segunda tentativa no inventário e também deixou o resumo de log
incompleto. Esse resultado motivou um gate determinístico e uma segunda
verificação por modelo. A economia só conta quando o resultado passa pelos dois
níveis.

## A/B com gate de qualidade — 2026-08-23

Foram instalados e avaliados `qwen2.5-coder:14b` e `qwen3.5:9b`, além do modelo
anterior de 7B. Cada braço recebeu as mesmas quatro fixtures públicas. O controle
envia 6.624 tokens estimados de contexto bruto; no tratamento, uma saída só
substitui o controle quando preserva os fatos exigidos, recebe pelo menos 90%
no verificador de fidelidade e evita ao menos 600 tokens. Saída descartada
equivale ao controle completo e portanto economiza zero.

| Modelo | Casos utilizáveis | Tokens efetivos ao modelo principal | Tokens úteis evitados | Redução útil | Latência local |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen2.5-coder:7b` | 1/4 | 5.510 | 1.114 | 16,8% | 35,031 s |
| `qwen2.5-coder:14b` | **2/4** | **3.210** | **3.414** | **51,5%** | 80,239 s |
| `qwen3.5:9b` | 0/4 | 6.624 | 0 | 0% | 54,257 s |

O modelo de 14B venceu apesar da maior latência. Preservou os fatos essenciais
nos casos de testes (1.384 → 216 tokens; 1.168 úteis evitados) e log (2.440 →
194; 2.246 úteis evitados). Diff e inventário foram rejeitados e por isso não
geraram economia. O benchmark de schema do 14B também passou 4/4 casos, com
36,77 tok/s agregados, 94% de pico de GPU, 10.831 MiB de VRAM, `100% GPU` e
nenhum CPU offload. `qwen3.5:9b` não estabilizou o contrato JSON e foi rejeitado.

A decisão vigente é usar `qwen2.5-coder:14b` e aceitar a latência maior em troca
da redução útil superior. O comando reprodutível é
`python3 scripts/local-ai/quality_ab.py --model <modelo>`; benchmarks e A/B não
entram nos acumulados operacionais.
