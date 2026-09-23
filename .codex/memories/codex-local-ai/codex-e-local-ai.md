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

<!-- memory-record {"id":"socket-remoto-codex-com-alias","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-09-23","evidence":[{"file":"scripts/codex-remote-recovery.mjs","sha256":"7ab9c9d37852ca59f273079f236cf181ef89ef6e5ce72a7e9a08740beefff0b3"},{"file":"scripts/codex-remote-health-publisher.mjs","sha256":"70024e040df2a8d493c37ef72fe5183fe26369ce8d2796a6d8584052f214fb1d"},{"file":"scripts/codex-remote-recovery.test.mjs","sha256":"67dbf070b408bbef4ccaa45eccdff496dd734340b863f845e26f47ec70a693d0"},{"file":"docs/CODEX_REMOTE_RECOVERY.md","sha256":"c1bc5bcb6215c50c2ec8cfc9c38d8afee6409677b0a9ad92ff6f1fd4da72ee74"}]} -->
## Socket remoto do Codex com alias

O caminho de controle do App Server pode ser um link simbólico para um socket físico protegido. Sonda e recovery devem resolver o alias e comparar o caminho exato no ss, inclusive para verificar o PID antes de restart explícito. O recovery preserva aliases ativos, deixa o próprio Codex reconciliar sockets obsoletos e passa o caminho configurado ao --listen.

<!-- /memory-record -->

<!-- memory-record {"id":"identidade-e-telemetria-do-bridge","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-09-23","evidence":[{"file":"docker-compose.yml","sha256":"f5f9b0d918afd69ab5c5059593447a9504c6194fcb73e1742ba8bf6675b2723e"},{"file":"ia-bridge/Dockerfile","sha256":"631078302b64c93e6bf4134fdd6c48763e2621cd7faf235bd4fa0358ef2f6e1f"},{"file":"ia-bridge/server.js","sha256":"53a617b9a3382a35e86d2cf7f956b0767574e3fc6fda5738fd1b2813ecd5b436"},{"file":"ia-bridge/server-telemetry.test.js","sha256":"78af75161d420311e41860b2299d10a585c89f4e619075d28f87ae3a3bc574db"},{"file":"ia-bridge/usage.js","sha256":"3fe37231d5c9aae548907dcd6639ae7cf07c49a9205376877073b7854dd67757"},{"file":"ia-bridge/usage.test.js","sha256":"715d8fa29808129f382ab12c7ffc5131a2fd5ae3fcc9cc39c822348f348f2003"},{"file":"docs/LOCAL_AI_RTX_4070.md","sha256":"9ead348e3fb5d2e32aab9c1e2f4a3b828f2c382cb50693961a976f6caacd040d"}]} -->
## Identidade e telemetria do bridge

O bridge executa sem root com UID/GID derivados de REPO_UID/REPO_GID para ler por montagem somente leitura as sessões privadas do dono do checkout, inclusive diretórios 0700 e arquivos 0600. Migração de UID exige reconciliar os arquivos do antigo usuário nos volumes de autenticação e no estado do bridge antes da nova imagem; preservar conteúdo, modos e grupos compartilhados. Os endpoints de telemetria serializam respostas antes dos headers HTTP. Fonte sem permissão degrada explicitamente o agregado, publica totais e analytics nulos e preserva dados independentes de conta e Local AI; não deve derrubar o processo, ampliar permissões ou apresentar totais parciais como completos.

<!-- /memory-record -->
