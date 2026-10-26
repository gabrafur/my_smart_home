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
| `ha_notifications` | `host`; opcionais `notification_id`, `offset`, `expected_digest` |
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
lê o histórico e a telemetria existentes em cinco horários fixos: 25/10/2026
às 04h30, 15h20 e 20h33 UTC e 26/10 às 11h e 16h UTC. Esses calendários
não renovam a validade administrativa. Ele não admite tarefas,
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

A entrega agrupada ativa usa `notification_summary_v1`. Cada tentativa inclui
até oito notificações e agrupa suas revisões, com estado atual vindo de snapshot
recente. Estados atuais e mudanças novas precedem remoções antigas. Os IDs e
transições permanecem no ledger, com intent e membros atômicos antes da rede.
Remoção não comprova recuperação; resultado incerto não permite reenviar os
membros, mesmo em outro resumo. Registros que saem da janela recebem arquivo
e motivo explícitos, sem descarte silencioso; arquivo cheio falha fechado.

`events_status.delivery_queue` informa grupos, revisões agrupáveis, idade,
contagens de arquivo e vínculos duráveis. `delivery_opportunity` calcula o
bloqueio, próximo slot e compatibilidade com a validade da assinatura. Os mesmos
agregados estão em `maintenance_capabilities` no campo `delivery.summary`.
São projeções fechadas; coleta falha não vira zero. Os limites continuam em
seis tentativas por 24h e intervalo mínimo de dez minutos, sem reset.

Foi comprovada a leitura dos novos campos pelo cliente MCP real; a entrega de
um resumo no ciclo natural e a execução do assistente exigem recibos separados.
Confira o [contrato e procedimento](../scripts/raspberry-mcp/runtime-source/native-events/README.md),
o [aceite parcial](../scripts/raspberry-mcp/event-summary.acceptance.json) e
os [testes de resumo](../scripts/raspberry-mcp/event-summary.test.mjs).

Atualizar um módulo ESM no disco não muda o import já carregado no frontend
MCP persistente. Validar a chamada real pode revelar esse caso mesmo quando
testes isolados passaram. A correção precisou recarregar Events e reconectar
somente o túnel existente, mantendo autenticação e assinatura. Não reiniciou
Home Assistant, Node-RED, MQTT ou Codex. Reversão conserva dados/membros e
mantém Events parado até revisão de compatibilidade, para impedir replay.


A recuperação do Home Assistant concluiu no worker existente, confirmou
versão e prontidão e publicou o Compose no GitHub. A falha anterior foi
preservada. A etapa posterior dos containers parou antes de recriar serviços
porque faltava cobertura de prontidão do Portainer; esse gate permanece
ativo. Consulte [homeassistant-recovery.acceptance.json](../scripts/raspberry-mcp/homeassistant-recovery.acceptance.json).
Isso não comprova todas as integrações nem restauração de desastre.


## Observador passivo e recuperação de coleta

O [produtor de fatos do host](../scripts/host-observation/README.md) foi instalado
como serviço root isolado: eventos de containers/unidades e recursos sanitizados,
sem comandos remotos ou efeitos de reparo. A integração a políticas
[Node-RED](../nodered/tools/HOST_OBSERVER.md) foi implantada e tem aceite separado;
a exposição do novo relatório pelo MCP foi validada no cliente real, conforme
a seção seguinte. O cliente não deve inferir essa cobertura
apenas porque o serviço está ativo. Reconexões, anel limitado e falta de inventário
inicial impedem afirmar histórico completo.

A [regressão do modo atômico](../scripts/raspberry-mcp/procmon-observability/README.md)
registra a recuperação real de uma falha persistente da coleta, mantendo o
coletor original e os gates. Os ciclos naturais voltaram; a lacuna de 10.623
segundos permanece na evidência. Isso invalida o aceite de continuidade de 24h
nessa janela. Falhas antigas continuam históricas, mesmo após sucesso posterior.

## Monitor do host e contagens de Events pelo MCP

As ferramentas existentes aceitam `{"host":"raspberry"}` e continuam somente
leitura. Não foram acrescentados parâmetros de comandos, caminhos, prompts,
identidade ou permissões. A evidência real fica em
[host-observation-MCP.acceptance.json](../scripts/raspberry-mcp/host-observation-MCP.acceptance.json).

`maintenance_capabilities.evidence.data.host_observation` projeta dois arquivos
fixos: relatório do produtor root e contexto de aplicação do tab Node-RED.
O leitor abre diretório/arquivo sem seguir symlinks, exige owner/grupo/modo,
rejeita hardlinks, limita cada leitura a 64KiB e rejeita arquivo alterado durante
a leitura. Não executa conteúdo desses arquivos. O contexto pertence ao usuário
da aplicação; não é uma aprovação administrativa nem uma identidade de chatbot.

| Campo | Tipo / significado |
| --- | --- |
| `state`, `collection_error`, `observed_at` | observação disponível ou `unknown`, erro sanitizado/null e UTC |
| `producer` | horário/idade, sequência, perdas do anel, conexão dos streams e métricas allowlisted |
| `producer.resources` | horário/idade, valores numéricos ou null, erros e validade da política visual |
| `producer.producer_cost` | custo do próprio produtor; exclui journal filho e janela de 24h |
| `NodeRED` | horário/idade do último frame, sequência, papéis observados e incidentes sanitizados |
| `NodeRED.visual_policy` | política validada, lida do canvas; não redefine thresholds no MCP |
| `notification_intent_recorded` | intenção persistida; não prova entrega da notificação |
| `operational_health` | permanece `unknown`: cobertura parcial não prova saúde global |
| `*_proven` | continuam false para Eva, PC desligado, 24h e latência completa |

O contexto pode levar até 30s para persistir. Sua idade é apresentada e contexto
com mais de 60s fica desconhecido. Divergência de instância/sequência, datas
faltantes/futuras, política inválida e falha de coleta conservam `unknown`.
A API não exporta mensagens, logs, prompts ou credenciais. Um valor ausente não
vira zero ou recuperação. O monitor [Node-RED](../nodered/tools/HOST_OBSERVER.md)
continua sendo o local de decisões, confirmação, lifecycle e limites visuais.

`events_status` e `maintenance_capabilities.evidence.data.events.current_observation.delivery`
separam:

- `retained_event_records`: todos os registros de eventos ainda retidos;
- `eligible_pending_event_records`: eventos selecionáveis pela regra atual do
  dispatcher: assinatura ativa do mesmo principal, tópico autorizado, janela
  de 24h/início da assinatura e ausência de qualquer intent de envio;
- `queued_event_records`: alias compatível da contagem elegível, acompanhado
  de `queued_event_records_semantics`;
- `event_count_collection_error`: null ou erro sanitizado; erro/falta de evidência
  deixa pendência desconhecida, sem inferir ausência de trabalho.

Nas versões anteriores, `queued_event_records` era o total de linhas retidas,
inclusive eventos enviados. Não interprete recibos antigos como backlog real.
A projeção reconhece a resposta antiga como total retido e mantém pendência
`null`. Contagem nova inconsistente também fica desconhecida. A consulta usa
snapshot somente leitura e não modifica IDs, intents, assinatura ou orçamento.
Intent incerto/recusado/aceito exclui o evento da pendência; não vira retry.
Pendente não significa orçamento disponível, callback aceito ou execução da Eva.

Para usar: consultar saúde e erros, verificar a origem/idade e diagnosticar
somente o papel afetado pelas ferramentas existentes. Seguir o catálogo
administrativo autorizado com identidade, idempotência, resultado e reconciliação;
não repetir efeitos incertos. `budget_held` deve ser preservado. A ativação
recarregou apenas Events e o túnel MCP, com recibos por etapa; manteve a mesma
assinatura e os intents existentes. Nenhum serviço residencial ou daemon Codex
foi reiniciado. As fontes auditadas e testes estão no snapshot público; manifestos,
políticas locais e credenciais continuam privados. Esses snapshots não podem
sobrescrever políticas de outro servidor sem revisão dos bindings pelo operador.


## Correlação de falhas e custo do coletor

A instrumentação de [sinal/gravação/custo](../scripts/raspberry-mcp/procmon-observability/README.md)
preserva o coletor original e seus limites. O observador do host registra CPU
nativa da unidade após transição real e com identidade correspondente. O
[auditor fixo](../scripts/raspberry-mcp/procmon-observability/invocation_audit.py)
é somente leitura, sem argumentos e sem nova operação de comandos no MCP.
Seu aceite real e hashes estão em
[procmon-signal-accounting.acceptance.json](../scripts/raspberry-mcp/procmon-signal-accounting.acceptance.json).

O resultado distingue CPU do observador, CPU do processo até a telemetria e CPU
da unidade inteira. Invocações históricas sem telemetria continuam ausentes;
memória sem contador continua desconhecida. O aceite não substitui cadência das
amostras duráveis, observação de 24h, latência até Eva nem prova de PC desligado.
Esses campos novos ainda não são projetados pelo coletor agendado de aceite;
o MCP continua expondo os limites explícitos da projeção já instalada.


## Consultar a conversa coordenadora pela Eva

A referência autorizada `coordenacao_meta` agora integra a observação, além de
`principal` e `backup`. A alteração corrige a recusa anterior do leitor limitado
a duas referências; não cria uma tarefa substituta nem repete o envio da Eva.
A identidade privada da coordenadora é um binding da instalação, representado
por `${AUTHORIZED_THREAD_ID_3}` nas fontes públicas.

No catálogo atualmente disponível à Eva, chamar:

```json
{"host":"raspberry"}
```

na ferramenta `maintenance_capabilities`. Ler
`evidence.data.authorized_thread_observations.threads` e
`evidence.data.authorized_thread_observations.coordination_checkpoint`.
Esse caminho já foi aceito pelo cliente MCP conectado, sem o PC. Não depende
que o cliente receba imediatamente descritores novos.

Clientes com catálogo atualizado também podem usar `codex_thread_read` ou
`codex_thread_status` com `host` e o `thread_id` autorizado da coordenadora,
**sem `operation_id`**. O resultado contém metadados atuais do daemon e
`coordination_checkpoint`. O `codex_task_list` instalado inclui essa referência
na paginação do inventário autorizado. O leitor direto exige o schema novo;
um catálogo antigo que ainda enumere duas referências deve usar o caminho por
`maintenance_capabilities`, sem forçar argumentos fora do schema do cliente.

O resumo de coordenação informa trabalho declarado, revisão Git declarada,
componentes reservados, avanços e pendências em campos enumerados. Ele permite
comparar propostas e evitar duplicidade, sem expor mensagens, prompts ou logs.
`installed_source_fingerprints` contém hashes dos dois produtores Events fixos,
calculados sobre arquivos root, sem exportar seu conteúdo.

O relatório vem de um arquivo fixo já acessível ao broker, com UID 1001, modo
0600 e máximo de 16 KiB; não há caminho recebido pela API nem nova montagem.
Ao portar a instalação, o operador define esse binding junto das identidades
antes de selar código e hashes. O produtor atualiza o relatório ao mudar de
fase ou concluir trabalho, com horário e revisão reais. Não renovar o horário
apenas para aparentar progresso. Após 300 segundos, `state=unknown`,
`collection_error=coordinator_report_stale` e `scope_fresh=false`; as reservas
antigas permanecem visíveis e não são liberadas automaticamente. Ausência,
falha de leitura, schema inválido ou data futura mantêm a observação desconhecida.

O relatório não comprova execução, conclusão da meta nem autorização:
`execution_receipt`, `goal_completion_verified` e
`administrative_authority_from_report` são sempre falsos. A declaração de meta
pausada também é preservada. Para um resultado efetivo, consultar os recibos da
operação correspondente; uma proposta não implementada continua proposta.

A coordenadora recebe observação somente por essa extensão, com
`adapter_send_admission=coordinator_observation_only`. Estar tecnicamente apta
no daemon não autoriza envio; enquanto ativa, a projeção informa
`serial_execution_gate=busy`. Os dois destinatários legados de envio, os
limites compartilhados, a expiração e os gates existentes continuam valendo.
Nenhuma consulta chama `resume`, inicia inferência ou lê histórico bruto.
`notLoaded` não é término. Links permanecem nulos enquanto a integração não
fornecer ou validar um link e sua plataforma.

O aceite real observou 38 ferramentas no servidor padrão, enquanto o catálogo
nativo conectado ainda tinha 31. A listagem percorreu cinco páginas de dois
itens, com nove identidades autorizadas, sem duplicidade. Uma identidade antiga
não carregada manteve erro explícito de coleta; a cobertura continua parcial.
Última criação e última execução vêm dos registros do adaptador; não são a
thread coordenadora apenas por ela estar ativa. A execução mais recente tinha
protocolo concluído e resultado da tarefa bloqueado, sem novo envio nesta
correção.

A instalação preservou os recibos da primeira recusa por um pin de política
não atualizado e da reconciliação desse pin. A cadeia inclui hashes do código,
`legacy_policy_sha256` e dependências da política de reparo; atualizar somente
os hashes de fonte não basta. Não se remove um pin para fazer uma chamada passar.
O aceite posterior confirmou a cadeia completa, sem reiniciar serviços.
As [regressões isoladas](../scripts/raspberry-mcp/owner-thread-access.test.mjs)
e o [recibo público sanitizado](../scripts/raspberry-mcp/owner-thread-access.acceptance.json)
registram o escopo validado; os recibos privados permanecem no plano central.

## Notificações: conteúdo diagnóstico sanitizado

`ha_notifications` é somente leitura, restrito ao host `raspberry` e ao
principal autenticado existente. O daemon, a credencial, o tópico e a identidade
anteriores são reutilizados. O MCP não consulta o HA ao receber uma chamada,
não cria ou remove notificações, não chama serviços e não inicia assinatura
Events. A atualização do observador reconecta a sua observação já existente.

```json
{"name":"ha_notifications","arguments":{"host":"raspberry"}}
{"name":"ha_notifications","arguments":{"host":"raspberry","notification_id":"<SHA256 de 64 caracteres hexadecimais>"}}
{"name":"ha_notifications","arguments":{"host":"raspberry","offset":16,"expected_digest":"<digest da primeira página>"}}
```

O esquema aceita somente `host`, `notification_id`, `offset` e
`expected_digest`. O ID é o hash devolvido pelo próprio MCP; não enviar o ID
original do HA. Consulta por ID não aceita offset diferente de zero. Páginas
posteriores exigem o digest da primeira: mudança na fonte retorna
`snapshot_changed`, sem misturar versões. O máximo é 16 avisos e menos de
60.000 bytes por resposta; mensagens extensas podem reduzir a página. Sempre
seguir `next_offset`, que pode ser menor que 16.

| Campo | Semântica |
| --- | --- |
| `source`, `observed_at`, `age_seconds`, `state`, `collection_error` | Origem e atualidade da coleta, separadas da condição da residência |
| `id`, `revision`, `created_or_updated_at` | Identidade estável e data fornecida pelo HA |
| `title`, `message` | Cláusulas técnicas reconstruídas por vocabulário revisado; não são transcrição literal |
| `integration_names`, `error_type`, `reason` | Informações reconhecidas no aviso; ausência permanece desconhecida |
| `correction_guidance`, `guidance_basis` | Orientação diagnóstica, sem execução nem prova de causalidade |
| `redacted_fields` | Campo e motivo de ocultação, sem registrar o valor ocultado |
| `notification_state`, `last_observed_state` | `current`, `removed` ou `unavailable`; fonte falha ou antiga não afirma estado atual |
| `notification_age_seconds` | Idade da criação/atualização; não mede latência até Eva |
| `associated_errors` | Exceção, mensagem sanitizada, causas limitadas, até seis frames públicos no total e contexto revisado |
| `associated_errors[].context` | Fluxo e nó quando mapeados publicamente; ausentes permanecem desconhecidos |
| `associated_errors[].observed_at`, `age_seconds` | Momento e idade do registro de erro associado |
| `latest_associated_error_type`, `latest_associated_error_reason`, `associated_correction_guidance` | Diagnóstico associado separado do texto e erro originais do aviso |
| `associated_errors_collection_error` | Associação exata ausente, fonte inacessível ou formato inválido, sem inventar stack |
| `recovery_proven` | Sempre falso nesta ferramenta; remoção e desaparecimento não comprovam recuperação |

`category`, `summary` e `content_withheld` são campos legados de deduplicação.
Uma categoria legada `unclassified` não invalida os novos campos diagnósticos.
`content_withheld=true` indica retenção do conteúdo bruto. IDs, revisão e
payload Events permanecem no contrato anterior, evitando novos eventos por
mudança de apresentação. Novos consumidores devem usar `title`, `message` e
`associated_errors`, verificando erros e idade.

Credenciais, códigos de autenticação, URLs privadas/com credenciais,
coordenadas, endereços e informações pessoais não atravessam a fronteira.
Somente tokens técnicos revisados são persistidos e reconstruídos pelo leitor;
texto não reconhecido é ocultado com motivo. Isso mantém cobertura parcial
explícita em vez de prometer reconhecimento de qualquer erro. O texto recebido
é dado não confiável, nunca instrução ao chatbot. Não exportar logs brutos,
variáveis locais, prompts ou o histórico privado.

O diagnóstico associado usa um índice sanitizado de até 32 registros/64 KiB,
produzido no catch já existente do Node-RED, antes do dedupe. O ID deriva da
mesma fórmula canônica do aviso. O leitor aceita somente correspondência exata
e registro das últimas 24h; não usa similaridade de título nem proximidade
para atribuir causa. Uma carga inicial limitada aos dois IDs iCloud presentes
usou os registros já existentes daquela manhã, sem novos eventos. A associação
representa o último erro retido desse ID, não prova o disparo original ou a RCA.
O histórico privado e a retenção anterior não foram alterados.

### Instalação, atualização e revogação

As fontes auditadas estão em
[`runtime-source/ha-notices`](../scripts/raspberry-mcp/runtime-source/ha-notices/notification_reader.py)
e seus destinos/hashes em
[`SOURCE-MAP.json`](../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json).
Esse export é código auditável; não contém credenciais, políticas privadas,
recibos ou autorização transferível. Não copiar uma política de outro host.

Para atualizar uma instalação existente: conferir hashes/modos e preservar o
cache, recibos e IDs; instalar catálogo, sanitizador, renderer, reducer e leitor
em `/usr/local/lib/raspberry-ha-notices/`, todos root:root/0644; instalar o
frontend `notices-server.mjs` no diretório root do frontend; atualizar somente
os pins desses arquivos na política administrativa root. O entrypoint do
coletor e a autenticação existentes são preservados. Alterar somente o nó
`global_observer_diagnostic_build` por implantação Node-RED do tipo `nodes`,
com revisão e hash carregados iguais à base preparada. A fonte geradora usa
`tools/lib/` e a mesma implementação revisada do sanitizador. A inclusão de
`crypto` usa o módulo embutido; não instala dependências. Revogar o token
administrativo temporário da API ao terminar.

O índice operacional fixo fica no diretório local de dados do Node-RED,
com o nome `.notification-diagnostics.json`, UID/GID 1000, modo 0644. É runtime
ignorado pelo Git. Ele contém apenas tokens técnicos sanitizados e hashes, nunca o erro
bruto. Não ampliar mounts, ACLs ou acesso ao histórico privado. Aplicar uma
única vez cada manifesto, com intent durável anterior a escrita, implantação e
restart. Após resultado incerto, consultar/reconciliar; não repetir efeitos.
Reiniciar somente `raspberry-ha-notices.service` quando mudar o código do
observador; uma mudança só no leitor não precisa restart. Isso não reinicia
HA, Node-RED, MQTT ou host. A validade administrativa anterior continua igual.

Revogação de conteúdo: bloquear novas chamadas desta ferramenta ou restaurar o
leitor/frontend anterior e os seus pins, sem tocar assinaturas, notificações ou
histórico. Para desligar também a persistência de tokens, reverter o único nó
alterado com revisão/hashes novos e restaurar os módulos do observador com
restart apenas dele. Usar os backups da versão efetivamente instalada; não
executar um instalador histórico sobre uma base diferente. Falha no rollback
permanece incerta e não é repetida automaticamente.

### Aceite por qualquer chatbot MCP

Negociar o protocolo `2025-06-18` no transporte existente; carregar `tools/list`
e conferir o esquema de `ha_notifications`. Chamar a ferramenta, conferir
`state=observed`, erro nulo e as idades; ler cada ID devolvido e comparar o ID
consultado; percorrer os offsets/digests reais; verificar que ID desconhecido
não significa removido nem recuperado. Não criar avisos artificiais para esse
aceite. Casos de remoção, coleta falha, segredos, coordenadas, causas cíclicas e
páginas extensas são testes isolados.

O aceite real leu os três avisos atuais, inclusive por ID, no transporte Unix
MCP do próprio Raspberry; dois têm `HomeAssistantError`, serviço indisponível,
stack pública e contexto dos nós iCloud. O terceiro é aviso de inicialização
do HA, diferente do aviso de recursos da foto histórica. A mesma integração
nativa desta conversa devolveu os novos conteúdos nas chamadas existentes.
**Seu esquema em cache ainda descarta `notification_id`: uma chamada enviada
com esse argumento continuou retornando `query_kind=page`.** Não declarar o
filtro nativo validado; conferir `query_kind=notification_id` depois da
atualização do catálogo pelo cliente. Os recursos de gestão disponíveis não
ofereceram atualização desse cache; não remover/reconectar a integração nem
alterar permissões para tentar contornar o problema. Clientes MCP padrão com
esquema atualizado já passaram as consultas por ID reais.

O recibo público sanitizado é
[`ha-notifications-content.acceptance.json`](../scripts/raspberry-mcp/ha-notifications-content.acceptance.json).
Ele comprova leitura, não que Eva executou uma correção ou que os serviços
voltaram a responder. Nenhum callback, nova assinatura, conta ou efeito
residencial foi criado.

## Candidato de reparo por componente ainda desativado

O [protótipo e seus esquemas](../scripts/raspberry-mcp/component-repair-candidate/README.md)
separam fonte revisada, identidade carregada, reservas, recibos e prova funcional.
As doze ferramentas desse protótipo não pertencem ao catálogo ativo. Leitura
administrativa real confirmou as identidades dos dois canvases permitidos e
a prova de código do processo iCloud; isso não equivale a acesso da Eva ou
execução de reparo pelo MCP. O heartbeat já emite identidade de código em
ciclo natural, vinculada à invocação concluída pelo systemd; a leitura
owner-only não ativa ferramentas novas para a Eva.

O protótipo exige recibo da operação exata para reconciliar efeitos incertos
e confirmação explícita de coordenação/recursos para aplicar. O candidato tem
pai e IPC testados em isolamento. Revisão segura, instalação root, gates
recíprocos, port de efeito HA, binding protegido do worker heartbeat,
aprovação específica e aceite pelo cliente MCP continuam pendentes. O worker
heartbeat candidato já possui escrita atômica, journal e reconciliação
sem repetição, testados com fontes e observações sintéticas. Ele aguarda a
invocação natural para separar arquivo escrito de código carregado; isso
não comprova envio ao destino nem recuperação funcional. Publicação de fontes e testes
não instala nem autoriza essa ampliação.

## Contrato de payload dos resumos Events

`events/list` anuncia `smart_home.observation` com duas alternativas fechadas:
o evento individual legado e `notification_summary_v1`. O schema completo
está em `scripts/raspberry-mcp/runtime-source/frontend/events-server.mjs`,
exportado como `eventPayloadSchema`. `inputSchema`, identidade autenticada,
assinatura, transporte, seis tentativas/24h e intervalo de 600s permanecem.

O resumo contém `project`, `topic`, `source`, `delivery_kind`,
`source_observed_at`, `summary_as_of`, `notifications`, `covered_event_records`,
`remaining_notification_groups`, `recovery_proven`, `assistant_execution` e
`history_semantics`. Cada grupo contém hash opaco, estado/revisão atuais, última
fase conhecida, ambiguidade histórica, primeiro/último horário, contagens por
fase, prévia limitada de transições e quantidade omitida. Até oito grupos e
256 registros; nenhum título, mensagem, credencial ou localização nesse payload.
Remoção mantém recuperação não comprovada; execução continua desconhecida.

O cliente chama `events_status` com `{"host":"raspberry"}` e consulta
`frontend_payload_contract`: versão, hash SHA256 do schema e variantes
carregadas no frontend que respondeu. Essa informação não comprova atualização
do cache de outro cliente, entrega do webhook ou execução do assistente. Um
cliente novo deve redescobrir Events; não criar assinatura adicional nem trocar
IDs ou chave para tentar resolver cache. Preservar a assinatura existente.

Uma entrega agrupada natural foi observada no MCP e no ledger: há batch e
vínculos duráveis dos eventos cobertos, com webhook aceito. O contrato antigo
ainda anunciado aceitava apenas evento individual; a regressão reproduz essa
incompatibilidade sem atribuir a ela uma rejeição da plataforma não observada.
O schema corrigido aceita os dois formatos. Aceite continua sem prova de Eva.

Testes públicos usam o produtor Python puro e Ajv fixado no lockfile de
`validation`; `make validate-dependencies` instala as dependências de teste,
sem scripts npm. Não precisa de Ajv no daemon de produção. Execute
`node --test --test-concurrency=1 scripts/raspberry-mcp/event-payload-contract.test.mjs`.
Os testes não usam o PC, callback, assinatura, dispositivos ou credenciais.

Para atualizar esse frontend privilegiado, conferir a cadeia de hashes das
políticas task-control e repair-control. Mudam somente o pin do frontend e o
pin transitivo da política; orçamento, prazo e aprovação não são renovados.
Recarregar apenas a conexão existente do MCP. Reversão exige comparação das
bases e preserva todos os dados/intents/membros de Events, inclusive incertos.
Nunca repetir uma entrega para testar o schema ou comprovar consumo externo.

## Verificação do backup e entrada do contêiner

Upload, hash do ciphertext, autenticação criptográfica e recuperação funcional
precisam de provas próprias. O último produtor de backup pode reportar sucesso
enquanto a verificação independente termina antes de autenticar o arquivo.
`credential_input_limit` com stdin vazio não prova corrupção nem senha inválida.

No fluxo `docker create` seguido de `docker start --attach --interactive`, o
create precisa de `--interactive`. Conferir OpenStdin=true, Tty=false e UID
antes de solicitar a chave. Testar só a função de criptografia ou `docker run`
não cobre esse transporte. Há regressão do fluxo completo usando somente
fixtures, sem chave, backup ou mount residencial. O código auditado e os testes
ficam em [offsite-integrity](../scripts/raspberry-mcp/runtime-source/offsite-integrity/README.md).

Uma recuperação preparada mantém ID e recibos, exige falha anterior comprovada
antes da criptografia, limpeza e hashes exatos, e bloqueia resultados incertos.
Leituras consumidas não são liberadas apagando intents: exceção de orçamento
precisa de aprovação específica vinculada ao manifesto. Não concede novo
acesso MCP nem renova a validade administrativa. Snapshot público usa bindings;
não instalá-lo diretamente sobre a política vigente. A autenticação real e
a exposição do resultado pelo MCP continuam aceites separados.


## Indisponibilidade genérica e contrato dos nós iCloud

Os nós de atualização de localização chamam `public_bindings.call` com a ação
`refresh_location`; o nome do nó não implica chamada direta a um serviço
`icloud.*`. `HomeAssistantError: Service not available` não identifica sozinho
serviço ausente, handler incompatível ou dependência remota indisponível.
O conteúdo sanitizado mantém a origem não comprovada e orienta conferir essas
camadas separadamente. Alterar a redação não remove o aviso nem prova recuperação.

Uma observação administrativa dos dois nós carregados confirmou esse contrato
e presença de `public_bindings.call` no cache de serviços da conexão existente.
A prova ligada ao processo HA confirmou o adaptador iCloud em `entry_ready`.
Cache não equivale a consulta HA ao vivo; entry ready não prova saúde Apple.
O campo `evidence.data.icloud_readiness` de `maintenance_capabilities` agora
expõe prova do processo e presença de `public_bindings.call` no registro HA
consultado localmente. Duas leituras pelo cliente MCP real passaram, com
420,031 segundos de avanço da coleta nativa. Presença no registro não prova
execução do handler nem disponibilidade do provedor Apple.
As chamadas reais de localização não foram repetidas para testar o diagnóstico.

O Node-RED instalado envolve respostas API com código/mensagem em
`HomeAssistantError`, preservando a mensagem e perdendo o código original.
Esse rótulo não identifica a classe Python nem distingue atualização do
provedor de chamada downstream. O diagnóstico continua sem atribuir causa
com base apenas no texto genérico.

Fonte, campos, preparação por outro operador, limites, pré-checagem do socket,
revogação persistente e restrições de rollback estão no
[guia do diagnóstico iCloud](../scripts/raspberry-mcp/icloud-readiness-candidate/README.md).
A exportação pública tem bindings desarmados e políticas privadas ausentes;
não deve ser copiada sobre uma instalação viva. O aceite do cliente MCP
não identifica por si só uma execução específica da Eva/dots.


## Aceite independente do backup de 26/10/2026

Após a exceção limitada aprovada pelo proprietário, a verificação do mesmo
artefato externo terminou `verified_cleaned`: o hash esperado do ciphertext
foi confirmado e todo o fluxo securetar v3 foi autenticado. A cópia e o
contêiner temporários foram removidos; os sete serviços mantiveram os horários
de início. A falha anterior e os recibos continuam preservados.
Isso comprova a integridade daquele artefato, sem afirmar restauração ou
recuperação funcional dos serviços. Não repetir a leitura consumida da chave
ou a transferência para reproduzir esse aceite.
