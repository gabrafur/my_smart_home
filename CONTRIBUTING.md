# Contribuindo / Contributing

Este repositório documenta uma plataforma real, mas publica apenas código,
configuração e exemplos sanitizados. Contribuições são bem-vindas quando
preservam essa fronteira. / This repository documents a real platform while
publishing only sanitized code, configuration, and examples. Contributions
are welcome when they preserve that boundary.

## Antes de começar / Before you start

- Este é atualmente um projeto de referência/portfólio sem licença raiz. Não
  trate o controle **Use this template** do GitHub como permissão geral de
  reutilização; a decisão está documentada em
  [LICENSING_DECISION](docs/LICENSING_DECISION.pt-BR.md).
- Para contribuir aqui, faça um **fork**, crie uma branch curta e envie um
  pull request. O mantenedor pode continuar fazendo alterações próprias
  diretamente na `main`; isso não muda o fluxo externo.
- This is currently a reference/portfolio project without a root license. Do
  not treat GitHub's **Use this template** control as general reuse permission;
  see [LICENSING_DECISION](docs/LICENSING_DECISION.md). To contribute back,
  fork this repository, create a focused branch, and open a pull request.
- Nunca envie credenciais, IPs privados, coordenadas, MACs, nomes de moradores,
  identificadores físicos, logs ou estado real de dispositivos. / Never submit
  credentials, private addresses, coordinates, MACs, resident names, physical
  identifiers, real logs, or device state.

## Ambiente e validação / Environment and validation

Requisitos: Git, Node.js 20, GNU Make, Docker Engine com Compose e Python 3.
Requirements: Git, Node.js 20, GNU Make, Docker Engine with Compose, and
Python 3.

```bash
git clone https://github.com/SEU_USUARIO/my_smart_home.git
cd my_smart_home
make bootstrap-test
make validate-public
make demo-test
```

`make bootstrap` cria somente templates privados ausentes; revise o plano antes
de usá-lo numa instalação. `make demo` é sintético, em memória e sem I/O real.
`make bootstrap` creates missing private templates only; review its plan before
using it for an installation. `make demo` is synthetic, in-memory, and performs
no real I/O.

## Pull request

1. Mantenha o escopo pequeno e explique o problema, a decisão e a evidência.
2. Atualize PT-BR e inglês quando o documento estiver marcado como `full pair`
   em `docs/i18n-manifest.json`.
3. Atualize testes e documentação na mesma mudança quando alterar contratos.
4. Rode `make validate-public`, `scripts/security-scan.sh --staged` e
   `make privacy-check-staged`.
5. Marque claramente integrações opcionais, efeitos externos e passos manuais.

Keep the scope focused; explain the problem, decision, and evidence. Update
both languages for full pairs, change tests and docs with their contracts, run
the checks above, and label optional integrations, external effects, and human
approval boundaries.

## Mensagens de commit / Commit messages

Use Conventional Commits em inglês, no formato
`<tipo>[(escopo-opcional)][!]: <descrição imperativa>`. O assunto deve começar
com palavra minúscula, ter no máximo 72 caracteres e não terminar com
pontuação. Os tipos aceitos são `feat`, `fix`, `docs`, `test`, `refactor`,
`chore`, `ci`, `build`, `perf` e `revert`. Use escopo minúsculo apenas quando
ele esclarecer o subsistema. Exemplo: `fix: make Codex card loading
deterministic`.

Use English Conventional Commits in the form
`<type>[(optional-scope)][!]: <imperative description>`. Start the subject with
a lowercase word, keep it to 72 characters or fewer, and omit trailing
punctuation. The accepted types are `feat`, `fix`, `docs`, `test`, `refactor`,
`chore`, `ci`, `build`, `perf`, and `revert`. Add a lowercase scope only when
it clarifies the affected subsystem. Example: `fix: make Codex card loading
deterministic`.

Valide uma mensagem antes do commit com / Validate a message before committing
with:

```bash
make install-git-hooks
node scripts/commit-message-check.mjs --subject 'fix: describe the correction'
```

Consulte [a convenção completa](docs/CONVENCAO_COMMITS.md) para tipos, escopos,
breaking changes e exemplos. See [the complete convention](docs/COMMIT_CONVENTION.en.md)
for types, scopes, breaking changes, and examples.

Ao participar, você concorda com o [Código de Conduta](CODE_OF_CONDUCT.md).
Security findings follow [SECURITY.md](SECURITY.md), never a public issue.
