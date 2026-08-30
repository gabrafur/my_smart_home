# Exceção de revisão documental semanal sem supervisão

O prompt versionado `scripts/weekly-docs-review.prompt.md` contém o marcador
exato `CODEX_UNATTENDED_WEEKLY_DOCS_REVIEW`. Quando ele aparecer na primeira
solicitação, é uma invocação não interativa pré-autorizada de
`scripts/weekly-docs-review.mjs`: execute o prompt e registre o resultado sem
interação. Solicitações interativas também começam imediatamente, mas não
herdam outras autorizações específicas dessa revisão semanal.
