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

<!-- memory-record {"id":"identidade-e-telemetria-do-bridge","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-05","evidence":[{"file":"ia-bridge/Dockerfile","sha256":"631078302b64c93e6bf4134fdd6c48763e2621cd7faf235bd4fa0358ef2f6e1f"},{"file":"ia-bridge/server.js","sha256":"53a617b9a3382a35e86d2cf7f956b0767574e3fc6fda5738fd1b2813ecd5b436"},{"file":"ia-bridge/server-telemetry.test.js","sha256":"78af75161d420311e41860b2299d10a585c89f4e619075d28f87ae3a3bc574db"},{"file":"ia-bridge/usage.js","sha256":"3fe37231d5c9aae548907dcd6639ae7cf07c49a9205376877073b7854dd67757"},{"file":"ia-bridge/usage.test.js","sha256":"715d8fa29808129f382ab12c7ffc5131a2fd5ae3fcc9cc39c822348f348f2003"},{"file":"docs/LOCAL_AI_RTX_4070.md","sha256":"3da7032c1a987acb92b4e6f7b79000b04ae0058658f365b8a620188f5e1f4670"}]} -->
## Identidade e telemetria do bridge

O bridge executa sem root com UID/GID derivados de REPO_UID/REPO_GID para ler por montagem somente leitura as sessões privadas do dono do checkout, inclusive diretórios 0700 e arquivos 0600. Migração de UID exige reconciliar os arquivos do antigo usuário nos volumes de autenticação e no estado do bridge antes da nova imagem; preservar conteúdo, modos e grupos compartilhados. Os endpoints de telemetria serializam respostas antes dos headers HTTP. Fonte sem permissão degrada explicitamente o agregado, publica totais e analytics nulos e preserva dados independentes de conta e Local AI; não deve derrubar o processo, ampliar permissões ou apresentar totais parciais como completos.

<!-- /memory-record -->

<!-- memory-record {"id":"publicacao-rtx-na-retomada-do-windows","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-10-05","evidence":[{"file":"docs/LOCAL_AI_RTX_4070.md","sha256":"3da7032c1a987acb92b4e6f7b79000b04ae0058658f365b8a620188f5e1f4670"}]} -->
## Publicação RTX na retomada do Windows

A inicialização nativa da publicação RTX usa a tarefa LocalAiRtxStartupPortproxy em boot, logon e retomada, com espera limitada por rede e API loopback. O hook republica somente a porta restrita já autorizada pelo firewall, com no máximo duas tentativas, sem reiniciar IP Helper ou seus dependentes de VPN. A existência da regra portproxy não comprova listener ativo. Preserve a separação entre esse hook local, o keepalive do WSL e o recovery MCP remoto explícito; sondagens residenciais continuam passivas. Execução manual e teste de listener ausente não comprovam um ciclo real de suspensão ou boot. Consulte docs/LOCAL_AI_RTX_4070.md e os scripts PowerShell de local-ai-integration.

<!-- /memory-record -->

<!-- memory-record {"id":"saida-tap-local-sem-perda","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-10-05","evidence":[{"file":"scripts/local-ai/compact_output.py","sha256":"a4383e580ae2e630bc4fa9a9dfa5cb140c76bffe1ca4a6b6bb7f224f65ae40c4"},{"file":"scripts/local-ai/run.py","sha256":"385e58e0a9bc34fe7e5c7681a7a3d98ff3913b6fbee6c3db12c7f2d925ac3975"},{"file":"scripts/local-ai/test_compact_output.py","sha256":"11c13477c2089abe4fa47e418873fb41910595007cc188766773473051cd4595"},{"file":"docs/LOCAL_AI_RTX_4070.md","sha256":"3da7032c1a987acb92b4e6f7b79000b04ae0058658f365b8a620188f5e1f4670"},{"file":"docs/benchmarks/local-context-output/summary.json","sha256":"de691d4e95607ea8fce6bdd4bda641c73ed447b45722f85fb3960f3548cae755"}]} -->
## Saída TAP local sem perda

O formatador de saídas TAP roda antes da fronteira da ferramenta, preserva falhas e linhas desconhecidas literalmente e exige reconstrução byte a byte. Ele cobre saídas de testes sem ativar perfis generativos ou alterar hooks e contabiliza a economia separadamente de GPU, inferência e faturamento. O wrapper Python evita o custo de inicialização de outro Node; comandos pequenos e interativos seguem o caminho usual. A cobertura de hooks aninhados depende do cliente: feedback não prova que o objeto JavaScript foi substituído. Consulte o contrato e o benchmark operacional antes de extrapolar a redução de saídas para a conversa inteira.

<!-- /memory-record -->

<!-- memory-record {"id":"metricas-rtx-calculadas-no-node-red","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-05","evidence":[{"file":"docs/LOCAL_AI_RTX_4070.md","sha256":"3da7032c1a987acb92b4e6f7b79000b04ae0058658f365b8a620188f5e1f4670"},{"file":"nodered/tools/functions/rtx-metrics-periods.js","sha256":"52478df1bafdacee062903f6234996fbb039994e24b507188e63c81533c483d3"},{"file":"nodered/tools/test-rtx-metrics-flow.mjs","sha256":"16361c45670246891e59078de5db2ac7ee4d8ea782bbc3d0f9bafb87f673dc9e"},{"file":"homeassistant/tests/test_chat_rtx_dashboard_layout.py","sha256":"eb4db43d5cbadd9cc728841ae8802ceed7982c2adc495c953060b6d2ced5a7fc"}]} -->
## Métricas RTX calculadas no Node-RED

O painel uso-rtx consome o contrato do tab metricas_rtx. O bridge fornece contadores e recibos sanitizados; Node-RED calcula taxas, saldo e classificações de disponibilidade e histórico. Sondas passivas incluem collected_at para não confundir uma leitura repetida com dado antigo. Ausência de amostra não vira zero; contadores Local AI não provam execução exclusiva na GPU. O sensor de atributos é excluído do Recorder, sensores numéricos mantêm séries próprias, e testes atravessam o mesmo cálculo até o gate dry-run anterior ao MQTT. Preserve o legado codex_* para outros consumidores. Os waterfalls de hoje UTC e do total preservado exibem as mesmas 18 etapas em sensores numéricos canônicos. Fidelidade aprovada inclui resultados fiéis sem ganho; redução no total usa saldo / (tokens Codex + saldo), distinta da redução sobre contexto tentado.

<!-- /memory-record -->
