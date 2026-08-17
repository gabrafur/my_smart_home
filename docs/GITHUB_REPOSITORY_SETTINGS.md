# Configuração recomendada do repositório GitHub

O repositório está tecnicamente preparado para proteger `main` com o check
`public-validation / Canonical public validation`. A configuração é manual no
GitHub e não faz parte da execução local.

Recomendação para uma ruleset de `main`:

- exigir o check canônico antes de atualizar a branch;
- exigir branch atualizada ou fila de merge quando o fluxo adotar PRs;
- bloquear force-push e exclusão da branch;
- restringir bypass a recuperação administrativa explícita;
- preservar histórico linear quando compatível com o fluxo operacional.

O fluxo semanal autorizado e pushes diretos intencionais precisam ser
compatibilizados com a ruleset antes de ativá-la; a proteção não deve receber
secrets residenciais.
