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

<!-- memory-record {"id":"serializar-worktree-com-promotor-residencial","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-16","evidence":[{"file":"scripts/install-daily-update-nodered-bridge.sh","sha256":"46e4d56b01da66f65c5dc137500ce4998bf0a81f518baf35a73c361d210defdf"},{"file":"scripts/promote-kia-uvo-candidate.mjs","sha256":"5c7c94657c8ed918e2b1777995e9468375964a03eb52a9dcf7b9f2aa6b49e065"},{"file":"scripts/promote-kia-uvo-candidate.test.mjs","sha256":"6907c4e0d2a98b1d3734fa2c49ee70a4f4eb10c486471058a11051d5f2e7eff9"},{"file":"nodered/tools/install-daily-host-update-flow.mjs","sha256":"e6382d710dfff9922ea109c5922316d916cfcc5514c41f56cf11edbba85f8ef0"},{"file":"nodered/tools/test-daily-host-update-flow.mjs","sha256":"ef9ca099ae59277f53d1ed16946e0f9e297bd3616e0821ed1e335f1f3c506b17"},{"file":"docs/VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md","sha256":"f5c0883e87243a75e75c929b94a6436c10f837f59466ea164fdb847a9238d0c2"}]} -->
## Serializar manutenção Git com o promotor residencial

As pontes de atualização e o promotor Kia compartilham .daily-maintenance.lock. Operações interativas que tornem a worktree temporariamente limpa devem respeitar esse mesmo lock: o cron pode interpretar a limpeza como autorização para iniciar uma promoção já aprovada. Restaurar alterações alheias durante a validação do runtime impede o commit da candidata. Se o runtime já foi aplicado, confira os bytes contra a candidata e retome apenas a etapa Git; não reinstale por causa de falha de publicação. Reconcilie alterações já publicadas com origin/main antes de retomar, preservando trabalho concorrente. O promotor preserva applied_pending_git durante outra atualização do host; worktree_changed e main_behind_remote são adiamentos tipados. O tab atualizacoes_diarias recebe códigos enumerados, mostra espera em amarelo e mantém git_publication_failed como falha observável. A regressão usa Git temporário até publicação sem reinstalar; o canvas oferece reset, Git ocupado e conclusão até o terminal dry-run.

<!-- /memory-record -->
