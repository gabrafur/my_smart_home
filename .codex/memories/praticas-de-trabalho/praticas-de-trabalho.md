# Práticas de trabalho

## Comunicação e escopo

- Responda no chat em português brasileiro, salvo pedido contrário. Convenções
  já definidas para código, documentação ou integrações prevalecem.
- Ao adicionar uma integração, automação ou assistente semelhante, mantenha o
  existente. Remoções ou substituições exigem pedido explícito.

## Alterações e documentação

- Toda alteração não trivial em flows, pacotes do Home Assistant, integrações
  ou ferramentas deve atualizar o guia relacionado em `docs/` ou criar um
  novo, seguindo o estilo do repositório.
- Ao alterar a lógica de um nó no Node-RED, atualize também seus nomes,
  comentários e textos no canvas que descrevam esse comportamento.

## Git

- Para alterações acumuladas e independentes, separe commits por assunto e
  revise o índice antes de cada commit.
- Mensagens novas seguem Conventional Commits em inglês, com descrição
  imperativa iniciada em minúscula e assunto de até 72 caracteres; o contrato
  vigente está em `AGENTS.md` e `CONTRIBUTING.md` e é verificado por
  `scripts/commit-message-check.mjs`. Os hooks versionados, ativados por `make
  install-git-hooks`, bloqueiam mensagens manuais inválidas em `commit-msg` e
  executam `make validate-public` com árvore limpa em `pre-push`.
- Imediatamente antes de `git push`, confira `git status` e o histórico recente
  do branch. Se houver commit inesperado, não o publique nem o descarte sem
  confirmar o escopo com o usuário.

## Revisão documental automatizada

- A aba `revisao_documental_semanal` do Node-RED é a fonte única do agendamento
  e do acionamento manual. `scripts/weekly-docs-review.mjs` permanece como
  worker canônico; o prompt instrui o agente, mas o worker conserva a autoridade
  para allowlist, validação, commit e push.
- Na versão atual do CLI, `codex exec --approve-for-me` já usa revisão
  automática com sandbox `workspace-write`. Não combine essa opção com
  `--sandbox`; a regressão fica em `scripts/weekly-docs-review.test.mjs`.
- O checkout do agente é intencionalmente um worktree em `detached HEAD`, preso
  ao baseline validado pelo worker. A conclusão só é aceita com o recibo JSON
  transitório; saída zero sem recibo ou com bloqueio não pode virar
  `no_changes`.
- `remote_authentication_failed` pode mascarar falha de DNS anterior ao SSH.
  Verifique separadamente resolução dentro do contêiner, validade da chave e
  leitura do remoto antes de trocar credenciais.
- Se apenas `docs-review-scheduler` reteve resolvers obsoletos, recrie somente
  esse serviço e confirme DNS, leitura remota e `next_run`; não reinicie a
  stack residencial.

<!-- memory-record {"id":"serializar-worktree-com-promotor-residencial","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-26","evidence":[{"file":"scripts/install-daily-update-nodered-bridge.sh","sha256":"46e4d56b01da66f65c5dc137500ce4998bf0a81f518baf35a73c361d210defdf"},{"file":"scripts/promote-kia-uvo-candidate.mjs","sha256":"472e12be6a37341f34b2eb63abbc6c48be82dade235c9dde0df429994d939831"},{"file":"scripts/promote-kia-uvo-candidate.test.mjs","sha256":"a23920937d2d3f3c2b689f59a12f67db1b9e82cf57afc43b1b21997347cc387c"},{"file":"nodered/tools/install-daily-host-update-flow.mjs","sha256":"08fc06501d5234cf14354627284faa6f7c2ba9276fec3877258fc43a5ebd5a7c"},{"file":"nodered/tools/test-daily-host-update-flow.mjs","sha256":"fa7af5685365b8d41ca9ac1d1a5201b038988750fd26dbb7cf6a6c555f048680"},{"file":"docs/VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md","sha256":"f5c0883e87243a75e75c929b94a6436c10f837f59466ea164fdb847a9238d0c2"},{"file":"scripts/process-git-backup-request.sh","sha256":"f7e17ba33962db854755694ba8ff88c3ab7c1fb3d7b6413b1eabcfc97cc77792"},{"file":"scripts/git-backup-request.test.mjs","sha256":"315696a75abc070ed71853b95a5e2855c1662d6f2672aa4f4ffab8022e378604"},{"file":"scripts/weekly-docs-review.mjs","sha256":"36d7d9852c63c6c67229969261ab939330dd4bcdee1cbd88823c65a5e4377018"},{"file":"scripts/weekly-docs-review.test.mjs","sha256":"79370286bc8387ca2298a7ea83dd54bdc5b40d061f8292c9f260af767276d744"},{"file":"nodered/tools/install-weekly-docs-review-flow.mjs","sha256":"8c089adf21e0cbca33cd74bb3b5cb88db712a39d146c3c437bbccc24f4ff4002"},{"file":"docs/REVISAO_DOCUMENTACAO_SEMANAL.md","sha256":"82bcfe9fed04cacb21e3d02429e7eef539cdc36e93bdb72db918c4a049ccb78d"}]} -->
## Serializar manutenção Git com o promotor residencial

Atualizações, promotor Kia, ponte de backup Git e revisão documental compartilham .daily-maintenance.lock durante toda a transação, incluindo validação e push. Operações interativas que tornem a worktree temporariamente limpa devem respeitar esse mesmo lock: o cron pode interpretar a limpeza como autorização para iniciar uma promoção já aprovada. Restaurar alterações alheias durante a validação do runtime impede o commit da candidata. Se o runtime já foi aplicado, confira os bytes contra a candidata e retome apenas a etapa Git; não reinstale por causa de falha de publicação. Reconcilie alterações já publicadas com origin/main antes de retomar, preservando trabalho concorrente. O promotor preserva applied_pending_git durante outra atualização do host; worktree_changed e main_behind_remote são adiamentos tipados. O tab atualizacoes_diarias recebe códigos enumerados, mostra espera em amarelo e mantém git_publication_failed como falha observável. A regressão usa Git temporário até publicação sem reinstalar; o canvas oferece reset, Git ocupado e conclusão até o terminal dry-run.

A revisão documental usa uma janela separada da manutenção residencial; horários distintos não substituem o lock. Contenção preserva os pedidos de backup e revisão, sem iniciar Git ou Codex antes da liberação. A revisão mantém o pedido no watcher existente até obter o slot. O backup chamado de dentro de um update não readquire o lock: a ponte independente o adquire antes de chamar git-backup.sh, evitando autobloqueio.

<!-- /memory-record -->
