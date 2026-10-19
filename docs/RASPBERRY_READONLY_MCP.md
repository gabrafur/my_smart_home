# MCP de leitura do Raspberry — preparado, não ativado

## Estado e limite

Implementação stdio sem dependências em `scripts/raspberry-mcp/`, testes em
`scripts/raspberry-mcp.test.mjs`. Não instala serviço, não abre listener, não cria
credenciais, não instala túnel nem altera Compose, Node-RED ou Home Assistant.
A ativação remota exige configuração autenticada na conta e validação pelo
ChatGPT. Aprovação operacional não substitui login, chave ou acesso administrativo.

A inspeção dos serviços existentes encontrou o bridge de IA, o monitor remoto
Codex, produtores de saúde do Raspberry e workers de backup. Nenhum deles foi
convertido em terminal remoto ou reconfigurado. O novo adaptador lê o resultado
do worker de backup existente; não dispara backup. O acesso remoto do Codex não
significa que um plugin esteja disponível numa conversa ChatGPT.

## Arquitetura proposta para aprovação

Fluxo: coletor local → snapshot sanitizado → MCP stdio isolado → tunnel-client
no Raspberry → HTTPS de saída para OpenAI → plugin privado na conta ChatGPT.

- Provedor: OpenAI Secure MCP Tunnel. Destino de saída: `api.openai.com:443`,
  caminho `/v1/tunnel/*`. Nenhum ingresso público, proxy público, Tailscale,
  alteração de firewall, SSH, sudo ou dependência de outro computador.
- Coletor: comando fixo `node scripts/raspberry-mcp/collect.mjs`, com as permissões
  locais já existentes. Usa apenas inspect/logs dos três containers permitidos,
  statfs do volume do projeto e o arquivo de resultado do backup Git. O acesso
  local ao socket Docker é privilegiado mesmo para essas chamadas: ele nunca
  deve ser concedido ao MCP nem ao tunnel-client.
- Após aprovação, propor um timer systemd de 5 minutos para o coletor, com
  limite total de 15 segundos, CPU de baixa prioridade e memória de 64 MiB.
  Publicação atômica do snapshot em `/run/raspberry-mcp/snapshot.json`, em tmpfs,
  propriedade do coletor e leitura pelo consumidor; sem escrita pelo consumidor.
- MCP: unidade systemd `raspberry-mcp@.service`, ativada por socket Unix
  `raspberry-mcp.socket` em `/run/raspberry-mcp/mcp.sock`; StandardInput e
  StandardOutput ligados ao socket, Accept=yes. RootDirectory mínima em
  `/var/lib/raspberry-mcp/root`, com Node e bibliotecas indispensáveis, código e
  snapshot montados somente para leitura. Usuário próprio sem privilégios,
  PrivateNetwork=yes, NoNewPrivileges=yes, capabilities vazias,
  ProtectSystem=strict, limite de 64 MiB/32 tarefas e RuntimeMaxSec=120.
  Sem checkout, diretórios pessoais, socket Docker ou credenciais.
- Tunnel-client: unidade `raspberry-mcp-tunnel.service`, usuário próprio;
  stdio pelo relay fixo `relay.py`, que conecta somente ao socket Unix acima.
  O relay usa Python padrão; não exige instalar socat nem aceita argumentos.
  Socket 0660 acessível somente ao grupo privado do túnel. O MCP não é filho do
  cliente e não herda sua chave. Somente o cliente tem saída HTTPS para OpenAI.
  Nenhum dos dois recebe acesso a Docker. Após aprovação, validar dependências
  ARM64, sandbox e unidades antes de habilitar o polling externo.
- Autenticação proposta: chave de runtime OpenAI restrita a Tunnels Read + Use,
  associação apenas à organização e ao workspace pessoais aprovados; sem OAuth
  adicional no servidor stdio, que não terá endereço de rede. Essa escolha
  autoriza usuários com acesso ao túnel/plugin a ver os cinco resultados.
  Se houver compartilhamento, revisar OAuth e identidade individual antes de
  ampliar o acesso. O túnel autentica o transporte; não inventar identidade do
  usuário final na auditoria local.
- Segredos: inseridos pelo operador em entrada local segura/gestor de segredos;
  nunca argumentos, chat, repositório ou logs. Credencial disponível somente ao
  processo tunnel-client, não herdada pelo MCP. Nenhuma chave foi criada.
- Auditoria: JSON em stderr, apenas horário, ferramenta conhecida e resultado.
  O instalador usa namespace journald exclusivo, teto de 6 MiB, arquivos de
  até 2 MiB e retenção de 7 dias, sem payload, ID da requisição, saída ou erro bruto.
  Falha de escrita encerra o atendimento. O snapshot não é arquivado.

O instalador local está preparado; sua presença no Git não comprova que as
unidades tenham sido instaladas ou que o isolamento tenha sido validado no host.

## Contrato disponível

| Ferramenta | Dados |
| --- | --- |
| `service_health` | Estado Docker e healthcheck de homeassistant, nodered e mosquitto |
| `service_versions` | Versão numérica de labels explícitas da imagem ou tag; null quando não comprovada |
| `disk_space` | Bytes totais e disponíveis no filesystem do projeto |
| `backup_results` | Status e horário do último resultado do worker Git; offsite desconhecido |
| `log_summary` | Contagens em até 100 linhas por serviço nos últimos 15 minutos |

Todas exigem `host: raspberry`; log_summary também exige `service` da enumeração.
Nenhuma aceita caminho, URL, IP, comando, regex, nome livre ou host adicional.
Os logs são uma amostra, não prova de ausência de erros nem eventos únicos.
Não há texto livre, mensagens de calendário, dados de dispositivos ou nomes de
pessoas nas respostas. A lista de saída é reconstruída mesmo se o snapshot
contiver campos privados inesperados. Campos inválidos viram null/unknown.
O horário de observação acompanha todas as respostas: snapshot antigo não é
uma consulta ao vivo. Arquivo ausente ou inválido retorna erro seguro.

Limites: 16 KiB de entrada por mensagem/snapshot, 60 mensagens/minuto por processo,
requisições sequenciais, respostas de formato fixo e tamanho limitado, Docker
com timeout de 1,5 segundo e buffer de 64 KiB por chamada. Nenhuma chamada MCP
executa coleta, subprocesso ou rede. O protocolo mínimo implementa initialize,
ping, tools/list, tools/call e notifications/initialized; não oferece recursos,
prompts, escrita ou paginação. Auditoria não contém argumentos, erros brutos ou
identidade do usuário. Testes de conformidade com o tunnel-client ainda pendentes.

## Lista de hosts e expansão

| Host lógico | Operações | Situação |
| --- | --- | --- |
| raspberry | As cinco leituras acima | Código preparado; acesso remoto pendente |
| workstation_primary | Eventual saúde, versão e disco | Não autorizado; nenhuma implementação/acesso |

Não há descoberta de rede. Cada computador futuro exige identificação explícita,
permissões por operação, método de autenticação, destino e revogação aprovados
separadamente. Não reutilizar credenciais encontradas. Não acordar computadores.

## Documentação oficial e compatibilidade

Fontes consultadas em 2026-10-18:

- [Conectar e testar](https://developers.openai.com/plugins/deploy/connect-chatgpt).
- [Adicionar MCP ao ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server).
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
- [Migração de GPTs personalizados](https://learn.chatgpt.com/docs/migrate-custom-gpts).

O ChatGPT web permite adicionar MCP como plugin, sujeito às permissões da conta,
workspace e restrições de segurança. A documentação atual consultada não fornece
uma matriz exaustiva de planos; não prometer disponibilidade por nome de plano.
Transporte remoto suporta SSE/streaming HTTP; o túnel também encaminha a servidor
local stdio. Autenticação da conexão pode usar OAuth ou ausência de OAuth.

Criar/editar túnel exige Tunnels Read + Manage na organização Platform; executar
cliente e selecionar túnel exigem Read + Use. Associar o workspace correto.
Essas permissões são distintas das permissões de instalar/usar plugins ChatGPT.

Se a assistente for uma conversa/fluxo Work com plugins, instalar e selecionar o
plugin nessa superfície. Se for um GPT personalizado legado, não presumir que
adicionar MCP à conta o altera: a documentação de migração Enterprise orienta
migrar para plugin e reconstruir ações. Confirmar modalidade e conta antes de
expor qualquer serviço; não migrar a assistente sem autorização própria.
Não há comprovação de acesso desta conversa à conta da assistente.

## Ativação após aprovação

### Instalação administrativa local

O instalador `scripts/raspberry-mcp/install-local.py` precisa ser executado pelo
operador em terminal próprio, onde sudo solicita sua senha sem passar pelo chat:

```bash
cd /mnt/data/docker
sudo python3 scripts/raspberry-mcp/install-local.py
```

Se a primeira instalação parou na sonda `chroot` com `SIGABRT`, o Node do
Debian pode precisar do builtin externo `minimatch`, agora incluído no
isolamento. Retome a instalação parcial com:

```sh
sudo python3 scripts/raspberry-mcp/install-local.py --resume-partial
```

A retomada exige código instalado idêntico ao atual, arquivos de propriedade
root sem escrita por grupo/outros, identidades restritas e ausência das
unidades systemd. Não adota uma instalação já ativa. A sonda tem limite de
15 segundos e apresenta diagnóstico limitado antes de habilitar serviços.


Ele cria somente os dois usuários de serviço, a raiz mínima do MCP, um socket
Unix e o coletor com timer. Não muda grupos do operador, sudo, firewall ou
serviços residenciais. Não baixa pacotes nem configura túnel/chave. Usa as
permissões Docker já existentes do usuário que invoca sudo para o coletor;
a identidade MCP não recebe essas permissões. Antes de habilitar serviços,
confere cinco ferramentas dentro do chroot e valida as unidades systemd.
Instalação existente causa recusa, sem sobrescrever configuração. Falha de
pré-validação pode deixar arquivos/usuários preparados, mas nenhum serviço
habilitado; nesse caso revisar a falha antes de repetir ou limpar os artefatos.

O cliente oficial pode ser preparado em diretório privado do operador a partir
da release oficial, validando o ZIP ARM64 contra SHA256SUMS da mesma release.
Não versionar binário, perfil, chave ou configuração da conta. Não usar o
cloudflared incluído no pacote: o caminho aprovado é o polling OpenAI.

Depois da instalação local, verificar socket, permissões, uma chamada de leitura
com horário e a saúde dos serviços existentes. Somente então configurar o
cliente com o tunnel_id real e chave restrita, inserida por entrada oculta local.
O comando filho deve limpar o ambiente antes do relay; o servidor MCP é iniciado
pelo systemd e não herda a chave do cliente. A unidade persistente do túnel deve
ser configurada depois da verificação da conta; não foi gerada pelo instalador.

Testes adicionais do instalador (sintéticos, sem root):

```bash
./scripts/run-resource-safe.sh python3 -m unittest discover -s scripts/raspberry-mcp -p 'test_*.py'
```

### Conexão na conta

1. Confirmar modalidade da assistente e presença de Add custom MCP server/Tunnel
   em [ChatGPT Plugins](https://chatgpt.com/plugins). Se indisponível, parar;
   não substituir por endpoint público como contorno.
2. Revisar manifesto final de isolamento e privilégios, e aprovar a instalação.
3. Em [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels),
   criar/reusar túnel restrito e associar a organização/workspace corretos.
   Inserir a chave de runtime por interface local segura.
4. Baixar cliente oficial indicado nessa página, verificar suporte ARM64 e
   integridade, consultar `tunnel-client help quickstart`. Não houve download.
5. Configurar perfil stdio apontando somente ao servidor isolado; executar doctor
   e verificar polling. Não usar modo que herde segredos no processo filho.
6. ChatGPT Plugins → + → Add custom MCP server → nome `Raspberry leitura` →
   Connection: Tunnel → selecionar o túnel real → autenticação conforme aprovada →
   revisar aviso → Create as a plugin. Instalar e iniciar conversa com @plugin.
7. Conferir cinco ferramentas; chamar disk_space com host raspberry. Conferir
   horário e números com snapshot. Testar host não permitido sem acesso real.
8. Registrar conexão concluída somente após consulta efetiva pela assistente.

Não existe link de autorização gerado nesta etapa. Os links acima são páginas
oficiais de configuração, não URLs de uma integração já criada.

## Testes e reversão

`./scripts/run-resource-safe.sh node --test scripts/raspberry-mcp.test.mjs`
usa fontes sintéticas; cobre lista, ciclo stdio, entradas maliciosas, hosts e
serviços negados, projeção, falhas parciais, auditoria, tamanho e taxa.
Uma execução manual autorizada do coletor pode verificar as fontes locais, sem
iniciar serviços ou salvar runtime no Git. Não confundir isso com teste ChatGPT.

Antes de ativar: remover apenas os arquivos desta mudança reverte a preparação.
Após ativar: parar/desabilitar somente timer/coletor e tunnel-client novos,
remover/desconectar o plugin ChatGPT, revogar chave e associações/túnel na Platform,
remover snapshot tmpfs e configuração privada; conservar auditoria pelo prazo
aprovado e depois eliminá-la. Não reiniciar stack nem apagar histórico residencial.

Commit deve conter somente código/testes/documentação sanitizados desta tarefa.
O hook pre-push exige árvore limpa; alterações concorrentes impedem publicação
até sua resolução pelo responsável. Não fazer stash, commit ou revert delas,
não usar force push nem ignorar o hook. CI só poderá ser observado após push.
