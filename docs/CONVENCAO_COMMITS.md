# Convenção de mensagens de commit

[Português (principal)](CONVENCAO_COMMITS.md) · [English](COMMIT_CONVENTION.en.md)

Este repositório usa Conventional Commits em inglês. O objetivo é tornar o
histórico legível, pesquisável e adequado a changelogs e automações, inclusive
quando commits são criados pelo Codex ou por rotinas do próprio repositório.

O exemplo canônico é:

```text
fix: make Codex card loading deterministic
```

## Formato

```text
<tipo>[(escopo-opcional)][!]: <descrição imperativa>

[corpo opcional]

[rodapés opcionais]
```

O assunto, isto é, a primeira linha:

- deve estar em inglês;
- deve começar com um dos tipos permitidos;
- pode conter um escopo minúsculo entre parênteses;
- deve usar uma descrição no imperativo iniciada por palavra minúscula;
- deve ter no máximo 72 caracteres;
- não deve terminar com ponto, exclamação ou interrogação;
- deve descrever uma única mudança coerente.

Nomes próprios e siglas preservam sua grafia depois da primeira palavra, como
`Home Assistant`, `Codex`, `Node-RED`, `RTX` e `SSH`.

## Tipos

| Tipo | Use quando | Exemplo |
| --- | --- | --- |
| `feat` | adicionar capacidade observável pelo usuário ou integração | `feat: add vehicle door lock action` |
| `fix` | corrigir comportamento, regressão ou falha | `fix: recover Node-RED services after network startup` |
| `docs` | alterar somente documentação | `docs: explain the commit convention` |
| `test` | adicionar ou corrigir testes sem mudar o produto | `test: cover commit subject validation` |
| `refactor` | reorganizar código sem mudar comportamento externo | `refactor(codex): move detailed workflows into skills` |
| `chore` | manutenção, backup ou trabalho interno sem efeito funcional direto | `chore: create automated smart home backup` |
| `ci` | alterar pipeline ou configuração de integração contínua | `ci: validate commit subjects on every push` |
| `build` | alterar build, empacotamento ou dependências | `build(nodered): update runtime dependencies` |
| `perf` | melhorar desempenho sem alterar o contrato funcional | `perf: reduce dashboard history queries` |
| `revert` | reverter uma mudança anterior | `revert: remove vehicle lock action` |

Escolha o tipo pelo efeito principal do commit, não apenas pelos arquivos
tocados. Um bug corrigido junto com seu teste continua sendo `fix`; uma nova
capacidade com documentação continua sendo `feat`.

## Escopo

O escopo é opcional. Use-o somente quando distinguir o subsistema ajudar a
entender o assunto sem abrir o diff. Ele deve começar em minúscula e pode usar
números, `.`, `_`, `/` ou `-`.

```text
fix(homeassistant): prevent DNS outage on container recreation
feat(nodered): add vehicle door lock action
docs(creta): document refresh and update runbook
```

Evite escopos genéricos como `app`, `code` ou `misc`. Quando a mudança cruza
subsistemas e há um efeito principal claro, prefira omitir o escopo.

## Breaking changes, corpo e rodapés

Use `!` imediatamente antes de `:` quando consumidores precisarem agir para
adotar a mudança. Explique a incompatibilidade e a migração em um rodapé
`BREAKING CHANGE:`.

```text
feat(bindings)!: require logical roles in public configuration

Replace physical identifiers with the documented logical role names.

BREAKING CHANGE: existing private bindings must be migrated before startup.
```

Use o corpo para explicar motivação, decisões, riscos e detalhes que não cabem
no assunto. Separe assunto, corpo e rodapés por uma linha em branco. Não use o
corpo para esconder um assunto vago.

## Commits automáticos e merges

Scripts que criam commits obedecem ao mesmo contrato. O backup Git usa
`chore: create automated smart home backup`; data, autor e hash já fazem parte
dos metadados do commit e não precisam poluir o assunto.

Commits de merge gerados pela plataforma podem manter a mensagem automática e
são ignorados pela checagem mecânica. Ao escrever manualmente uma mensagem de
merge, prefira uma forma convencional, como `chore: integrate storage
maintenance`.

## Validação

Valide um assunto antes de criar o commit:

```bash
node scripts/commit-message-check.mjs --subject \
  'fix: make Codex card loading deterministic'
```

Valide o commit atual ou um intervalo:

```bash
make validate-commit-message
node scripts/commit-message-check.mjs origin/main..HEAD
```

`make validate-public` inclui a validação de `HEAD`, e a CI executa esse alvo
em pushes e pull requests. A checagem confirma o formato, os tipos, o escopo, o
limite e a pontuação. Inglês, modo imperativo e precisão semântica continuam
sendo requisitos de revisão humana e do Codex, pois não podem ser inferidos de
forma confiável por uma expressão regular.

## Checklist rápido

Antes do commit, confirme:

1. o tipo representa o efeito principal;
2. o assunto está em inglês e no imperativo;
3. a primeira palavra da descrição está em minúscula;
4. o assunto tem até 72 caracteres e não termina com pontuação;
5. o escopo, se usado, realmente acrescenta contexto;
6. breaking changes têm `!`, explicação e instrução de migração;
7. corpo e rodapés registram contexto reutilizável sem dados privados.
