# Benchmark Local AI — 2026-08-16 (atualizado em 2026-08-24)

Decisão vigente: `qwen2.5-coder:14b` permanece como gerador instalado, mas o
uso operacional é desviado sem inferência enquanto não houver um verificador
independente que passe simultaneamente pelos gates de fidelidade e economia.
Nenhum candidato foi promovido na bateria v4. O benchmark histórico abaixo
explica a seleção anterior de 7B; as seções posteriores registram cada
reavaliação.

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

## A/B líquido do custo de validação — 2026-08-23

Depois de separar os tokens de cada chamada do verificador, o mesmo A/B foi
repetido com `qwen2.5-coder:14b`. A economia útil passou a ser calculada por
resultado aprovado como `max(0, economia bruta - entrada do verificador - saída
do verificador)`. Um resultado descartado continua valendo zero, nunca economia
negativa; seu trabalho de verificação permanece visível no custo total do gate.

| Métrica | Resultado |
| --- | ---: |
| Casos aprovados e eficientes | 1/4 |
| Contexto do controle | 6.624 tokens |
| Contexto efetivamente enviado ao modelo principal | 4.378 tokens |
| Economia bruta dos aprovados | 2.230 tokens |
| Gate do resultado aprovado | 693 tokens locais |
| **Tokens úteis líquidos** | **1.537 tokens** |
| **Redução útil líquida** | **23,2%** |
| Trabalho total de todos os gates, inclusive descartes | 8.095 tokens locais |
| Latência local total | 68,179 s |

Somente `summarize-log` foi aproveitado: 2.230 tokens brutos menos 693 tokens do
gate resultaram em 1.537 tokens úteis líquidos. `review-diff`, `analyze-tests` e
`inspect-files` foram descartados e, portanto, economizaram zero. O resultado
anterior de 51,5% media o delta aprovado sem descontar o verificador e não deve
mais ser usado como a taxa vigente. Esta rodada com autoavaliação mostrou 23,2%
na suíte, mas não constitui evidência independente; o gate conservador continua
obrigatório porque três quartos dos casos não produziram contexto confiável e
econômico.

## Benchmark offline v3 com verificador independente — 2026-08-24

O executável foi corrigido para não apresentar o benchmark de compressão como
um A/B end-to-end do Codex. Ele agora registra hashes das fixtures e prompts,
método de contagem, gerador e verificador, repetições, resultado por tarefa,
taxa de aproveitamento, redução ponderada por tokens e mediana por tentativa.
O modelo principal não é executado nos dois braços; o campo
`end_to_end_primary_model_evaluated: false` torna essa limitação explícita.

A bateria v3 executou as quatro fixtures três vezes, sequencialmente. O gerador
foi `qwen2.5-coder:14b` e o verificador independente foi `qwen3:8b`, ambos já
instalados. A telemetria temporária manteve as 12 observações fora dos
acumulados operacionais.

| Métrica | Resultado |
| --- | ---: |
| Observações | 12 |
| Resultados aprovados e eficientes | 0/12 |
| Contexto de controle | 19.872 tokens estimados |
| Trabalho total dos gates | 21.516 tokens locais |
| Tokens úteis líquidos | 0 |
| Redução útil ponderada | 0,0% |
| Mediana por tentativa | 0,0% |
| Latência local total | 298,245 s |

O verificador independente rejeitou todas as observações, inclusive as três de
`summarize-log`. Portanto, o antigo 23,2% permanece somente como resultado
histórico de uma execução com o mesmo modelo nos papéis de gerador e
verificador. Ele não deve ser usado como previsão da economia operacional nem
como evidência independente de qualidade. O `qwen3:8b` também não foi promovido
a verificador operacional: habilitá-lo faria todo resultado cair em fallback.
O modelo gerador configurado permanece inalterado, e cada uso operacional
continua dependendo do gate conservador e contabiliza zero quando descartado.

### Verificação operacional do limite de contexto

Uma revisão real de diff com 73.435 caracteres foi executada depois do A/B. O
endpoint permaneceu disponível, o `qwen2.5-coder:14b` usou 100% da GPU, mas as
duas gerações de cada tentativa foram rejeitadas antes do verificador: o helper
conseguia apresentar apenas 12.000 caracteres ao modelo. As tentativas
economizaram zero e comprovaram que estimar benefício sobre o diff bruto inteiro
seria incorreto.

Por isso, o roteador passou a classificar `review-diff`, `inspect-files` e
`summarize-document` acima de 3.000 tokens estimados como
`LOCAL_AI_NOT_BENEFICIAL`; `summarize-memory` usa teto de 6.000. O caller deve
particionar entradas maiores deterministicamente. Para logs, erros e testes, a
filtragem de sinais agora percorre o corpo bruto antes do corte, preservando as
linhas acionáveis sem alegar que um miolo arbitrariamente omitido foi analisado.
Como `review-diff`, `inspect-files` e `analyze-tests` não produziram resultado
líquido confiável nesta bateria, o roteamento operacional os marca como
`task_quality_not_validated`; `LOCAL_AI_FORCE=1` permanece reservado à próxima
rodada diagnóstica. Assim, rejeições já conhecidas deixam de consumir GPU e não
aparecem como oportunidades RTX perdidas.

## Baseline estrita e benchmark offline v4 — 2026-08-24

A telemetria foi congelada antes das mudanças com 302 chamadas e hash
`13b4ace5d25a250752e0cafd5e0ce7f8c51b4f4a10c8b8bdd475dc789255b1bb`.
Das 260 tentativas operacionais, 146 terminaram com sucesso técnico, 95 foram
rejeitadas por qualidade, 15 falharam e 4 produziram candidato fiel sem ganho
líquido. Havia 8 aprovações de qualidade, mas somente uma tinha custo do gate
mensurado: 2.234 tokens brutos menos 691 tokens do gate, ou 1.543 tokens
provisórios. Essa chamada veio do CLI e não continha prova de que o resultado
substituiu o contexto entregue ao modelo principal. Portanto, o baseline
operacional estrito é **zero**, não 1.543.

O schema 18 separa desde então economia aprovada pelo gate de economia
efetivamente utilizada. Para confirmar uso, o job precisa ser bem-sucedido,
mensurado, aprovado por um verificador independente do gerador, não truncado e
originado pelo `PostToolUse`, que retém a saída bruta e entrega o contexto
estruturado. CLI, benchmark, MCP direto e histórico sem esse vínculo continuam
auditáveis, mas reivindicam zero economia operacional confirmada.

Antes do A/B, uma calibração isolada executou 16 decisões por verificador,
alternando quatro candidatos positivos e quatro negativos em duas repetições:

| Verificador | Falsos aceites | Falsas rejeições | Acurácia | Tokens dos gates | Mediana |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen3:8b` | 0 | 4 | 75,0% | 6.419 | 3,829 s |
| `qwen3.5:9b` | 0 | 6 | 62,5% | 7.874 | 5,402 s |
| `qwen3:14b` | 0 | 0 | 100,0% | 6.532 | 4,710 s |

O A/B v4 usou oito fixtures fixas, quatro de desenvolvimento e quatro holdouts,
duas repetições, ordem determinística alternada, parâmetros idênticos e o mesmo
gerador `qwen2.5-coder:14b`. O hash das fixtures foi
`3ad658b714c5c9498a091c49ac19a93c7553924e72c682ac62e6cb9ffee53839`.
O oráculo determinístico foi mantido separado do gate do modelo para tornar
falsas aceitações e falsas rejeições observáveis.

| Artefato da rodada | SHA-256 |
| --- | --- |
| Prompts | `9e8ba44add7f523bc74667e4bfe56cca7261a3d57512e80c3f67a30075d8b34e` |
| Helper | `5f876abc8ba0650cac559192e6fea21fe534e5ddd40fb3c6ef1c8f9f4011f4af` |
| Harness | `157d011bf7008e0f0452e116c23511dceb2284f76ec8f5846db0ac2ee5bfbd4e` |
| Roteador | `eaffb2ae9e8ca5c9aef1fa93b6074ab2e35eb7721f32d2b5c6375c667bff1a3f` |

Depois da medição, o roteador foi deliberadamente alterado para incorporar o
resultado: piso de 3.000 tokens para logs, precheck antes de preflight e desvio
sem inferência quando falta verificador independente. Assim, os hashes acima
identificam a rodada observada; o runtime `1.3.2` identifica a política promovida
após o experimento. Prompts, fixtures, parâmetros (`num_ctx=8192`, saída 1.200,
temperatura zero e seed `20260824`) e harness permaneceram fixos.

| Métrica | `qwen3:8b` | `qwen3:14b` |
| --- | ---: | ---: |
| Observações | 16 | 16 |
| Aceitas pelo gate | 4 | 7 |
| Aceitas e economicamente úteis | 2 | 2 |
| Falsos aceites | 0 | 0 |
| Falsas rejeições | 9 | 6 |
| Contexto de controle | 30.088 | 30.088 |
| Tokens úteis líquidos offline | 4.096 | 4.096 |
| Redução ponderada offline | 13,6% | 13,6% |
| Mediana por tentativa | 0,0% | 0,0% |
| Latência total | 401,034 s | 414,610 s |

Todo o ganho apareceu nas duas observações de `summarize-log` entre 3.000 e
5.999 tokens: 65,8% nesse estrato. As 14 observações abaixo de 3.000 tokens
economizaram zero. O `qwen3:14b` reduziu falsas rejeições, mas não aumentou
seleção econômica nem tokens líquidos e consumiu mais latência. Por isso não
foi promovido. `qwen3.5:9b` também foi descartado após a calibração pior.

O roteamento operacional agora faz um precheck econômico antes da inferência,
desabilita os perfis sem evidência líquida e exige verificador independente.
Como a configuração privada ainda não contém um verificador promovido, uma
chamada operacional é desviada para o contexto original sem consumir GPU. Isso
reduz desperdício, mas não é contado como economia.

O v4 continua sendo um benchmark offline da compressão e de seu gate. Não
existe neste ambiente um harness que execute controle e tratamento em sessões
isoladas do mesmo modelo principal e compare a qualidade final. Assim,
`end_to_end_primary_model_evaluated` permanece `false`, a economia confirmada
do experimento é zero e os 4.096 tokens offline não podem ser somados ao painel
operacional. Os relatórios completos ficam apenas no histórico privado local;
o repositório preserva o harness, hashes, parâmetros e estes agregados
sanitizados para reprodução.
