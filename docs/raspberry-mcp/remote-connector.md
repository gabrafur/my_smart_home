# Conector remoto do Claude (Tailscale Funnel + OAuth)

O app e a web do Claude só aceitam um conector remoto: uma **URL HTTPS pública** que os
servidores da Anthropic chamam, com OAuth. O túnel que atende o ChatGPT é diferente: o
Raspberry abre uma conexão de saída e não há URL pública. Por isso o transporte local
([`portable-http`](installation.md#preparar-o-transporte-http-opcional)), que só escuta em
`127.0.0.1` e usa uma chave fixa, não serve ao Claude sozinho.

Este pacote opcional, [`remote-edge`](../../scripts/raspberry-mcp/remote-edge/edge.py), acrescenta
a camada que falta. Foi ativado em 2026-11-19 (ver [Resultado da ativação](#resultado-da-ativação)); o pacote versionado continua sendo instalado por `install.py` em modo "preparado, não ativado".

```
Claude (Anthropic) ──HTTPS──> Tailscale Funnel ──> edge 127.0.0.1:8766 ──> gateway 127.0.0.1:8765 ──> socket MCP
                                                    OAuth + lista de ferramentas
```

## O que o edge faz

- Publica os metadados OAuth, o registro dinâmico de clientes, `/authorize`, `/token` e `/mcp`.
- Aceita registro somente com os retornos do Claude (`https://claude.ai/api/mcp/auth_callback` e
  `https://claude.com/api/mcp/auth_callback`), até 100 clientes. Cliente que nunca recebeu token expira
  em 1 h e é o primeiro a ser removido quando o teto enche; clientes com token nunca são removidos por isso.
- Exige PKCE `S256` e, se vier, `resource` igual à URL do próprio `/mcp`. O proprietário se identifica com
  **senha e código TOTP** (autenticador). O código vale uma vez, mesmo após reinício. Senha errada nunca
  bloqueia ninguém (só há limite de 10 tentativas por minuto, para qualquer chamador); cinco erros de código
  **depois de a senha estar certa** bloqueiam a autorização por 15 minutos. Assim um anônimo não consegue
  trancar o dono para fora. A página de autorização mostra há quanto tempo o cliente foi registrado e avisa
  quando ele nunca foi autorizado.
- Emite acesso de 1 h e renovação de 30 dias, com rotação. Reapresentar um refresh já usado revoga todos os
  tokens do cliente. Guarda só hashes em `/var/lib/raspberry-mcp-edge/state/store.json`.
- Não guarda a chave completa do gateway. Usa uma **chave restrita** (`/var/lib/raspberry-mcp-edgekey/token`,
  criada pelo instalador do gateway) que o próprio gateway limita às mesmas 11 ferramentas somente leitura.
  Se o edge for comprometido, o atacante continua sem alcançar escrita, reinício ou tarefas Codex.
- Encaminha ao gateway local apenas `initialize`, `tools/list`, `tools/call`, `ping` e a notificação
  `initialized`, e só estas ferramentas **somente leitura**: `service_health`, `service_versions`,
  `disk_space`, `backup_results`, `log_summary`, `maintenance_capabilities`, `host_diagnostics`,
  `service_diagnostics`, `operation_status`, `events_status`, `admin_action_status`.
  Edição, reinício, aplicação de mudança, tarefas Codex, ações administrativas e leitura de arquivos
  são recusados antes de chegar ao gateway. Para ampliar a lista, altere `ALLOWED_TOOLS` e revise
  de novo (o teste confere que cada ferramenta liberada é somente leitura no catálogo).
- No máximo 16 conexões simultâneas (as demais recebem 503 na hora), 5 s de ociosidade por conexão e
  `MemoryMax=96M`; o hash da senha roda no máximo 2 por vez. Um atacante ainda pode ocupar as conexões com
  clientes lentos e atrasar o login; nesse caso feche o Funnel.
- Nunca repete uma chamada. Resposta incerta devolve 504 e exige consultar a operação original.
- Não registra URLs, códigos, tokens nem corpos. Roda sem root, sem Docker e sem acesso a `/mnt/data/docker`.

## Limites

- A segurança depende da senha, do autenticador e de manter o Funnel só para a porta 8766.
- O gateway tem uma sessão por vez. Um novo `initialize` do Claude fecha a anterior (duas conversas
  simultâneas se alternam e, depois de uma pausa de 60 s, o cliente reinicializa sozinho). Se um cliente
  local já ocupa a sessão, o Claude recebe 503. As chamadas são serializadas, com até 15 s por chamada.
- Sem Funnel (`tailscale funnel reset`) ou sem o serviço, o conector para na hora.
- Testado contra o Claude real em 2026-11-19 (ver abaixo).

## Preparar e ativar

Pré-requisitos: o gateway `portable-http` (esta versão, que cria a chave restrita e o grupo
`raspberry-mcp-edgekey`) instalado e ativo
([instalação](installation.md#preparar-o-transporte-http-opcional)), Funnel e certificados HTTPS
habilitados no painel de administração do Tailscale (atributo `funnel` na política da tailnet).

```sh
sudo /usr/bin/install -d -o root -g root -m 0755 /run/raspberry-mcp-edge-review
cd scripts/raspberry-mcp/remote-edge
sudo /usr/bin/install -o root -g root -m 0644 edge.py edge_admin.py raspberry-mcp-edge.service release.json install.py /run/raspberry-mcp-edge-review/
sudo /usr/bin/python3 -I -S -B /run/raspberry-mcp-edge-review/install.py   # recibo: prepared_not_activated
```

Credenciais e URL (no terminal do proprietário, nunca no chat):

```sh
sudo /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp-edge/edge_admin.py set-owner
sudo /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp-edge/edge_admin.py configure https://NOME.TAILNET.ts.net
```

Ativação, nesta ordem:

```sh
sudo /usr/bin/systemd-analyze verify /etc/systemd/system/raspberry-mcp-edge.service
sudo /usr/bin/systemctl daemon-reload
sudo /usr/bin/systemctl enable --now raspberry-mcp-edge.service
curl -fsS http://127.0.0.1:8766/.well-known/oauth-authorization-server
sudo tailscale funnel --bg 8766
curl -fsS https://NOME.TAILNET.ts.net/.well-known/oauth-authorization-server
```

No Claude: Configurações → Conectores → Adicionar conector personalizado →
`https://NOME.TAILNET.ts.net/mcp`. Entre com a senha e o código do autenticador quando a página abrir.

## Desligar e revogar

```sh
sudo tailscale funnel reset                                         # tira da internet
sudo /usr/bin/systemctl disable --now raspberry-mcp-edge.service    # para o edge
sudo /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp-edge/edge_admin.py revoke-all   # para, apaga clientes e tokens e só religa se estava ativo
```

Trocar a senha ou o autenticador: `set-owner` de novo; ele apaga os tokens e reinicia o edge se estiver
ativo. A chave restrita se rotaciona como a do gateway ([installation.md](installation.md)), em
`/var/lib/raspberry-mcp-edgekey/token`; reinicie o gateway e o edge depois.

## Validar

```sh
./scripts/run-resource-safe.sh python3 -B -m unittest discover -s scripts/raspberry-mcp/remote-edge -p 'test_*.py'
python3 scripts/raspberry-mcp/remote-edge/build_release.py   # após qualquer mudança, antes de preparar
```

## Resultado da ativação

Ativado em 2026-11-19 no nó do Raspberry, seguindo este roteiro.

Testado e funcionando:

- Testes do pacote (24) e `build_release.py` sem alterar `release.json`.
- Gateway `portable-http` instalado e ativo só em `127.0.0.1:8765`; edge ativo só em `127.0.0.1:8766`.
- Tailscale: HTTPS/certificados e atributo `funnel` presentes no nó; `tailscale funnel --bg 8766` expõe somente a porta 8766.
- `.well-known/oauth-authorization-server` devolveu 200 pela rota local e pela URL pública; `/mcp` sem token devolveu 401 nas duas.
- Conector adicionado no Claude, login com senha e código do autenticador concluído e uma chamada de `service_health` bem-sucedida (serviços homeassistant e nodered saudáveis).
- A lista de ferramentas exposta ao Claude tem só as 11 somente leitura; `change_apply` e as demais de escrita não aparecem.

Não testado:

- Chamada direta de uma ferramenta de escrita pelo conector para ver a recusa (elas nem aparecem na lista; a recusa é coberta apenas pelos testes unitários).
- Expiração e renovação do token de acesso (1 h), a revogação com `revoke-all` e o bloqueio de 15 minutos por erro de código.
- Duas conversas simultâneas e o comportamento do limite de sessão do gateway.
