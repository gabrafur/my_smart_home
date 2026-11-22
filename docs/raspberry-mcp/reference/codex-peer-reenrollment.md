# Reinscrição do executável Codex após atualização

O atestador `raspberry-task-peer-attest` refaz a prova do peer de controle de
tarefas a cada minuto e fixa o executável exato (`executable_sha256` e
`executable_size`) do processo `app-server` que atende o socket. Reinício do
app-server ele resolve sozinho. Uma versão nova do Codex, instalada pela etapa
noturna `codex-cli`, troca o binário: sem reinscrição, o atestador recusa e a
retomada de tarefas fica bloqueada com `control_socket_changed` (caso de
21/11/2026, Codex 0.171.0).

## O que o serviço faz

`raspberry-task-peer-reenroll.timer` roda a cada cinco minutos o serviço fixo
`scripts/raspberry-mcp/codex-peer-reenroll/reenroll.py`, instalado como Root em
`/usr/local/lib/raspberry-task-peer-reenroll/`. Ele só altera
`daemon_identity.executable_sha256/executable_size` de
`/etc/raspberry-task-control/peer-attestor-enrollment.json` quando, ao mesmo tempo:

- o processo que realmente atende o socket (SO_PEERCRED) passa nas mesmas
  checagens do atestador: caminho, dono, grupo, modo, cgroup e papel
  `app-server`;
- o executável dele é idêntico, byte a byte, ao binário `linux-arm64` que o
  registro público npm publica para a versão instalada. O tarball é baixado na
  hora e conferido contra o `integrity` sha512 do registro antes de o binário
  interno ser hasheado.

Nada escrito pelo usuário da casa (lockfile, resultado da etapa) serve como
procedência: o `package.json` instalado só escolhe qual versão conferir. Todos os
outros campos do enrollment, inclusive a aprovação do proprietário, ficam
idênticos. A troca é atômica, sob o lock do atestador, com nova checagem do peer
e do arquivo imediatamente antes. O enrollment anterior fica em
`/var/lib/raspberry-task-peer-reenroll/previous/` (últimos dez).

O serviço não escreve a prova: o próprio atestador refaz o pin por CAS no
minuto seguinte e mantém a prova anterior se algo falhar. Nada é reiniciado.

## Falhas e estado

`/var/lib/raspberry-task-peer-reenroll/status.json` e o journal da unidade
mostram `current`, `reenrolled`, `refused` (com motivo), `failed` ou `backoff`.
Registro indisponível aguarda 30 min antes de tentar o mesmo binário de novo;
binário diferente do publicado (`live_binary_differs_from_registry`) aguarda 6 h
e nunca é inscrito: isso exige investigação, não repetição. O hash completo do
executável só é recalculado quando inode, tamanho ou horários mudam.

## Instalação, prova e reversão

`install.py` é o operador Root revisado (prepare, apply, verify, status,
rollback), com as fontes fixadas por sha256. `verify` roda o serviço uma vez e
exige `current`; `status` baixa o pacote do registro e prova, sem escrever, que o
binário inscrito é o publicado (`provenance_confirmed`). `rollback` desativa o
timer e remove só os arquivos instalados, preservando estado e enrollments
anteriores. Ao alterar `reenroll.py` ou as unidades, atualize os pinos de
`install.py` e reinstale por um novo operador.

O socket e o `package.json` do Codex são resolvidos na home do `host_operator`,
obtida do `executable_uid` do próprio enrollment selado; nenhuma conta é
rastreada. A unit é um template: `ConditionPathExists` é renderizado na
instalação (`RASPBERRY_HOST_OPERATOR` ou `SUDO_USER`). Uma instalação anterior
migra com o operador de [papéis lógicos do host](host-identity-roles.md).
