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

<!-- memory-record {"id":"serializar-worktree-com-promotor-residencial","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-16","evidence":[{"file":"scripts/install-daily-update-nodered-bridge.sh","sha256":"46e4d56b01da66f65c5dc137500ce4998bf0a81f518baf35a73c361d210defdf"},{"file":"scripts/promote-kia-uvo-candidate.mjs","sha256":"a1c4cbd3ed51d058613a2784c7c840d5e078d5db8fb4a000763a02d614be6c43"}]} -->
## Serializar manutenção Git com o promotor residencial

As pontes de atualização e o promotor Kia compartilham .daily-maintenance.lock. Operações interativas que tornem a worktree temporariamente limpa devem respeitar esse mesmo lock: o cron pode interpretar a limpeza como autorização para iniciar uma promoção já aprovada. Restaurar alterações alheias durante a validação do runtime impede o commit da candidata. Se o runtime já foi aplicado, confira os bytes contra a candidata e retome apenas a etapa Git; não reinstale por causa de falha de publicação. Reconcilie alterações já publicadas com origin/main antes de retomar, preservando trabalho concorrente.

<!-- /memory-record -->
