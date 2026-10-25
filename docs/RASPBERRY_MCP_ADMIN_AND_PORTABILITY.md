# MCP Raspberry: administração, instalação e outros chatbots

Estado observado em 25/10/2026. Este manual descreve a instalação existente e
a conexão de novos clientes ao mesmo servidor. Não afirma que o instalador
histórico da base reinstala sozinho todas as extensões atuais em outro host.
A [documentação da base e das ampliações anteriores](RASPBERRY_READONLY_MCP.md)
foi preservada como referência operacional e histórica.

## Autoridade e funcionamento

A Eva recebeu a mesma autorização administrativa desta conversa para cumprir a
meta do servidor. A implementação encaminha objetivos administrativos ao executor
local, usando as ferramentas MCP existentes. O cliente pode solicitar diagnóstico,
correção de código, implantação revisada e recuperação de serviços dentro da meta;
não fica limitado ao verificador `repair_health_summary`.

Não há ferramenta MCP de shell livre. O executor local tem acesso administrativo
pela conta já autorizada, e a API recebe objetivos, critérios de aceite e IDs,
não comandos ou configurações de privilégio. A propriedade root do código e das
políticas impede que parâmetros de uma chamada ampliem essa autorização.

O aceite real confirmou UID nativo 1001 e UID administrativo 0. Isso prova a
rota de autoridade; não comprova a conclusão de todas as correções futuras nem
a autonomia proativa de ponta a ponta.

Validade administrativa: **25/10/2026 15:25:22 UTC,com a fração exata preservada na política root**, equivalente a
12:25:22 de Brasília. Instalar outro cliente não estende esse prazo.
Operações dentro da meta não exigem novas aprovações. Extensão temporal exige
autorização específica. Não armazenar senha, exportar credenciais ou executar
novos efeitos residenciais. Preservar custo adicional zero e trabalhos existentes.

A expiração fecha novas criações,envios,preflights e mudanças de perfil.
Consultas das identidades já registradas e reconhecimento de hashes terminais
continuam disponíveis. Essas leituras ainda validam código e políticas root;
uma consulta ao daemon exige o mesmo boot e a identidade de peer aprovada.
Se o peer não puder ser confirmado,um envio em andamento mantém o estado
armazenado com erro de coleta explícito. Isso não o transforma em concluído.
Uma reconciliação de criação que ainda dependa de `resume` permanece bloqueada.
Na listagem,o daemon pode continuar ocioso e capaz de receber entrada enquanto
`adapter_send_admission=closed` e `can_accept_input=false` indicam o bloqueio
real do adaptador. O cursor considera essa mudança de admissão.

## Componentes instalados

As [fontes ativas exportadas](../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json)
permitem auditar as extensões de tarefas,administração,projeções,Events e
instrumentação. O manifesto registra hashes da origem e do arquivo publicado.
Identidades privadas foram substituídas por marcadores e representações de
constantes temporais foram normalizadas sem alterar seus valores. Esse conjunto
é uma captura de fontes com bindings removidos,não um instalador sobre a
política ativa. Políticas,credenciais,bancos e recibos privados não pertencem
ao pacote público. Não copiar esses arquivos diretamente sobre a produção sem
revisar os bindings e atualizar os hashes da política root.

O candidato anterior em `scripts/raspberry-mcp/task-control/` foi preservado.
Ele tem implementação e baseline diferentes,usa `codex_threads_list` e não
deve substituir a versão ativa apenas por estar no mesmo repositório.

| Componente | Local / função |
| --- | --- |
| Frontend MCP | `/var/lib/raspberry-mcp/root/app/`; JSON-RPC e descritores |
| Socket local | `/run/raspberry-mcp/mcp.sock`; acesso por permissões Unix |
| Relay stdio | `/usr/local/lib/raspberry-mcp/relay.py`; destino fixo, sem argumentos |
| Broker de operações | Instâncias `raspberry-mcp-operations@.service` |
| Adaptador de tarefas | `/usr/local/lib/raspberry-task-control/` |
| Projeções e reparo fixo | `/usr/local/lib/raspberry-repair-control/` |
| Executor de inferência | Daemon Codex existente no Raspberry; assinatura incluída |
| Conta administrativa | `codex-house-01a16f9f`; autorização temporária já instalada |
| Transporte remoto atual | OpenAI Secure MCP Tunnel; autenticação existente |
| Auditoria durável | Banco de tarefas, recibos e checkpoint central do plano |

O protocolo entre chatbot e MCP é independente do modelo do cliente. O backend
de tarefas desta instalação continua usando o daemon Codex existente. Trocar o
chatbot cliente não troca esse executor nem cria autorização para API paga.
Trocar também o executor requer um adaptador próprio, revisão e aceite; não
está comprovado nesta instalação.

## Instalar em outro cliente de IA

### Cliente com suporte a stdio no Raspberry

1. Confirmar suporte a MCP stdio e JSON Schema no cliente escolhido.
2. Dar ao processo de conexão uma identidade sem privilégios, autorizada apenas
   a conectar ao grupo do socket `raspberry-mcp`. Não conceder Docker, sudo geral,
   a identidade do tunnel-client ou leitura das suas credenciais.
3. Configurar o processo abaixo como servidor stdio. O formato do invólucro JSON
   depende do cliente; `mcpServers` é uma convenção comum, não uma chave universal.

```json
{
  "mcpServers": {
    "raspberry": {
      "command": "/usr/bin/python3",
      "args": ["-I", "-S", "-B", "/usr/local/lib/raspberry-mcp/relay.py"]
    }
  }
}
```

4. Iniciar `initialize`, enviar `notifications/initialized`, descobrir
   `tools/list` e testar `maintenance_capabilities` com `{"host":"raspberry"}`.
5. Confirmar a identidade autorizada e executar o aceite administrativo abaixo
   antes de confiar correções ao novo cliente.

O relay não é servidor TCP e não recebe host, caminho ou comando do chatbot.
O cliente precisa conseguir iniciar esse processo no Raspberry. O processo de
conexão não precisa de privilégios administrativos; quem aplica a autoridade
aprovada é o executor local por trás do broker.

### Cliente em outra máquina

O socket Unix não é um endereço remoto. Usar um transporte autenticado que leve
o stdio até o relay no Raspberry. Uma implantação por SSH precisa de conta
dedicada, chave mantida exclusivamente no cliente, verificação da chave do host
e comando forçado exclusivamente para o relay, sem terminal, encaminhamentos
ou shell interativo. Não reutilizar a conta com sudo total para essa conexão.
O cadastro de uma nova chave deve ocorrer no servidor por administrador; não
copiar chaves privadas para este projeto ou para o chat.

Não foi instalado nem validado um novo acesso SSH para outro chatbot. O
transporte atual continua sendo o túnel já existente. A autenticação efetiva
desse túnel identifica o proprietário, não uma identidade criptograficamente
exclusiva da Eva ou de cada chatbot que o proprietário habilitar.

### Cliente hospedado que aceita somente URL HTTP

O túnel OpenAI atual não é, por isso só, um endpoint Streamable HTTP genérico
para outro fornecedor. Não copiar seu endereço privado nem inventar uma URL.
Esse cliente precisará de um gateway MCP autenticado compatível com ele.
O pacote opcional [`portable-http`](../scripts/raspberry-mcp/portable-http/gateway.py) implementa um gateway local autenticado. A inicialização,listagem das38ferramentas e leitura das capacidades passaram contra o socket real. Ele não foi ativado como serviço permanente e não comprova conexão com um fornecedor externo. O guia de preparação e ativação está abaixo.

Essa implantação deve validar TLS, autenticação por cliente, Origin, limites,
revogação e encaminhamento ao mesmo socket sem acesso Docker ou credenciais
do executor. Não expor o socket ou um listener sem autenticação na internet.
O suporte de um fornecedor específico só pode ser declarado após teste nesse
cliente. A assinatura, disponibilidade e custo do cliente são independentes
das restrições de custo do executor do Raspberry.

## Protocolo e descoberta

O aceite de cliente independente negociou MCP `2025-06-18`, inicialização e
listagem de 38 ferramentas no socket real. O `serverInfo` ainda usa o nome
histórico `raspberry-readonly` e versão `0.1.0`; isso não descreve a autoridade
atual das extensões. Consultar os descritores e capacidades reais.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cliente-mcp","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"maintenance_capabilities","arguments":{"host":"raspberry"}}}
```

Cada mensagem stdio ocupa uma linha JSON; saída de diagnóstico não pode ser
misturada ao stdout do protocolo. Nomes podem receber prefixo do conector no
cliente. Usar os nomes devolvidos por ele, sem presumir que um nome instalado
no servidor já foi publicado pelo intermediário.

Os esquemas completos,com identidades específicas substituídas por marcadores, estão em
[`catalog.template.json`](../scripts/raspberry-mcp/portable-http/catalog.template.json).
O arquivo é um modelo documental;os marcadores não são IDs executáveis. Para outra instalação, exportar novamente `tools/list`:
IDs de threads, allowlists, revisões e políticas são específicos do servidor.
Não preencher enums autorizados com IDs inventados. Os objetos de argumentos
rejeitam propriedades extras.

## Administração pela Eva ou outro chatbot autorizado

As quatro ferramentas principais são:

| Ferramenta | Campos obrigatórios além de `host=raspberry` |
| --- | --- |
| `codex_task_create` | `operation_id`: 32 hex; `task_key`: chave até64 caracteres; `objective`: 1–4000 caracteres; `acceptance`: 1–1500 |
| `codex_task_send` | `operation_id`: 32 hex; `task_id`: ID da criação; `text`: 1–6000 caracteres |
| `codex_task_status` | `operation_id`: ID da criação ou envio; `kind`: `creation` ou `turn` |
| `codex_task_reconcile` | `operation_id`: ID; `result_hash`: SHA-256 exato do resultado persistido |

Para a delegação administrativa, a chave de tarefa começa com **`eva-admin-`**.
O prefixo seleciona o perfil expressamente autorizado na política root, não
um comando ou uma configuração fornecida pelo cliente. A identidade durável
registrada determina o perfil dos envios posteriores. Tarefas comuns preservam
o perfil restrito original; texto de uma tarefa comum não a promove.

Procedimento:

1. Registrar objetivo, critérios, chave e IDs distintos de criação/envio no
   checkpoint central **antes** da chamada com efeito.
2. Criar uma vez; guardar o ID de criação e o ID real da thread retornada.
3. Confirmar identidade, durabilidade e prontidão pelo status. Criação não envia
   o objetivo nem comprova inferência. `notLoaded` não significa conclusão.
4. Enviar uma vez com o ID de envio previamente registrado e `task_id` igual ao
   ID da criação. Instruir correção, validação real e recibo sanitizado.
5. Consultar o mesmo envio até obter estado terminal ou incerteza comprovada.
   Não criar outra tarefa em resposta a timeout de observação.
6. Validar o conteúdo do resultado; turno `completed` pode conter tarefa
   `blocked` ou `progress`. Guardar o resultado e hash no checkpoint.
7. Reconhecer o hash exato com `codex_task_reconcile`. Só então admitir outro
   trabalho serial. Uma repetição idêntica retorna o recibo, não reexecuta.

Limites compartilhados: 48 envios em24h, espaçamento mínimo60s, execução serial,
checagem de recursos e uso somente da assinatura incluída. IDs não são trocados
para escapar de bloqueio, orçamento, falha ou resultado incerto. O limite de
duas submissões do verificador fixo separado não foi zerado nem ampliado.

## Aceite do novo cliente

O primeiro aceite deve ser de leitura: confirmar UID nativo, UID administrativo,
propriedade root das políticas, prazo e orçamento. Não reiniciar serviços,
alterar privilégios ou produzir eventos de teste. A rota administrativa
comprovada nesta instalação usou:

```sh
/usr/bin/id -u
sudo -n -u codex-house-01a16f9f /usr/bin/sudo -n /usr/bin/id -u
```

Esses comandos pertencem ao executor local, não são ferramentas de shell do
MCP nem devem ser enviados como parâmetros de transporte. Se a autenticação
local não estiver disponível, parar e informar o requisito exato; não capturar
senha nem usar Docker como contorno.

Também testar repetição com os mesmos IDs e parâmetros: deve retornar os
mesmos IDs de thread/turno com `duplicate=true`. Guardar o recibo terminal antes
do reconhecimento. O aceite atual passou por criação, envio, resultado,
reconciliação e duplicatas reais pelo cliente MCP remoto, com uma inferência.

## Erros, atualização, recuperação e revogação

- `task_rpc_unconfirmed`, `send_unknown` ou `outcome_unknown`: preservar IDs e
  recibos; observar/reconciliar a identidade existente. Não repetir efeitos.
- `not_dispatched`: recusa anterior à chamada de envio; continua exigindo
  tratamento do recibo e do bloqueio. Não equivale a execução bem-sucedida.
- `thread_profile_changed`: o perfil real não corresponde ao perfil autorizado
  daquela identidade. Não promover uma tarefa comum para conseguir enviar.
- Falha de coleta: conservar `unknown`; ausência de dados não prova recuperação.
- Catálogo local diferente do catálogo do chatbot: diagnosticar publicação do
  conector. Reinstalar o servidor ou repetir inferência não resolve esse fato.
- Atualização: comparar hashes atuais e manifestos, preservar bancos/recibos,
  exigir política root e aplicar somente destinos previstos. Não reaplicar
  instaladores históricos sobre a instalação atual. Não reiniciar a casa para
  carregar uma atualização do MCP.
- Recuperação: preservar estado durável e verificar serviços funcionalmente.
  Restore de arquivos não comprova restauração de serviços.
- Revogação de tarefas: `codex_task_revoke` bloqueia novas admissões e conserva
  observação/recibos; não interrompe automaticamente um turno já em execução.
- Revogação da rota administrativa: administrador remove a concessão temporária
  em `/etc/sudoers.d/raspberry-house-full-20261024`, preservando os recibos.
  A remoção não encerra automaticamente processos root já iniciados.
- Revogação de cliente: remover o acesso ao transporte/chave/conta específica;
  não revogar por acidente a assinatura ou o túnel compartilhado de outros
  clientes. A identidade compartilhada atual não oferece revogação por chatbot.

## Pendências que não devem ser ocultadas

O conector OpenAI observado ainda não publica os sete nomes novos de listagem/reparo,
embora o servidor os liste. A administração acima usa ferramentas já publicadas.
O caminho Events atual recebe somente avisos sanitizados do Home Assistant;
falhas diretas do host ainda não são encaminhadas por ele. O backend fixo,
o aceite administrativo e a descoberta stdio não comprovam comportamento
proativo completo,24h de cobertura,PC desligado,backup offsite ou recuperação.

## Referências de interoperabilidade

- [MCP: transportes](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP: descoberta e chamada de ferramentas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

As referências definem o protocolo; não certificam este servidor ou um cliente
específico. A evidência local e o aceite real determinam o que está comprovado.

## Índice completo do catálogo capturado

Os detalhes de tipos,limites e enums ficam no modelo de esquemas mencionado acima. Esta tabela lista todos os campos obrigatórios do catálogo local capturado,sem copiar identidades privadas para os exemplos.

| Ferramenta | Campos obrigatórios |
| --- | --- |
| `service_health` | `host` |
| `service_versions` | `host` |
| `disk_space` | `host` |
| `backup_results` | `host` |
| `log_summary` | `host`, `service` |
| `project_files` | `host`, `category`, `offset` |
| `project_read` | `host`, `file_id`, `offset` |
| `project_prepare_edit` | `host`, `file_id`, `expected_sha256`, `old_text`, `new_text` |
| `service_prepare_restart` | `host`, `service` |
| `change_apply` | `host`, `change_id` |
| `change_revert` | `host`, `change_id` |
| `maintenance_capabilities` | `host` |
| `host_diagnostics` | `host` |
| `service_diagnostics` | `host`, `service` |
| `operation_status` | `host`, `change_id` |
| `change_validate` | `host`, `change_id` |
| `operation_submit` | `host`, `operation`, `idempotency_key`, `expected_revision` |
| `ha_notifications` | `host` |
| `events_status` | `host` |
| `codex_thread_read` | `host`, `thread_id` |
| `codex_thread_status` | `host`, `thread_id` |
| `codex_thread_send` | `host`, `thread_id`, `operation_id`, `intent` |
| `admin_action_apply` | `host`, `action`, `idempotency_key` |
| `admin_action_status` | `host`, `action`, `idempotency_key` |
| `admin_action_reconcile` | `host`, `action`, `idempotency_key` |
| `admin_action_revoke` | `host`, `action`, `idempotency_key` |
| `codex_task_create` | `host`, `operation_id`, `task_key`, `objective`, `acceptance` |
| `codex_task_send` | `host`, `operation_id`, `task_id`, `text` |
| `codex_task_status` | `host`, `operation_id`, `kind` |
| `codex_task_reconcile` | `host`, `operation_id`, `result_hash` |
| `codex_task_revoke` | `host` |
| `codex_task_list` | `host`, `page_size`, `cursor` |
| `codex_repair_submit` | `host`, `operation_id`, `task` |
| `codex_repair_status` | `host`, `operation_id` |
| `codex_repair_result` | `host`, `operation_id` |
| `codex_repair_reconcile` | `host`, `operation_id`, `result_hash` |
| `codex_repair_revoke` | `host` |
| `codex_repair_capabilities` | `host` |

## Preparar o transporte HTTP opcional

Este pacote estende o transporte de uma instalação MCP existente. Não instala
Docker,Codex,túnel,dependências NPM,assinatura ou uma concessão administrativa.
Usa somente a biblioteca padrão Python. Seu próprio processo não recebe sudo
ou acesso Docker. O endereço é fixo `127.0.0.1:8765/mcp` e é somente local;
não é uma URL que outro fornecedor hospedado consiga acessar pela internet.

Arquivos versionados:

- `scripts/raspberry-mcp/portable-http/gateway.py`: transporte;
- `scripts/raspberry-mcp/portable-http/install.py`: preparação root sem ativação;
- `scripts/raspberry-mcp/portable-http/release.json`: hashes dos arquivos;
- `scripts/raspberry-mcp/portable-http/raspberry-mcp-http.service`: unidade;
- `scripts/raspberry-mcp/portable-http/test_gateway.py`: testes isolados.

O administrador deve revisar esses arquivos e o manifesto,conferir o Git HEAD
e copiar o pacote para o staging root antes de executar. A instalação abaixo
cria uma identidade sem login e sem sudo,arquivos root e um token novo local.
A chave não é mostrada no terminal nem no recibo. Uma instalação anterior com
arquivos diferentes é recusada;revisar a atualização antes de substituir.

```sh
sudo /usr/bin/install -d -o root -g root -m 0755 /run/raspberry-mcp-http-review
sudo /usr/bin/install -o root -g root -m 0644 scripts/raspberry-mcp/portable-http/gateway.py scripts/raspberry-mcp/portable-http/install.py scripts/raspberry-mcp/portable-http/release.json scripts/raspberry-mcp/portable-http/raspberry-mcp-http.service /run/raspberry-mcp-http-review/
sudo /usr/bin/python3 -I -S -B /run/raspberry-mcp-http-review/install.py
```

Executar a partir da raiz do checkout revisado. Esses comandos exigem
administração local;nenhum deles solicita que uma senha seja armazenada ou
entregue ao chatbot. O recibo fica em
`/var/lib/raspberry-mcp-http/install.json` e deve indicar
`prepared_not_activated`. Não confundir preparação com serviço em execução.

Se houver necessidade de ativar o cliente local,validar a unidade e depois:

```sh
sudo /usr/bin/systemd-analyze verify /etc/systemd/system/raspberry-mcp-http.service
sudo /usr/bin/systemctl daemon-reload
sudo /usr/bin/systemctl enable --now raspberry-mcp-http.service
sudo /usr/bin/systemctl show raspberry-mcp-http.service --property=ActiveState,SubState,MainPID
```

A unidade exige o socket existente. Um erro de porta ocupada,permissão ou
isolamento deve ser corrigido pela causa;ela não tem reinício automático.
O instalador não executa esses comandos de ativação. Não habilitar dois
listeners sobre a mesma porta.

## Configurar um cliente HTTP compatível

No cliente local,cadastrar transporte Streamable HTTP,endpoint
`http://127.0.0.1:8765/mcp` e cabeçalho `Authorization: Bearer <TOKEN_DO_CLIENTE>`.
O marcador é exemplo,não uma credencial. O token está em
`/var/lib/raspberry-mcp-http/token`,root0440,legível apenas pelo grupo privado
do transporte. O operador deve transferi-lo diretamente ao armazenamento
seguro do cliente,sem chat,repositório,URL ou argumentos de processo.

Este adaptador usa bearer pré-configurado;não implementa um servidor OAuth.
Clientes que exigem descoberta OAuth ou acesso por navegador precisam de uma
camada de autenticação/TLS própria e não estão certificados por esse teste.
Cabeçalhos Origin de navegador são recusados. GET não oferece SSE e retorna405.

O cliente deve negociar `2025-06-18`,enviar Accept com `application/json` e
`text/event-stream`,guardar o `Mcp-Session-Id` devolvido e reenviá-lo com
`MCP-Protocol-Version` nas chamadas seguintes. Notificações retornam202 sem
corpo. Há uma sessão por vez para preservar capacidade do túnel existente;
uma sessão inativa por60s é encerrada. Uma nova sessão deve consultar os
mesmos IDs duráveis para recuperar resultados,sem repetir efeitos.

A desconexão ou DELETE encerra o transporte,sem cancelar o trabalho já aceito.
Resposta HTTP504 após encaminhamento significa resultado incerto:reconciliar
os IDs originais. O adaptador nunca tenta novamente automaticamente.

Para desativar somente este transporte:

```sh
sudo /usr/bin/systemctl disable --now raspberry-mcp-http.service
```

Isso preserva o MCP original,seus bancos e o túnel. Não apagar recibos nem
reutilizar IDs. Para rotação de chave,parar este transporte,substituir a chave
local por um novo valor aleatório no mesmo arquivo root0440,atualizar o
armazenamento seguro do cliente e iniciar novamente. A chave antiga deve ser
removida do cliente revogado. Não rotacionar a chave do túnel por engano.

## Validar antes de confiar correções

```sh
python3 -B -m unittest discover -s scripts/raspberry-mcp/portable-http -p 'test_*.py'
```

O teste isolado cobre autenticação,Origin,inicialização,notificação,listagem,
expiração,limites,versão,framing inválido,JSON ambíguo e timeout sem repetição.
Os testes de expiração administrativa adicionais executam o código capturado
com bindings sintéticos e recusam criação/envio/resume após o gate temporal.
No código instalado,uma simulação da falha temporal preservou o hash do banco
e o resultado terminal sem contatar o daemon;isso não é uma observação do
prazo real já transcorrido nem uma alteração do relógio de produção.
O aceite temporário contra o servidor real comprovou descoberta e capacidade
administrativa configurada. O aceite administrativo independente comprovou
UID0 no executor e deduplicação de criação/envio. Nenhum desses resultados
certifica uma nova conta de cliente,proxy externo ou outro chatbot ainda não
conectado. Registrar esse aceite quando o cliente escolhido estiver disponível.

## Proveniência dos ciclos Git e histórico de falhas

O produtor `backup_results` usa o schema `1.3.0`. `last_worker_cycle` preserva
o resultado original do worker; `last_observed_publication` observa publicações
no log limitado e não identifica a origem da execução. `last_scheduled_cycle`
exige os metadados do fluxo canônico, identidade da requisição e horários
consistentes com o worker. Ausência, conflito ou falha de coleta mantém
`unknown`. A origem vem do tópico canônico e do ID do helper, não de uma
atestação criptográfica do agendador.

O fluxo de backup grava somente metadados sanitizados no arquivo fixo
`/data/.git-backup-health.json`, dentro do volume de dados já existente. A
simulação não grava esse arquivo nem altera o contexto persistente. A agenda,
os gates e o requisito de sucesso Git agendado para iniciar offsite são
preservados. Execução manual não libera offsite.

`known_failure_history` reúne a observação anterior preservada pelo operador
e até 16 falhas conhecidas do produtor canônico. Isso não recompõe uma série
histórica completa. Campos privados são descartados. O recibo anterior, o
contexto original e os resultados do worker permanecem preservados. Uma
publicação posterior não transforma uma falha antiga em sucesso.

A instalação exige preservar uma observação sanitizada real em
`/usr/local/lib/raspberry-repair-control/git-worker-baseline.json`, pertencente
a root, e fixar seu hash nas dependências da política existente. Esse recibo
é específico do host e não pertence ao pacote público. A API administrativa
do Node-RED usa a credencial existente somente em memória, compara o hash e
a revisão carregada, registra intent antes de submeter e confirma o estado
carregado e persistido depois. Resultado incerto exige reconciliação somente
leitura; não se repete a implantação. Não requer reiniciar o serviço.

Aceite: executar os testes `test-git-backup-health.mjs` e
`test-git-backup-flow.mjs`, as regressões puras de `test_health_summary.py`,
a validação e inspeção visual do canvas; depois consultar `backup_results`
pelo cliente MCP real. Antes do primeiro resultado natural com proveniência,
o ciclo agendado continua `unknown`. Somente o ciclo real posterior valida
o produtor em operação. Sucesso Git nunca comprova upload offsite,
integridade do bundle ou recuperação dos serviços.

## Captura automática de evidências sem ampliar administração

O componente [acceptance-observer](../scripts/raspberry-mcp/acceptance-observer/README.md)
lê o histórico e a telemetria existentes em três horários fixos do dia
25/10/2026, inclusive após o prazo administrativo. Ele não admite tarefas,
não executa reparos e não renova a autorização. Consulta pelo MCP:
`maintenance_capabilities`, campo `evidence.data.procmon_acceptance_observation`.
A origem, a idade, falhas de coleta, cobertura e limites acompanham a resposta.
Antes da primeira captura real, o estado permanece `unknown`. Uma janela
válida não significa aceite do PC desligado, de todos os eventos ou da meta.

## Limite de espera do Git e recuperação de repasse

O executor Node-RED de backup usa uma variável de ambiente fixa
`GIT_BACKUP_REQUEST_TIMEOUT_SECONDS=600` e limite externo de 660 segundos.
O payload não vira argumento de comando. O script bind-mounted permanece
inalterado; o valor não vem do cliente MCP. O ciclo de 25/10/2026 mostrou
uma solicitação concluída em 206 segundos, após o limite antigo de 180.
A validação isolada reproduz a espera acima de 180 passos sem aguardar
minutos reais e confirma o mesmo identificador no resultado.

Timeout da ponte continua sendo erro de comunicação, não falha comprovada
do Git. Consulte `backup_results`, correlacione o identificador com o resultado
do worker e preserve os recibos. Não repita o Git nem invente uma origem
agendada para liberar offsite. A correção do limite não introduz retry
automático para efeitos incertos. O gate de origem agendada e a separação
entre backup manual e offsite permanecem iguais.

A recuperação administrativa de 25/10 teve recibo próprio e uma única
submissão ao worker offsite existente, depois da publicação Git real. Foram
confirmados 13 componentes, proteção criptográfica, recibo do agente externo,
retomada dos sete serviços em 64 segundos e retenção `observe_only` sem
exclusões. Isso não constitui aceite de um encadeamento canônico automático
completo, download remoto com checksum independente ou restauração de
desastre. As evidências públicas sanitizadas ficam em
[offsite-recovery.acceptance.json](../scripts/raspberry-mcp/offsite-recovery.acceptance.json).
O fluxo diário existente avançou depois para outras etapas: DietPi concluiu
e a atualização do Home Assistant falhou antes de recriar o container:
o worker não podia gravar seu registro de recuperação na pasta compartilhada.
A correção usa o diretório privado já pertencente ao worker, preservando os
bloqueios de registros antigos e mantendo recibos após prontidão verificada.

As fontes auditadas das recuperações administrativas ficam em
[`queue_offsite_handoff.py`](../scripts/raspberry-mcp/runtime-source/administrative-recovery/queue_offsite_handoff.py),
[`apply_git_bridge_wait.py`](../scripts/raspberry-mcp/runtime-source/administrative-recovery/apply_git_bridge_wait.py)
e [`flow_client.cjs`](../scripts/raspberry-mcp/runtime-source/administrative-recovery/flow_client.cjs).
São snapshots para revisão, com marcadores para o manifesto aprovado e o
host privado do Node-RED. Não são ferramentas de shell do MCP nem um
instalador para sobrescrever políticas ativas. A submissão offsite tem intent
anterior ao efeito, uma identidade fixa, verificação do Git concluído,
checagem de recursos/concorrência e recibo imutável. Após a submissão,
`backup_results` fornece o resultado atual do worker; o recibo de fila
isoladamente não comprova execução.

A candidata de imagem que não passou pela etapa de validação do Home
Assistant foi preservada fora do checkout para revisão. O Compose voltou
à imagem que permanece em execução, sem reiniciar serviços nessa contenção.
Antes de editar ou validar o projeto, confira a atividade de todas as etapas
diárias; o fluxo existente pode avançar após o resultado offsite.

## Entrega de eventos e atualização recuperada

Em `maintenance_capabilities`, `events.current_observation.state` descreve a
assinatura. Consulte também `events.current_observation.delivery`: uma
assinatura `active` pode ter entrega `budget_held`, `reconciliation_required`
ou `unknown`. O resumo expõe somente contadores limitados, estado sanitizado
do último envio e razão enumerada. Não inclui conteúdo de avisos, callback
ou chave. Seis tentativas na janela móvel bloqueiam novos envios; uma espera
por espaçamento não recebe um horário de retry inventado. O resumo não muda
o limite, não renova a assinatura e não repete entregas incertas.

`webhook_accepted` não comprova execução da assistente nem prontidão de uma
entrega futura. Datas ausentes, conflito de relógio e falha de coleta mantêm
`unknown`. O aceite foi conferido por cliente MCP padrão no Raspberry e
pelo conector remoto real após recarregar a ponte. Uma conexão persistente
pode continuar usando o módulo anterior até ser renovada. A ativação teve
recibo próprio e não reiniciou o daemon Codex nem serviços residenciais.
Veja [event-delivery-health.acceptance.json](../scripts/raspberry-mcp/event-delivery-health.acceptance.json)
e [os testes de entrega](../scripts/raspberry-mcp/event-delivery-health.test.mjs).

A recuperação do Home Assistant concluiu no worker existente, confirmou
versão e prontidão e publicou o Compose no GitHub. A falha anterior foi
preservada. A etapa posterior dos containers parou antes de recriar serviços
porque faltava cobertura de prontidão do Portainer; esse gate permanece
ativo. Consulte [homeassistant-recovery.acceptance.json](../scripts/raspberry-mcp/homeassistant-recovery.acceptance.json).
Isso não comprova todas as integrações nem restauração de desastre.
