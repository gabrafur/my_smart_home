# Contribuindo / Contributing

Este repositório documenta uma plataforma real, mas publica apenas código,
configuração e exemplos sanitizados. Contribuições são bem-vindas quando
preservam essa fronteira. / This repository documents a real platform while
publishing only sanitized code, configuration, and examples. Contributions
are welcome when they preserve that boundary.

## Antes de começar / Before you start

- Para criar sua própria instalação, use **Use this template**. O novo
  repositório nasce sem vínculo de contribuição com este projeto.
- Para contribuir aqui, faça um **fork**, crie uma branch curta e envie um
  pull request. O mantenedor pode continuar fazendo alterações próprias
  diretamente na `main`; isso não muda o fluxo externo.
- For your own installation, choose **Use this template**. To contribute back,
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

Ao participar, você concorda com o [Código de Conduta](CODE_OF_CONDUCT.md).
Security findings follow [SECURITY.md](SECURITY.md), never a public issue.
