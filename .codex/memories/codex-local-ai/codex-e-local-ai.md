# Codex e Local AI

O modelo local é uma primeira passagem limitada e não autoritativa. Use-o apenas
quando reduzir materialmente contexto não sensível; decisões de arquitetura,
segurança, produção e ações irreversíveis permanecem sob revisão principal.

Antes de alterar o helper, hook, telemetria ou as abas Codex/RTX, consulte
`docs/LOCAL_AI_RTX_4070.md`. A publicação LAN usa uma porta proxy própria e
restrita; não a amplie sem confirmar o escopo.

As políticas gerais e específicas do Codex têm uma única fonte versionada:
`AGENTS.md` no Git root. Não mantenha cópia em `~/.codex/AGENTS.md` nem monte o
arquivo do projeto como instrução global no bridge; o workspace já fornece o
mesmo arquivo pelo mecanismo de descoberta do repositório.

A economia exibida exclui falhas e benchmarks, admite delta negativo quando o
resumo cresce e permanece estimada porque o overhead do envelope OpenAI não é
mensurável pelo helper. Logs longos passam primeiro por filtragem determinística
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

Para contratos, schemas, documentação bilíngue e mudanças multiarquivo,
derive antes um inventário determinístico com arquivos, campos, comandos,
módulos, headings e testes. Esse inventário é a entrada preferencial para
`summarize-document` ou `inspect-files`: a validação P1 mostrou retenção melhor
nesse formato do que em blocos longos de código bruto. Uma inferência concluída
que omita requisitos, arquivos ou riscos críticos deve ser descartada e não
conta como preservação útil de contexto.

Memória pública do repositório é recuperada por índice e busca determinística,
nunca carregada integralmente no startup. `local-ai memory-audit` mede somente
o contexto observável e `summarize-memory` comprime recuperação ampla antes do
modelo principal, preservando estado, decisões, restrições, bugs, causas-raiz,
configuração, pendências e avisos. A telemetria mantém memória separada de
logs/diffs: corpus disponível não é economia; somente o delta entre memória
recuperada e resultado estruturado enviado ao modelo é contado. Consulte
`docs/MEMORIA_VERSIONADA_AGENTES.md` e `docs/LOCAL_AI_RTX_4070.md`.
