# Política de segurança / Security policy

## Relato responsável / Responsible disclosure

Não publique uma issue com vulnerabilidades, segredos, dados residenciais ou
instruções de exploração. Use o recurso **Report a vulnerability** na aba
Security do GitHub quando ele estiver habilitado. Até essa configuração manual
ser concluída, contate o mantenedor pelo perfil público do GitHub e compartilhe
detalhes somente após combinar um canal privado.

Do not open a public issue containing vulnerabilities, secrets, household
data, or exploitation steps. Use GitHub's **Report a vulnerability** flow when
enabled. Until the owner completes that manual setting, contact the maintainer
through the public GitHub profile and share details only after agreeing on a
private channel.

Inclua apenas / Include only:

- componente e revisão afetados / affected component and revision;
- impacto e pré-condições, sem dados reais / impact and prerequisites without
  real data;
- reprodução mínima com fixtures sintéticas / minimal reproduction using
  synthetic fixtures;
- mitigação sugerida, se conhecida / suggested mitigation, if known.

Apague tokens e artefatos locais antes de anexar conteúdo. Nunca envie `.env`,
`secrets.yaml`, `.storage`, flows de credenciais, backups, mapas, logs de
presença ou bundles de restore. Remove tokens and local artifacts before
attaching content. Never send private runtime or restore bundles.

## Escopo suportado / Supported scope

A revisão suportada é o HEAD atual de `main`. Integrações vendorizadas também
devem ser reportadas ao upstream quando o problema existir sem as modificações
locais; consulte [proveniência](docs/DEPENDENCY_PROVENANCE.md). The supported
revision is the current `main` HEAD. Report unmodified upstream issues to their
original project as well.

## Resposta / Response

O mantenedor fará triagem, confirmará um canal seguro e coordenará correção e
divulgação conforme disponibilidade; nenhum SLA é prometido. O repositório não
é um serviço gerenciado nem um sistema de emergência. The maintainer will
triage, establish a safe channel, and coordinate remediation and disclosure as
available; no SLA is promised. This is not a managed service or emergency
system.
