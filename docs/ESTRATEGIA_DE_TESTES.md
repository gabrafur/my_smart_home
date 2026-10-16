# Estratégia de testes

[Português (principal)](ESTRATEGIA_DE_TESTES.md) · [English](TESTING_STRATEGY.en.md)

## Autoridade e níveis

`make validate-public` é a única verificação pública completa. O Makefile pode
delegar para alvos menores, usados para diagnóstico, mas CI, documentação e
scheduler não mantêm uma segunda lista de cobertura.

| Nível | Objetivo | Execução |
| --- | --- | --- |
| Unitário | Funções puras, parsing e regras de falha segura | Node Test Runner e `unittest` |
| Estático | JSON, YAML, shell, Compose, links, assets e sintaxe | checkers rastreados pelo Git |
| Contrato | Manifests, módulos, bindings, memória, privacidade e segurança | schemas e scanners fail-closed |
| Home Assistant | Dashboards, formatação pt-BR, histórico RTX e estimativa do veículo | descoberta por `unittest`, sem carregar runtime residencial |
| Integração sintética | Flows e bridge com dados temporários | agregadores Node-RED e bridge |
| Restore/bootstrap/demo | Recovery, clone novo e cenário lógico | diretórios temporários, sem estado residencial |

## Descoberta e categorias

`npm --prefix nodered run test:all` descobre todo `nodered/tools/test-*.mjs`.
Somente o próprio agregador é excluído. O teste de runtime usa um container
Node-RED temporário, isolado, com flow sintético e sem volumes, credenciais ou
rede da residência. `npm --prefix ia-bridge test` usa a descoberta recursiva do
Node Test Runner para todos os `*.test.js` pertinentes.

Os testes Node.js de `scripts/` são descobertos recursivamente por
`scripts/test-all.mjs`. Restore, bootstrap e demo são categorias explícitas e
rodam pelos alvos `make restore-test`, `make bootstrap-test` e `make demo-test`.
Os testes públicos independentes de Local AI usam descoberta `test_*.py`.
Os testes em `homeassistant/tests/` usam a mesma descoberta e carregam somente
stubs determinísticos mínimos quando exercitam a integração vendorizada.

## Matrizes e CI

A matriz core valida somente Home Assistant, Node-RED e Mosquitto. A matriz
full ativa todos os profiles públicos usando `.env.example`. Ambas executam
somente `docker compose ... config --quiet`; nenhum serviço residencial é
iniciado. A CI tem um check canônico, `public-validation / Canonical public
validation`, que chama somente `make validate-public`.

O hook versionado `pre-push`, ativado por `make install-git-hooks`, exige uma
árvore de trabalho limpa e executa esse mesmo alvo canônico antes de permitir
o envio do `HEAD`. Assim, o estado validado localmente corresponde ao commit
enviado, e uma falha bloqueia o push antes de chegar ao GitHub Actions.

## Critério de conclusão e handoff

Cada tarefa deve ter um objetivo e um critério de conclusão declarado. Ao
continuar trabalho de outro executor, confirme projeto, host, branch e SHA
quando houver repositório,
escopo autorizado, estado preexistente a preservar, último resultado validado
e próximo passo. Um resumo de outra tarefa não transfere sua autorização.

Relate as camadas de evidência aplicáveis, sempre com fonte, ambiente, momento
da observação e limite:

| Camada | Prova de conclusão | Se não for verificada |
| --- | --- | --- |
| Configuração/API | Releitura do estado aplicado pela configuração ou API | Informe que só houve escrita ou preparação |
| Código | Testes direcionados e validação pública/CI, conforme o escopo | Liste os checks pendentes; CI não prova produção |
| UI | Conferência visual e da interação afetada | Declare que houve apenas releitura de configuração/API |
| Operação | Saúde e resultado de ciclo real posterior à mudança | Mantenha pendente até o ciclo agendado; não o antecipe para encerrar |

Nem toda camada se aplica a toda tarefa. Não chame uma rotina de concluída em
produção quando somente configuração ou testes foram validados. Informe as
pendências de forma explícita, inclusive quando uma confirmação depende de
acesso, autorização ou evento futuro.

Handoff mínimo: **objetivo; projeto/host; branch/SHA se houver; estado preexistente;
alteração feita; evidência por camada aplicável; pendências e autorizações;
próximo passo verificável**. Use arquivos públicos, resultados de testes/CI,
releitura de API ou estado operacional resumido como fontes. Não inclua
credenciais, eventos, calendários privados, identificadores pessoais nem
conteúdo de runtime privado no handoff ou na memória pública.

## Limites deliberados

A automação nunca testa contra a residência real: não lê secrets, não chama
endpoints domésticos, não envia notificações, não movimenta portão, não muda
alarme, não controla veículo e não inicia a stack. Testes físicos e validação
pós-deploy continuam procedimentos manuais documentados. Antes de um commit,
o índice também pode ser validado com `make validate-staged`. O escape
`--no-verify` do Git existe para recuperação excepcional e não faz parte do
fluxo normal.
