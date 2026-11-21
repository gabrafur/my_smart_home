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

<!-- memory-record {"id":"serializar-worktree-com-promotor-residencial","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-11-21","evidence":[{"file":"scripts/install-daily-update-nodered-bridge.sh","sha256":"46e4d56b01da66f65c5dc137500ce4998bf0a81f518baf35a73c361d210defdf"},{"file":"scripts/promote-kia-uvo-candidate.mjs","sha256":"328c20637d312042e68c09030b7e62bf600dcbe2f111029c29d6d1c45924f09b"},{"file":"scripts/promote-kia-uvo-candidate.test.mjs","sha256":"33b91918ce17a82e79b2e40203c5256876b10fcf7a385d07822236ac2206a104"},{"file":"nodered/tools/install-daily-host-update-flow.mjs","sha256":"1d91bd6ea1da831265b4aba457907e3a17ff5526144a1fd57339e65d17c2ec54"},{"file":"nodered/tools/test-daily-host-update-flow.mjs","sha256":"db8537880ab99fa330a37d104f64cfc6dac7591b274e6a4c768fa804fd46c5a0"},{"file":"docs/VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md","sha256":"f5c0883e87243a75e75c929b94a6436c10f837f59466ea164fdb847a9238d0c2"},{"file":"scripts/process-git-backup-request.sh","sha256":"f7e17ba33962db854755694ba8ff88c3ab7c1fb3d7b6413b1eabcfc97cc77792"},{"file":"scripts/git-backup-request.test.mjs","sha256":"0d41f325535920a086551d49e2b15336d061d5af47c6298de7f88d0be51be7b9"},{"file":"scripts/weekly-docs-review.mjs","sha256":"d40f4b4831da47ecb3373810e677da316340340fe8b2bec3f7ecd95208ec368e"},{"file":"scripts/weekly-docs-review.test.mjs","sha256":"7f8312ed0595dd6af4ae6ba6eaa90b79f37bcfc35dd5f9bb880c63482e3b2609"},{"file":"nodered/tools/install-weekly-docs-review-flow.mjs","sha256":"e2a9fc75359162b136b417d2bdb9f98146907f9675a6a8e0d0c4e4bfdec0db37"},{"file":"docs/REVISAO_DOCUMENTACAO_SEMANAL.md","sha256":"45ee4d2094a5c15d572764fc1c0c88873f737ddaa60cad189072c2dfb692c876"}]} -->
## Serializar manutenção Git com o promotor residencial

Atualizações, promotor Kia, ponte de backup Git e revisão documental compartilham .daily-maintenance.lock durante toda a transação, incluindo validação e push. Operações interativas que tornem a worktree temporariamente limpa devem respeitar esse mesmo lock: o cron pode interpretar a limpeza como autorização para iniciar uma promoção já aprovada. Restaurar alterações alheias durante a validação do runtime impede o commit da candidata. Se o runtime já foi aplicado, confira os bytes contra a candidata e retome apenas a etapa Git; não reinstale por causa de falha de publicação. Reconcilie alterações já publicadas com origin/main antes de retomar, preservando trabalho concorrente. O promotor preserva applied_pending_git durante outra atualização do host; worktree_changed e main_behind_remote são adiamentos tipados. O tab atualizacoes_diarias recebe códigos enumerados, mostra espera em amarelo e mantém git_publication_failed como falha observável. A regressão usa Git temporário até publicação sem reinstalar; o canvas oferece reset, Git ocupado e conclusão até o terminal dry-run.

A revisão documental usa uma janela separada da manutenção residencial; horários distintos não substituem o lock. Contenção preserva os pedidos de backup e revisão, sem iniciar Git ou Codex antes da liberação. A revisão mantém o pedido no watcher existente até obter o slot. O backup chamado de dentro de um update não readquire o lock: a ponte independente o adquire antes de chamar git-backup.sh, evitando autobloqueio.

<!-- /memory-record -->
