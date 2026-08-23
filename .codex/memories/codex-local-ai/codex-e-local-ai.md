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
descartado equivale ao contexto bruto e economiza zero. Para cada resultado
aprovado, a economia útil líquida subtrai do delta bruto os tokens locais de
entrada e saída consumidos por seus gates. Histórico sem separação do custo
preserva o bruto para auditoria, mas reivindica zero líquido. Ela permanece estimada
porque o overhead do envelope OpenAI não é mensurável pelo helper. Logs longos passam primeiro por filtragem determinística
de ruído, preservando sinais e contexto; `summarize-log` usa schema limitado e
no máximo uma repetição compacta para evitar JSON truncado.

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

No modelo vigente, `review-diff`, `inspect-files` e `analyze-tests` não passaram
o A/B líquido e são `LOCAL_AI_NOT_BENEFICIAL` no uso operacional. Continuam
disponíveis apenas em benchmark forçado; `summarize-log` é o perfil do conjunto
A/B com redução útil comprovada.

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
`qwen2.5-coder:14b` foi selecionado: 2/4 fixtures utilizáveis, 3.414 tokens úteis
evitados e 51,5% de redução efetiva. O 7B obteve 1/4 e 16,8%; `qwen3.5:9b`
obteve 0/4 e 0%. Diff e inventário rejeitados pelo 14B contaram zero, enquanto
testes e log foram utilizados. A fonte detalhada é
`docs/LOCAL_AI_BENCHMARK_2026-08-16.md`.

Ao descontar também o custo do verificador dos resultados aprovados, a repetição
com 14B aproveitou somente `summarize-log`: 2.230 tokens brutos menos 693 do
gate, ou 1.537 tokens úteis líquidos e 23,2% no conjunto. Os outros três casos
foram descartados e valeram zero. A taxa anterior de 51,5% é histórica e não é
a taxa líquida vigente.

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
