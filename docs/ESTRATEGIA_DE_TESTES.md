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

## Matrizes e CI

A matriz core valida somente Home Assistant, Node-RED e Mosquitto. A matriz
full ativa todos os profiles públicos usando `.env.example`. Ambas executam
somente `docker compose ... config --quiet`; nenhum serviço residencial é
iniciado. A CI tem um check canônico, `public-validation / Canonical public
validation`, que chama somente `make validate-public`.

## Limites deliberados

A automação nunca testa contra a residência real: não lê secrets, não chama
endpoints domésticos, não envia notificações, não movimenta portão, não muda
alarme, não controla veículo e não inicia a stack. Testes físicos e validação
pós-deploy continuam procedimentos manuais documentados. Antes de um commit,
o índice também pode ser validado com `make validate-staged`.
