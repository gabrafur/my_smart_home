# Codex e Local AI

O modelo local é uma primeira passagem limitada e não autoritativa. Use-o apenas
quando reduzir materialmente contexto não sensível; decisões de arquitetura,
segurança, produção e ações irreversíveis permanecem sob revisão principal.

Desde 26/08/2026, o runtime reutilizável tem código-fonte canônico em
`https://github.com/gabrafur/local-ai-rtx`. Este repositório conserva somente a
integração, a política, os dashboards e a pesquisa específica da implantação.
Release, commit e SHA-256 ficam fixados em
`local-ai-integration/local-ai-rtx.lock.json`; a instalação imutável padrão é
`$HOME/.local/share/local-ai-rtx/current`, com releases anteriores preservadas
para rollback. Não resta uma cópia versionada do runtime no monorepo.

Estado vigente desde o pivot restrito de 25/08/2026: não há perfil generativo
de compressão promovido. Logs usam fatos determinísticos e depois o modelo
principal. A única promoção é a capacidade default-off de canário a 10% para
extração estruturada residual com `qwen2.5-coder:14b`, parser-first, validação
source-anchored e fallback GPT direto. Retrieval/reranking ficou
`NOT_DEMONSTRATED`; não existe índice operacional, e similaridade de erros foi
pulada sem auto-merge. A decisão global é `CONTINUE_RESTRICTED`.

A ativação operacional posterior mantém os defaults públicos em `false/0` e
aplica o rollout de 10% somente por configuração privada. O tool separado
`local_ai_structured_extract` exige modo de produção, schema v1 suportado,
residual `UNSUPPORTED/AMBIGUOUS`, fonte sem segredo, digest congelado, coorte
SHA-256 versionada, telemetria metadata-only e circuit breaker `CLOSED`.
Controles e fallback seguem ao GPT sem segunda tentativa local; probes não
entram na amostra real, e o rollout não avança automaticamente.

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

## Evidência e limites de uso

Inferência bem-sucedida não prova que o resultado foi utilizado pelo modelo
principal. Economia operacional exige qualidade aceita e prova de entrega pelo
transporte canônico, vinculada ao mesmo job e tamanho de entrada. Descartes,
benchmarks e legado sem prova de entrega valem zero útil confirmado. Não crie
novos recibos de compressão enquanto os perfis continuarem sem promoção.
A nota de fidelidade não mede economia; os custos do gate também entram no saldo.

As antigas promoções de resumo extrativo de logs são históricas e foram
substituídas por `log_facts.py` sem inferência. Preserve os sinais; se a redução
não for segura, use o original. Métricas detalhadas dos experimentos pertencem
às fontes `docs/LOCAL_AI_BENCHMARK_2026-08-16.md`,
`docs/LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md`,
`docs/LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md` e
`docs/LOCAL_AI_RESTRICTED_PIVOT_2026-08-25.md`; não reutilize percentuais offline
como economia operacional atual.

## Recuperação e persistência

O helper `recover-endpoint.mjs` permite somente a recuperação MCP limitada
prevista na skill. Polling passivo não desperta o computador; no tab
`recuperacao_rtx`, recuperação é intenção manual explícita. Computador offline
é esperado; endpoint indisponível com computador online abre incidente
acionável deduplicado. `unknown` não confirma nenhuma dessas condições.

Memória pública é recuperada por índice e busca, nunca carregada integralmente
no startup. `memory-audit` não prova captura, e `summarize-memory` não é writer.
A geração/consulta de memória nativa do cliente é configuração separada e não
sincroniza, por si, `.codex/memories/`. Consulte
`docs/MEMORIA_VERSIONADA_AGENTES.md` antes de afirmar aprendizado entre sessões.

Atualizações do CLI são orquestradas por `atualizacoes_diarias`; o bridge
privilegiado recarrega o App Server após a atualização para não manter o binário
antigo em execução. Isso não equivale a reiniciar a stack residencial. Fontes:
`scripts/update-codex-cli.sh` e `scripts/codex-remote-recovery.mjs`.
