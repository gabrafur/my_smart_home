# Codex e Local AI

O modelo local é uma primeira passagem limitada e não autoritativa. Use-o apenas
quando reduzir materialmente contexto não sensível; decisões de arquitetura,
segurança, produção e ações irreversíveis permanecem sob revisão principal.

Antes de alterar o helper, hook, telemetria ou as abas Codex/RTX, consulte
`docs/LOCAL_AI_RTX_4070.md`. A publicação LAN usa uma porta proxy própria e
restrita; não a amplie sem confirmar o escopo.

As instruções obrigatórias do Codex têm uma única fonte de preload versionada:
`AGENTS.md` no Git root. O procedimento detalhado e acionado sob demanda para
este subsistema fica em
`.agents/skills/rtx-context-optimizer/SKILL.md`; não o duplique como memória.
Não mantenha cópia em `~/.codex/AGENTS.md` nem monte o arquivo do projeto como
instrução global no bridge; o workspace já fornece o mesmo arquivo pelo
mecanismo de descoberta do repositório.

A economia útil exibida exclui falhas, descartes e benchmarks; resultado
descartado equivale ao contexto bruto e economiza zero. Desde o schema 19, ela
também exige prova de entrega pelo `PostToolUse` ou pelo recibo metadata-only
`code-mode-orchestrator-v1`, vinculado ao mesmo job MCP e tamanho exato. O
resultado precisa ser mensurado, não truncado e aprovado por validador
independente. Normalmente ele é um modelo distinto do gerador; o perfil de logs
também admite o gate exato `deterministic-log-anchors-v1`. CLI, MCP direto e
legado sem prova de entrega preservam valores
provisórios para auditoria, mas reivindicam zero líquido confirmado. Para cada
resultado confirmado, a economia útil líquida subtrai do delta bruto os tokens
locais de entrada e saída consumidos por seus gates. Ela permanece estimada
porque o overhead do envelope OpenAI não é mensurável pelo helper. Logs longos passam primeiro por filtragem determinística
de ruído, preservando sinais e contexto. Desde o runtime 1.3.3,
`summarize-log` entrega somente extratos: até 16 linhas críticas injetadas
deterministicamente e de uma a quatro linhas rotineiras escolhidas pela RTX por
ID e resolvidas de volta para a fonte. Prosa, ações e arquivos gerados são
substituídos por metadados determinísticos; truncamento, excesso de sinais ou
seletor não extrativo devolvem o contexto bruto e economizam zero.

O roteamento é uma decisão determinística e registrada antes da inferência:
tipo de tarefa, tamanho estimado, compressibilidade, economia prevista,
ferramenta determinística e disponibilidade formam a avaliação. `local-ai
route` só registra metadados de skips; chamadas normais registram `LOCAL_AI_USED`
ou `LOCAL_AI_UNNECESSARY_CALL`. Uma oportunidade perdida exige tarefa elegível,
RTX disponível e helper não chamado; métricas de cobertura usam oportunidades
e economia real, sem tratar estimativas como cobrança. Consulte
`docs/LOCAL_AI_RTX_4070.md` para thresholds, retenção e a limitação do hook.

O contexto bruto também precisa caber no contrato confiável do helper. Diffs,
inventários e documentos acima de 3.000 tokens estimados, e memória acima de
6.000, são `LOCAL_AI_NOT_BENEFICIAL` até serem particionados
deterministicamente; o miolo cortado não conta como contexto substituído. Saída
de testes, erros e logs pode ser maior porque a filtragem de sinais ocorre
sobre o corpo bruto antes do limite.

No modelo vigente, todos os perfis exceto `summarize-log` são
`LOCAL_AI_NOT_BENEFICIAL` no uso operacional. Continuam disponíveis apenas em
benchmark forçado. `summarize-log` começa em 3.000 tokens, aplica precheck
econômico e usa o validador extrativo independente
`deterministic:log-anchors-v1`, cujo custo de segunda inferência é zero.

Suficiência determinística significa que nenhuma interpretação por LLM ainda é
necessária. Coleta determinística pode produzir texto grande que continua
elegível para pós-processamento local; JSON estruturado, agregados escalares e
resultados pequenos permanecem finais. Status, disponibilidade, rota e
elegibilidade não provam uso da RTX: somente uma compressão concluída com
`job_id`, telemetria registrada e job bem-sucedido autoriza essa afirmação.

Para contratos, schemas, documentação bilíngue e mudanças multiarquivo,
derive antes um inventário determinístico com arquivos, campos, comandos,
módulos, headings e testes. Esse inventário é a entrada preferencial para
`summarize-document` ou `inspect-files`: a validação P1 mostrou retenção melhor
nesse formato do que em blocos longos de código bruto. Uma inferência concluída
que omita requisitos, arquivos ou riscos críticos deve ser descartada e não
conta como preservação útil de contexto.

Uma avaliação A/B do MCP deve comparar fixtures idênticas em sessões isoladas:
o controle recebe a saída determinística bruta e o tratamento recebe somente o
JSON estruturado da compressão local. Fixe modelo principal, reasoning,
instruções e limites; alterne a ordem das condições e meça qualidade, retenção
de fatos críticos, tokens enviados ao modelo principal, latência total,
falhas, GPU, VRAM e CPU offload. Falha local pertence ao braço de tratamento e
não pode ser ocultada pelo fallback. Execute as condições sequencialmente no
host residencial e somente com preflight disponível.

O A/B de 2026-08-23 demonstrou que schema válido não comprova retenção. Após a
introdução do gate determinístico e do verificador com nota mínima de 90%, o
`qwen2.5-coder:14b` foi selecionado em uma avaliação autoavaliada: 2/4 fixtures
utilizáveis, 3.414 tokens úteis evitados e 51,5% de redução efetiva. Ao descontar
o custo do gate, uma repetição aproveitou somente `summarize-log`: 2.230 tokens
brutos menos 693 do gate, ou 1.537 tokens líquidos e 23,2% no conjunto. Esses
percentuais são históricos e não constituem previsão operacional independente.

Em 2026-08-24, a baseline congelada tinha 260 tentativas operacionais. O único
saldo mensurado era 2.234 tokens brutos menos 691 do gate, ou 1.543 provisórios,
mas veio do CLI e não provava uso pelo modelo principal. A baseline estrita foi,
portanto, zero. O benchmark v4 executou oito fixtures, metade holdout, duas vezes
com `qwen2.5-coder:14b` gerando. `qwen3:8b` e `qwen3:14b` selecionaram os mesmos
2/16 resultados economicamente úteis: 4.096 tokens offline, 13,6% ponderados e
mediana 0%. Todo o ganho ficou nos logs de 3.000–5.999 tokens; as 14 observações
menores economizaram zero. O 14B reduziu falsas rejeições de 9 para 6, mas não
aumentou ganho e foi mais lento, então nenhum verificador foi promovido. O
benchmark continua sendo avaliação offline de compressão e fidelidade, não A/B
ponta a ponta do modelo principal; seus 4.096 tokens valem zero no painel
operacional. A fonte detalhada é `docs/LOCAL_AI_BENCHMARK_2026-08-16.md`.

Uma rodada v5 posterior restringiu o corpus aos logs elegíveis de
3.000–5.999 tokens e executou desenvolvimento e holdout quatro vezes com o
mesmo gerador. O gate extrativo produziu 8/8 aceites úteis, zero falsos aceites
ou rejeições, mediana de 94,8%, intervalo bootstrap agrupado de 94,7–94,8% e
24.060 tokens offline evitados sem segunda inferência. Isso justificou promover
o perfil 1.3.3, mas continua sem provar economia operacional: até um transporte
canônico usar o resultado, o valor confirmado permanece zero.

O A/B ponderado v8 mediu o sistema completo com 14 pares, duas fixtures em cada
uma de sete classes, e manteve tarefas não elegíveis no denominador. No perfil
sintético declarado de 100 tarefas equivalentes, `gpt-5.6-terra`/`medium`
passou de 1.675.620 para 1.568.475 tokens ponderados: 6,39% de economia global.
No estrato elegível, composto somente por logs, a economia foi 30,10%. Os dois
braços passaram 14/14 oráculos, sem perdas ou divergências; a latência média dos
logs subiu de 6,502 para 15,660 segundos. Esses pesos não vêm de conversas
privadas nem garantem a distribuição futura de uso. A fonte detalhada continua
em `docs/LOCAL_AI_BENCHMARK_2026-08-16.md`.

O benchmark de alto potencial v1 de 2026-08-24 excluiu `summarize-log` e testou
100 casos em cinco classes. Das 70 tarefas tentadas, 27 foram utilizáveis, 43
caíram em fallback e 25 tiveram perda crítica; o método determinístico passou
100/100. Extração, classificação, seleção, agrupamento/deduplicação e resumo de
diff ficaram `DETERMINISTIC_FIRST`, todos com `production_enabled: false`. A
economia estimada dos aceites não autoriza promoção porque useful RTX rate foi
38,6%, fallback 61,4% e o GPT final não foi executado. A fonte canônica é
`docs/LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md`.

Não compare diretamente esse percentual A/B com a redução útil operacional. O
A/B divide o líquido pelo contexto de controle das fixtures fixas; o indicador
operacional usa a mesma regra de qualidade no numerador, mas divide pelo contexto
de todas as tentativas de substituição da janela. Descartes, falhas e legado sem
custo do gate separável permanecem no denominador e valem zero líquido. Taxas de
falha técnica, aceite ou descarte contam chamadas, enquanto redução útil pondera
tokens; diferenças entre elas não formam contradição sem reconciliar população,
janela, numerador e denominador.

Diagnósticos, preflight e benchmarks ficam separados das chamadas operacionais.
Falha técnica, aproveitamento do gate e waterfall usam somente a população
operacional; a cobertura de classificação explicita quanto do histórico pôde
ser atribuído com segurança. Resultados antigos sem custo de gate mensurável não
entram como aprovados mensuráveis. Como entrada do contexto e custo local podem
usar tokenizadores diferentes, o saldo líquido é um índice conservador
equivalente, não uma contagem faturável da OpenAI.

A nota percentual do verificador mede fidelidade, não economia. Um resultado
pode ter 100% de fidelidade e ainda ser `insufficient_net_savings` quando o
custo medido do gate consome o delta ou o líquido não alcança o mínimo. Esse
caso vale zero, aparece como **sem ganho líquido** e não deve inflar descartes
por qualidade; `quality_gate_rejected` fica reservado a falhas de fidelidade.

Para disponibilidade, o helper versionado `recover-endpoint.mjs` é uma exceção
estreita: somente uma chamada MCP pode enviar Wake-on-LAN e fazer no máximo duas
tentativas de iniciar WSL/Ollama já instalado e restaurar o portproxy de endereço
exato. Polling passivo não desperta o host; nenhuma tentativa instala software,
amplia firewall/listener ou reinicia a máquina, e duas falhas encerram no
fallback normal. Endereço, MAC e credenciais permanecem em configuração privada.

Memória pública do repositório é recuperada por índice e busca determinística,
nunca carregada integralmente no startup. `local-ai memory-audit` mede somente
o contexto observável e `summarize-memory` comprime recuperação ampla antes do
modelo principal, preservando estado, decisões, restrições, bugs, causas-raiz,
configuração, pendências e avisos. A telemetria mantém memória separada de
logs/diffs: corpus disponível não é economia; somente o delta entre memória
recuperada e resultado estruturado enviado ao modelo é contado. Consulte
`docs/MEMORIA_VERSIONADA_AGENTES.md` e `docs/LOCAL_AI_RTX_4070.md`.
