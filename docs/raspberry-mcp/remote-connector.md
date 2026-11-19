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

Para repetir a instalação com uma sessão do Claude Code, use o prompt salvo em
[prompts/instalar-conector-remoto.md](prompts/instalar-conector-remoto.md). Os passos abaixo são a base dele.

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

### Tailscale (Funnel e HTTPS)

Confira antes de pedir qualquer ação: `tailscale status --json` deve ter `Self.CertDomains` e, em
`Self.Capabilities`, `https` e `funnel`. Se faltar:

- painel de administração (login.tailscale.com/admin) → **DNS**: ligar MagicDNS e **Enable HTTPS**;
- **Access controls**: um bloco `nodeAttrs` com `"attr": ["funnel"]`. Prefira o próprio nó (ou uma tag)
  a `autogroup:member`. A política vale para a tailnet inteira: revise o trecho antes de salvar.

Em 19/11/2026 a política já tinha o atributo para `autogroup:member` e o HTTPS já estava ligado, então
nada precisou ser salvo. O login no painel é sempre do proprietário.

### Senha e autenticador

`set-owner` roda no terminal do proprietário e mostra uma **Manual key** (e um `otpauth://`). Ela **não é
um código**: cadastre-a num app autenticador (adicionar conta → inserir chave de configuração → baseado em
tempo). O app passa a mostrar o código de 6 dígitos que a página de autorização pede, e ele muda a cada
30 s e vale uma vez. Se o código for recusado com a senha certa, confira a hora automática do celular.
Perdeu a chave ou a senha: rode `set-owner` de novo (apaga os tokens e reinicia o edge se ativo).

No Claude: Configurações → Conectores → Adicionar conector personalizado →
`https://NOME.TAILNET.ts.net/mcp`. Entre com a senha e o código do autenticador quando a página abrir.

## Acesso web do Home Assistant para a Eva (tailnet, HTTPS)

O Home Assistant só serve HTTP puro na porta 8123, então um endereço HTTPS dava erro de certificado. Desde
19/11/2026 há um endereço HTTPS **só da tailnet**, em `https://<nome do nó>.<tailnet>.ts.net:8443/` (o nome fica
fora do Git; `tailscale status --json`, campo `Self.DNSName`). Funciona em qualquer dispositivo da tailnet; a
internet pública não alcança a 8443 (o Funnel segue só na porta 443, para o conector do Claude).

- **Como é publicado:** `tailscale serve --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:8123`. O Tailscale termina o
  TLS com o certificado do nó e repassa TCP puro ao Home Assistant, sem cabeçalhos HTTP. A variante `serve https`
  (proxy HTTP) devolveu 400: o Home Assistant 2026.11.2 continuou tratando o `X-Forwarded-For` como proxy não
  configurado mesmo com `http.use_x_forwarded_for` e `trusted_proxies` válidos no `check_config`, então a
  configuração foi revertida. Com TCP puro o Home Assistant vê o cliente como `127.0.0.1`.
- **Usuário:** `eva-web`, **sem administração**, grupo `system-users`, `local_only` desligado (endereços da tailnet
  não contam como rede local). A senha foi gerada na máquina e está em `.local-secrets/eva-ha-web-password.txt`
  (modo 600, fora do Git); o proprietário a entrega à Eva por um canal seu, nunca por chat ou Git.
- **Limite importante:** o Home Assistant não restringe um usuário por entidade. Quem entra consegue acionar
  entidades da interface, incluindo as sensíveis (portão, fechaduras, alarme). O acesso da Eva é para **ler
  painéis**; acionar equipamentos continua dependendo das autorizações específicas do proprietário, e o portão
  nunca é acionado.
- **Do próprio Raspberry** o nome público resolve para o Funnel e a 8443 é recusada; teste por um dispositivo da
  tailnet, ou com `curl --resolve <nome>:8443:$(tailscale ip -4) https://<nome>:8443/`.
- **Desligar:** `sudo tailscale serve --tls-terminated-tcp=8443 off` e, se quiser, remover o usuário `eva-web` em
  Configurações → Pessoas.

## Atualizar uma instalação existente

O `install.py` recusa arquivos diferentes dos instalados, de propósito. Para publicar uma versão nova do
edge ou do gateway: rode `build_release.py` e os testes, revise o diff, copie o pacote para o staging em `/run`
como na instalação, **pare o serviço**, substitua os arquivos em `/usr/local/lib/raspberry-mcp-edge/` (ou
`-http/`) e a unidade em `/etc/systemd/system/` conferindo os hashes de `release.json`, rode `daemon-reload`
e inicie de novo. Mudanças de código do edge não alteram credenciais nem tokens (o `store.json` é mantido).

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
- Reconexão do Claude depois de 60 s de ociosidade (o gateway encerra a sessão).

A URL pública contém o nome da tailnet e fica fora do Git.
