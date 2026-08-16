# Codex e Local AI

O modelo local é uma primeira passagem limitada e não autoritativa. Use-o apenas
quando reduzir materialmente contexto não sensível; decisões de arquitetura,
segurança, produção e ações irreversíveis permanecem sob revisão principal.

Antes de alterar o helper, hook, telemetria ou as abas Codex/RTX, consulte
`docs/LOCAL_AI_RTX_4070.md`. A publicação LAN usa uma porta proxy própria e
restrita; não a amplie sem confirmar o escopo.

A economia exibida exclui falhas e benchmarks, admite delta negativo quando o
resumo cresce e permanece estimada porque o overhead do envelope OpenAI não é
mensurável pelo helper. Logs longos passam primeiro por filtragem determinística
de ruído, preservando sinais e contexto; `summarize-log` usa schema limitado e
no máximo uma repetição compacta para evitar JSON truncado.
