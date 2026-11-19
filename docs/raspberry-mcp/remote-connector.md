# Conector remoto do Claude (Tailscale Funnel + OAuth)

O app e a web do Claude só aceitam um conector remoto: uma **URL HTTPS pública** que os
servidores da Anthropic chamam, com OAuth. O túnel que atende o ChatGPT é diferente: o
Raspberry abre uma conexão de saída e não há URL pública. Por isso o transporte local
([`portable-http`](installation.md#preparar-o-transporte-http-opcional)), que só escuta em
`127.0.0.1` e usa uma chave fixa, não serve ao Claude sozinho.

Este pacote opcional, [`remote-edge`](../../scripts/raspberry-mcp/remote-edge/edge.py), acrescenta
a camada que falta. Não foi ativado; o estado versionado é "preparado, não ativado".

```
Claude (Anthropic) ──HTTPS──> Tailscale Funnel ──> edge 127.0.0.1:8766 ──> gateway 127.0.0.1:8765 ──> socket MCP
                                                    OAuth + lista de ferramentas
```

## O que o edge faz

- Publica os metadados OAuth, o registro dinâmico de clientes, `/authorize`, `/token` e `/mcp`.
- Aceita registro somente com os retornos do Claude (`https://claude.ai/api/mcp/auth_callback` e
  `https://claude.com/api/mcp/auth_callback`), até 20 clientes.
- Exige PKCE `S256`. O proprietário se identifica com **senha e código TOTP** (autenticador).
  O código vale uma vez; cinco falhas bloqueiam a autorização por 15 minutos, sem afetar tokens já emitidos.
- Emite acesso de 1 h e renovação de 30 dias, com rotação. Guarda só hashes em
  `/var/lib/raspberry-mcp-edge/state/store.json`.
- Encaminha ao gateway local apenas `initialize`, `tools/list`, `tools/call`, `ping` e a notificação
  `initialized`, e só estas ferramentas **somente leitura**: `service_health`, `service_versions`,
  `disk_space`, `backup_results`, `log_summary`, `maintenance_capabilities`, `host_diagnostics`,
  `service_diagnostics`, `operation_status`, `events_status`, `admin_action_status`.
  Edição, reinício, aplicação de mudança, tarefas Codex, ações administrativas e leitura de arquivos
  são recusados antes de chegar ao gateway. Para ampliar a lista, altere `ALLOWED_TOOLS` e revise
  de novo (o teste confere que cada ferramenta liberada é somente leitura no catálogo).
- Nunca repete uma chamada. Resposta incerta devolve 504 e exige consultar a operação original.
- Não registra URLs, códigos, tokens nem corpos. Roda sem root, sem Docker e sem acesso a `/mnt/data/docker`.

## Limites

- A segurança depende da senha, do autenticador e de manter o Funnel só para a porta 8766.
- O gateway tem uma sessão por vez. Um novo `initialize` do Claude fecha a anterior.
- Sem Funnel (`tailscale funnel reset`) ou sem o serviço, o conector para na hora.
- Não testado contra o Claude real antes da ativação; declarar suporte só depois de uma conexão bem-sucedida.

## Preparar e ativar

Pré-requisitos: o gateway `portable-http` instalado e ativo
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
sudo /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp-edge/edge_admin.py revoke-all   # esquece clientes e tokens
```

Trocar a senha ou o autenticador: `set-owner` de novo e reiniciar o serviço. Rotacionar a chave do
gateway segue [installation.md](installation.md); reinicie o edge depois.

## Validar

```sh
./scripts/run-resource-safe.sh python3 -B -m unittest discover -s scripts/raspberry-mcp/remote-edge -p 'test_*.py'
python3 scripts/raspberry-mcp/remote-edge/build_release.py   # após qualquer mudança, antes de preparar
```
