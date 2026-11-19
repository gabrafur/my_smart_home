# Prompt: instalar o conector remoto do Claude

Prompt reutilizável para uma sessão do Claude Code aberta em `/mnt/data/docker`. Foi usado em
19/11/2026 e funcionou de ponta a ponta; esta versão incorpora o que faltou naquela execução
(verificar o Tailscale antes de pedir ação, explicar o autenticador, não gravar o nome da tailnet).
O guia técnico é [remote-connector.md](../remote-connector.md). Cole o bloco abaixo:

````text
Instale (ou reinstale, ou confira) o conector remoto do MCP do Raspberry para o Claude usar por
URL pública, seguindo docs/raspberry-mcp/remote-connector.md e docs/raspberry-mcp/installation.md,
a partir de /mnt/data/docker.

Regras: responda em português do Brasil. Publique só na main, sem pull request. Não use
--no-verify. Não rode backup, update, reinício geral ou limpeza. Nunca acione o portão, fechaduras
nem alarme. Não escreva senha, chave, token, segredo do autenticador, URL privada, nome da tailnet
(o sufixo .ts.net), nome do nó nem endereço IPv4 privado no chat, no Git ou em logs; ao citar a URL
do conector, entregue-a só a mim e não a grave em arquivos versionados. Antes de qualquer nova
tentativa de uma operação, consulte o resultado da original. Cada passo é idempotente: se já
estiver feito e conferido, diga "já feito" e siga, sem refazer.

Passos, na ordem. Pare e peça minha ação só onde indicado:

1. Estado. `git pull` limpo; `systemctl is-active raspberry-mcp.socket raspberry-mcp-http raspberry-mcp-edge`;
   existência (sem ler o conteúdo) de /var/lib/raspberry-mcp-http/token, /var/lib/raspberry-mcp-edgekey/token,
   /var/lib/raspberry-mcp-edge/owner.json e config.json; `tailscale funnel status`.
   Rode os testes: `python3 -B -m unittest discover -s scripts/raspberry-mcp/portable-http -p 'test_*.py'`
   e o mesmo em scripts/raspberry-mcp/remote-edge; rode os dois build_release.py e confirme que
   release.json não mudou (git status limpo). Se os arquivos instalados em /usr/local/lib/raspberry-mcp-* forem
   diferentes dos do repositório, é uma ATUALIZAÇÃO: siga a seção "Atualizar uma instalação existente" do guia.
2. Gateway. Se raspberry-mcp-http não estiver instalado e ativo, prepare e ative conforme a seção
   "Preparar o transporte HTTP opcional" de installation.md (staging em /run, instalador root, recibo
   prepared_not_activated, systemd-analyze verify, daemon-reload, enable --now). Ele cria a chave restrita
   do edge e o grupo raspberry-mcp-edgekey. Confira que escuta só em 127.0.0.1:8765. Não leia o conteúdo
   de nenhuma chave.
3. Tailscale. Confira antes, sem alterar nada: `tailscale status --json` deve trazer em Self.CertDomains um
   nome e em Self.Capabilities os itens https e funnel. Se já tiver, diga "já habilitado" e pule o resto
   deste passo. Se faltar, me peça (ou, se a extensão Claude in Chrome estiver conectada, faça no navegador,
   mas eu faço o login: você nunca digita senha nem código): (a) painel de administração do Tailscale →
   DNS → ligar MagicDNS e "Enable HTTPS"; (b) Access controls → bloco nodeAttrs com o atributo "funnel" para
   este nó (melhor que para todos os membros). Mostre o trecho exato da política e só salve com a minha
   aprovação, porque ela vale para a tailnet inteira. Depois repita a conferência.
4. Edge. Staging em /run/raspberry-mcp-edge-review e
   `sudo /usr/bin/python3 -I -S -B /run/raspberry-mcp-edge-review/install.py`. O recibo deve dizer
   prepared_not_activated. Se recusar por arquivo diferente, é atualização (passo 1), não force.
5. URL pública. Pegue o nome do nó em `tailscale status --json` (Self.DNSName, sem o ponto final) e rode
   edge_admin.py configure https://<esse nome>. Não escreva o nome em arquivos versionados.
6. PARE e me peça: eu rodo no meu terminal
   `sudo /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp-edge/edge_admin.py set-owner`,
   escolho a senha (16+ caracteres) e CADASTRO A "Manual key" NUM APP AUTENTICADOR (adicionar conta →
   inserir chave de configuração → tipo baseado em tempo); só então o app mostra os códigos de 6 dígitos.
   Você não vê nem guarda a senha nem a chave. Lembre-me disso, porque a chave sozinha não é um código.
   Só continue quando eu confirmar. Se já houver owner.json e eu não quiser trocar, pule.
7. Ativar. systemd-analyze verify, daemon-reload, `enable --now raspberry-mcp-edge.service`. Confira
   http://127.0.0.1:8766/.well-known/oauth-authorization-server (200) e que o edge escuta só em
   127.0.0.1:8766. Só então `sudo tailscale funnel --bg 8766` e confira a mesma rota pela URL pública (200),
   que POST /mcp sem token devolve 401 e que `tailscale funnel status` mostra só a porta 8766.
8. PARE e me entregue, só no chat, a URL https://<nome>/mcp para eu adicionar em Claude → Configurações →
   Conectores → Adicionar conector personalizado. Diga o que esperar: abre a página de autorização com o aviso
   "NUNCA autorizado antes" (normal no primeiro uso); eu digito a senha e o código atual do autenticador (só
   ali, nunca no chat). Senha errada não bloqueia; cinco códigos errados com a senha certa bloqueiam 15 min.
   Se o código for recusado, suspeite do relógio do celular (hora automática).
9. Verificação ponta a ponta, depois que eu confirmar a conexão: faça uma chamada de service_health (ou
   outra ferramenta do conector) e confira que só aparecem as 11 ferramentas somente leitura, sem change_apply,
   operation_submit, codex_* nem project_*.
10. Registro. Atualize "Resultado da ativação" em docs/raspberry-mcp/remote-connector.md (data, o que foi
    testado, o que não), sem nome de tailnet, commite com Conventional Commits em inglês (confira com
    node scripts/commit-message-check.mjs --subject), publique com
    `python3 scripts/git-publication-evidence.py publish` e depois `observe`, e confira
    `gh run list --branch main`. Se o publish falhar por memória (evidence_changed), revalide a fonte,
    reconstrua o commit sobre origin/main e publique de novo; nunca reenvie sem conferir o remoto.

Se qualquer passo falhar, pare, mostre o erro sem segredos e não repita sem consultar o estado.
Para desfazer: `sudo tailscale funnel reset`, `sudo systemctl disable --now raspberry-mcp-edge.service`
e `edge_admin.py revoke-all`.
````
