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
  `scripts/commit-message-check.mjs`.
- Imediatamente antes de `git push`, confira `git status` e o histórico recente
  do branch. Se houver commit inesperado, não o publique nem o descarte sem
  confirmar o escopo com o usuário.
