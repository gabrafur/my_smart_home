# MCP de leitura do Raspberry

## Validação da conexão e reparo

Em 2026-10-19, a conexão privada foi instalada usando o túnel existente e
autenticação MCP `None`. A autenticação do transporte permanece no cliente do
túnel. Foram listadas as cinco ferramentas e executada `disk_space` com
`host: raspberry` tanto no Codex quanto na conversa do dot destinatário.
O resultado incluiu `observed_at`; trata-se do horário do snapshot.

O reparo aceita `_meta` como objeto de contexto do protocolo, sem incorporá-lo
aos argumentos, respostas ou auditoria. Argumentos extras continuam proibidos.
A sessão stdio é persistente: o relay aguarda dados sem encerrar por inatividade,
e a unidade MCP usa `RuntimeMaxSec=infinity`. Permanecem os limites de memória,
tarefas, tamanho de mensagens, taxa e isolamento de rede. O timeout de conexão
e I/O do socket não foi removido. A sessão sobreviveu ao antigo limite de 120 s.

O aplicador de reparo `apply-protocol-session-repair.py` exige root, confere
hashes e destinos fixos, conserva cópias dos arquivos substituídos e reinicia
somente o túnel. Não reinstalar o conjunto nem reaplicar esse reparo sobre uma
instalação diferente. Os testes direcionados passaram: sete Node e oito Python.

Inicialmente o plugin foi configurado para permitir leituras e pedir confirmação
antes de alterações (`ask_before_writes`). Isso é uma política do cliente ChatGPT:
não acrescenta ferramentas ao servidor nem comprova aprovação na auditoria
local. O contrato original de cinco leituras foi preservado. A ampliação instalada
abaixo acrescenta seis ferramentas com operações e alvos limitados. A preferência
posterior do usuário passou a `Allow all tools`; o catálogo e as restrições do
servidor continuam independentes dessa preferência.

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

## Arquitetura e procedimento de instalação

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
  ProtectSystem=strict, limite de 64 MiB/32 tarefas e RuntimeMaxSec=infinity.
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
identidade do usuário. Leitura ponta a ponta validada com o tunnel-client; isso não cobre todas as condições de reconexão.

## Lista de hosts e expansão

| Host lógico | Operações | Situação |
| --- | --- | --- |
| raspberry | As cinco leituras acima | Leitura remota validada em 2026-10-19 |
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
A validação em 2026-10-19 incluiu a conversa do dot, além da chamada no Codex.

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

Os links acima são páginas oficiais genéricas. O link privado da instalação
foi entregue na conversa; identificadores da conta não são versionados aqui.

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

## Ampliação operacional instalada

`install-operations.py` acrescenta um frontend stdio e um broker privado por
socket Unix. O frontend permanece no chroot sem acesso ao checkout ou Docker;
o broker usa a identidade já existente do coletor, código instalado pertencente
a root e comandos operacionais fixos. Não há listener TCP, downloads, novas
credenciais, host adicional, terminal, comandos ou caminhos livres.

As cinco leituras originais permanecem. Seis ferramentas adicionais:

- `project_files`: lista IDs de arquivos por categoria e paginação.
- `project_read`: lê trechos de fontes admitidas e seu SHA256.
- `project_prepare_edit`: prepara uma substituição textual única com prévia.
- `service_prepare_restart`: prepara reinício de um único container permitido.
- `change_apply`: aplica o identificador preparado, com prazo de uma hora.
- `change_revert`: restaura uma edição se o arquivo ainda corresponder ao resultado.

O catálogo é congelado na instalação a partir de arquivos rastreados, idênticos
ao HEAD público e sem conteúdo reconhecido como credencial. Inclui apenas
Markdown diretamente em `docs/`, JavaScript em `nodered/tools/functions/` e
YAML diretamente em `homeassistant/dashboards/`. Arquivos modificados localmente,
não rastreados, links simbólicos, hardlinks e arquivos fora dessas categorias
não são admitidos. IDs não são caminhos. A edição não aceita criação de arquivo,
remoção, comandos, URLs nem troca de host. A checagem de conteúdo é conservadora,
não uma garantia universal de detecção de segredos: o catálogo público e a
verificação de hash são a fronteira principal.

Aplicar fontes NÃO regenera flows, executa testes, recarrega automações, faz
deploy, commit ou push. Esses passos continuam exigindo os validadores e gates
do projeto; não existe uma ferramenta genérica de execução para contorná-los.
O escopo não inclui custom_components, configurações privadas, instruções,
código do próprio MCP, scripts privilegiados ou dispositivos físicos.

Reinícios afetam exclusivamente `homeassistant`, `nodered` ou `mosquitto`, um por
proposta, via chamada Docker fixa. Há interrupção breve do serviço escolhido.
O instalador e os testes não executam esses reinícios. Não existe reinício global,
exec dentro de container, criação/remoção de container ou operação de volumes.
Resultado incerto de reinício é marcado `outcome_unknown` e não é repetido
automaticamente. O snapshot posterior precisa confirmar a saúde.

Propostas e backups ficam em diretório local 0700 fora do Git, com limite de
64 registros e arquivo de até 256 KiB. Ao atingir o limite, novas propostas são
recusadas: não há limpeza automática de backups. Edições conferem hashes antes
da troca atômica; mudanças concorrentes detectadas são preservadas. A reversão
também exige correspondência do hash. Uma falha após a escrita e antes da
gravação do estado exige inspeção local, sem repetição cega.

O modo de aprovação é controlado pelo ChatGPT. `Allow all tools` dispensa a
confirmação da plataforma, mas não amplia este catálogo nem autoriza operações
fora do pedido. Preparação e aplicação continuam separadas para mostrar a prévia.
A auditoria local registra apenas ferramenta, resultado e horário; não recebe
prova criptográfica de aprovação individual ou identidade do usuário final.

Ativação administrativa, após revisar o código e executar `--check`:

```sh
sudo python3 -B /mnt/data/docker/scripts/raspberry-mcp/install-operations.py
```

O instalador confere hashes do código testado e recusa instalação já existente.
Valida a lista de onze ferramentas no chroot, cria unidades privadas, realiza
uma leitura real do catálogo usando a identidade MCP e reinicia somente o túnel.
Em falha remove os arquivos criados e tenta restaurar o túnel original. Se
houver estado de propostas, conserva-o para inspeção. Não reinstalar às cegas.

Depois de instalar, atualizar as ferramentas no plugin e validar `project_files`,
`project_read` e `disk_space` na conversa destinatária. Não testar uma mutação
residencial real apenas para provar que a ferramenta existe. A ativação não
está comprovada enquanto esses passos não forem concluídos.

### Evidência de ativação em 2026-10-19

Após a execução administrativa local do instalador, o túnel e o socket de
operações foram observados ativos. A lista do plugin foi atualizada para onze
ferramentas (sete leituras, quatro de preparação/escrita). Nome e descrição foram
atualizados para refletir projetos e serviços, conservando o túnel existente.

A conversa destinatária do dot confirmou sucesso real em `project_files`,
`project_read` e `disk_space`. A categoria docs retornou 69 arquivos; a leitura
de `docs/CONVENCAO_COMMITS.md` retornou SHA256 e paginação, sem reproduzir seu
conteúdo na confirmação. O disco retornou `observed_at`. A validação remota
não executou preparação, aplicação, reversão ou reinício residencial.

As mutações foram validadas com fontes e serviços sintéticos: conflito de hash,
links, conteúdo sensível, alvos fora do catálogo, expiração, replay e resultado
incerto de reinício. Foram aprovados 19 testes Python e 11 testes Node.
Não confundir esses testes com execução de mutações na residência. A suíte
pública completa e CI não foram executadas nesta etapa; não houve commit/push.
