# Coordenação, aplicação e recuperação

## Ciclo operacional e critérios de conclusão

1. Detectar por produtores e eventos canônicos ou observação MCP. Registrar a
   origem, relógio, frescor, cobertura e identidade do incidente; coleta ausente
   fica `unknown`, sem declarar recuperação.
2. Diagnosticar com `maintenance_capabilities`, `service_health`, diagnósticos e
   referências permitidas. Separar processo ativo, prontidão funcional, backup
   íntegro, restore e execução do cliente; nenhum desses fatos substitui outro.
3. Coordenar uma única operação pelo checkpoint durável: objetivo, critérios,
   escopo, IDs e estado de admissão. Conferir hashes, validade, recursos, quota,
   locks e política vigente antes de admitir o efeito.
4. Preparar a mudança e seu plano de reversão. Percorrer validação e dry-run
   disponíveis para o componente. No Node-RED, o teste percorre as decisões de
   produção até terminal `simulated: true`, `dispatched: false` e mantém estado
   sintético separado. Dry-run não é execução nem aprovação de um plano destrutivo.
5. Aplicar somente o efeito admitido e necessário. Preservar confirmações exigidas
   na interface e gates do servidor. Usar a operação fixa publicada ou o adaptador
   de tarefas aprovado; MCP não oferece shell arbitrário.
6. Observar o mesmo ID até resultado comprovado. Após timeout, consultar status e
   recibos; conservar estado incerto e nunca criar outro ID para repetir o efeito.
7. Verificar o componente por seu mecanismo nativo, além do hash persistido e do
   estado do processo. Se o critério falhar, usar reversão prevista e verificar
   novamente. Restore em ambiente isolado não aceita a produção automaticamente.
8. Registrar resultado e limitações; reconciliar o hash exato apenas quando o
   resultado estiver durável e revisado. `completed` no turno não garante que o
   objetivo esteja `complete` ou que o serviço tenha se recuperado.

O ciclo completo depende de entrega ao cliente, admissão do executor, efeitos
permitidos e verificação funcional. Não há prova global de autonomia somente
porque `service_health`, descoberta ou webhook responderam. Falhas por componente
devem manter a causa e o próximo passo explícitos, sem contornar autorização.

## Boot, expiração e recuperação da ponte

O transporte mantém o limite de 65.536 bytes e serializa a resposta JSON sem
espaços dispensáveis. A compactação não altera os objetos, hashes dos recibos
ou auditoria; a quebra de linha continua delimitando a mensagem. Fontes e
instaladores em `read-catalog-release` têm proveniência histórica: compare o
código atual, os pins vigentes e o pacote revisado antes de reinstalar. Um
manifesto antigo não representa automaticamente uma revisão posterior da fonte.

`control_lease_expired`, `control_socket_changed` e admissão inativa são gates de
segurança. Uma queda de energia pode mudar boot, PID e inode; o socket reaparecer
no mesmo caminho não renova a autorização. Preservar operações, banco, planos e
recibos. Conferir o peer exato e preparar somente a atualização de binding
necessária, para revisão administrativa. A [reconciliação](#reconciliar-control_socket_changed-sem-reiniciar-o-codex)
não modifica prazo ou escopo. Se também houver expiração, reaprovar binding não
renova a lease. Não reiniciar a casa nem desativar o gate para reativar a ponte.

## Manutenção de armazenamento

O [catálogo de armazenamento](../../scripts/raspberry-mcp/runtime-source/storage-maintenance/README.md)
delimita observação, plano, quarentena e recuperação. Sua disponibilidade real
deve ser consultada no MCP. A ativação aprovada desse catálogo não habilita
limpeza ampla, recorrência, expurgo de backups ou alteração de concessões Codex.
Preservar plano apresentado, confirmação da interface, limites persistidos e
reconciliação. A recorrência permanece desativada até política própria aprovada.

Quando houver política aprovada de atuação do cliente por eventos, consulte sua
projeção completa pelo catálogo presente em `disk_space`. A agenda do servidor
e a admissão de execução são estados separados; a [referência do catálogo](../../scripts/raspberry-mcp/runtime-source/storage-maintenance/README.md#política-de-atuação-do-cliente-por-eventos)
descreve identidade, revogação e limites desse contrato.

## Núcleo protegido de execução por componente

Consultar o [perfil e o procedimento por componente](reference/component-repair.md#núcleo-protegido-instalado-com-perfil-inicial-do-host)
antes de criar trabalho. O núcleo instalado não transforma o catálogo de
armazenamento em rotina automática nem habilita todos os componentes do
protótipo. O perfil inicial é somente `observacao_host` e a recorrência segue
desativada. Fonte instalada e `execution_active=true` comprovam admissão da
preparação atual; a aplicação, reversão e execução funcional pelo cliente têm
seus próprios recibos e testes nativos.

O request Root vincula o mesmo envio real usado pelo TaskBudgetPort. Um único
turno admitido pode enfileirar e observar fases fechadas; não criar outro turno
para escapar de uma reserva ou de um resultado incerto. A revisão de fonte e
render pertence ao operador autorizado e não é substituída por uma flag
fornecida pelo chatbot. O resultado terminal deve ser preservado antes do ACK.

### Revogar e desativar com o estado preservado

As concessões mantêm seus próprios prazos e marcadores. Remover a regra
temporária de administração aprovada impede sua nova utilização e a admissão
do componente que a confere; isso não encerra automaticamente processos já
iniciados. Não apagar perfis, banco, reservas ou recibos para representar revogação.

O marcador Root0600 `/var/lib/raspberry-component-repair/revoked` fecha a
inicialização do bootstrap atual, incluindo o guard. **Na implementação atual,
isso também faz os outros dispatches MCP que consultam o guard recusarem novas
mutações.** Parar só `raspberry-component-guard.socket` tem o mesmo efeito de
falhar fechado. Não apresentar esses passos como revogação seletiva do perfil
do host com todas as demais mutações preservadas. Consultas de diagnóstico
continuam disponíveis, com a admissão do núcleo desconhecida/inativa.

Para retirar a integração preservando outros catálogos, preparar reversão
coordenada do broker e seus pins antes de parar o guard, mantendo os flocks e
os beforeimages. A reversão do instalador atual só admite ausência de qualquer
operação de componente registrada. Se houver uma, observar e reconciliar seus
IDs; usar somente sua reversão vinculada quando permitida e preparar um plano
específico de desativação. Não restaurar políticas antigas sobre operações
existentes, matar o Codex ou remover state para fazer o instalador aceitar.

Não criar ou sobrescrever marcador existente sem verificar sua identidade.
Revogar o transporte de um cliente, o catálogo de Storage ou a delegação de
tarefas são operações distintas; uma não deve ser apresentada como prova de
revogação de todas as outras.

## Saúde de armazenamento sem limpeza legada

Os pedidos antigos de Storage Health atualizam somente observações. O
processador `scripts/process-storage-maintenance-request.sh` seleciona
explicitamente `--apply --category report`: nesse ramo, `apply` permite gravar o
pequeno relatório de métricas, sem selecionar qualquer função de limpeza.
Não substituir essa lista por categorias padrão ou `all`.

O script interno `scripts/storage-health-maintenance.sh` mantém compatibilidade
com chamadores antigos que passam `--apply`, mas opera sempre em `dry-run`.
Registra `requested_mode` e `cleanup_enabled=false`, não remove os candidatos e
obtém seus tamanhos por metadados, sem abrir conteúdo. Seu `reclaimed_bytes` é
zero; uma redução de uso causada por outro processo permanece uma observação
separada. Backups, contexto, configurações e credenciais continuam preservados.

Limpeza pelo cliente usa somente o catálogo fechado e a política aprovada,
com plano, quarentena recuperável, limites e confirmação da interface. Nem o
health check nem um webhook acionam a rotina legada de exclusão. Não há uma
nova agenda de limpeza no host. Testes sintéticos de preservação estão em
`scripts/storage-health-observation.test.mjs`; execução natural e verificação
de dados mantêm evidência própria.

O relatório existente também publica metadados Docker para `disk_space`:
quatro agregados e até cinco imagens com identificadores opacos e tamanhos
inspecionados. O produtor usa no máximo três comandos de leitura, 256 linhas
de inventário, 65.536 bytes por comando e prazo de cinco segundos, com até um
segundo adicional para encerrar seu próprio subprocesso. Os agregados seguem
a precisão exibida pelo Docker; a seleção das maiores imagens usa tamanhos
arredondados e informa os bytes exatos dos candidatos inspecionados. Categorias
compartilham dados e não devem ser somadas.

O MCP consome somente o mesmo relatório fixo; seu sandbox continua sem socket
de controle Docker. O relógio da medição é preservado: após cinco minutos o
dado é antigo, e falha de coleta permanece desconhecida, sem virar zero. Uma
falha na lista de imagens preserva os agregados válidos e informa cobertura
parcial. Relatório ausente ou antigo não comprova pane do Docker. Na execução
somente `report`, `last_reclaimed_bytes` é zero; a diferença global do filesystem
fica separada e não comprova limpeza. Os testes correspondentes usam fixtures,
sem consultar o daemon residencial.

## Falha na atualização de dependências Node-RED

O diagnóstico sanitizado reconhece o nó `daily_update_dependency_parse_result`
(Normalizar resultado npm) e o motivo fechado
`repository_dependency_validation_failed` quando o recibo contém exatamente
`reason=nodered_dependency_validation_failed`. Um erro genérico permanece
`repository_dependency_update_failed`. Nome do pacote, identificador do pedido,
texto desconhecido e dados privados não são exportados pelo sanitizador.

Esse motivo localiza a etapa de validação; não identifica uma exceção interna
que não foi registrada. A ausência de campo `rollback` é desconhecida, não
confirma reversão. Reconciliar o recibo original antes de qualquer novo reparo;
não repetir atualização em produção apenas para tentar reproduzir o erro.

Fonte, artefato gerado, funções carregadas e sanitizador instalado são camadas
separadas. Publicar o código não comprova implantação nem correção funcional.
Uma implantação revisada deve preservar todos os demais nós, propriedades,
credenciais e revisão da API, com verificação posterior e reversão própria.
O catálogo e a admissão atuais continuam sendo a autoridade dos efeitos.

## Administração pelo cliente MCP autorizado

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

O executor lê `AGENTS.md` e o contexto privado vigente em
`.local-state/eva-maintenance/ACTIVE-GOAL.json`, que aponta para o checkpoint
operacional. O operador mantém esse contexto fora do Git, com o escopo atual,
restrições e operações que exigem reconciliação. Ele não concede autoridade:
admissão, identidade, cotas e prazo continuam nas políticas seladas. Contexto
ausente ou contraditório mantém somente observação. Não encaminhar tarefas a
checkpoints históricos ausentes nem congelar uma validade antiga no prompt.
A alteração das instruções exige revisar os hashes transitivos existentes;
não muda o perfil ou dispensa a verificação real de cada efeito.

Procedimento:

1. Registrar objetivo, critérios, chave e IDs distintos de criação/envio no
   checkpoint central **antes** da chamada com efeito.
2. Criar uma vez; guardar o ID de criação e o ID real da thread retornada.
3. Confirmar identidade, durabilidade e prontidão pelo status. Criação não envia
   o objetivo nem comprova inferência. `notLoaded` não significa conclusão.
   `durable_ready` mantém a reserva até o primeiro envio. Não reconhecer uma
   criação saudável: a reconciliação de criação é reservada à ausência
   `missing_before_first_send` comprovada, sem envios anteriores.
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
sudo -n -u USUARIO_ADMIN_DELEGADO /usr/bin/sudo -n /usr/bin/id -u
```

`USUARIO_ADMIN_DELEGADO` representa o binding local já autorizado.

Esses comandos pertencem ao executor local, não são ferramentas de shell do
MCP nem devem ser enviados como parâmetros de transporte. Se a autenticação
local não estiver disponível, parar e informar o requisito exato; não capturar
senha nem usar Docker como contorno.

Também testar repetição com os mesmos IDs e parâmetros: deve retornar os
mesmos IDs de thread/turno com `duplicate=true`. Guardar o recibo terminal antes
do reconhecimento. O aceite atual passou por criação, envio, resultado,
reconciliação e duplicatas reais pelo cliente MCP remoto, com uma inferência.

### Aplicação e reversão Node-RED comprovadas

O [recibo sanitizado](../../scripts/raspberry-mcp/nodered-controlled-deployment.acceptance.json)
registra aplicação, reversão e reaplicação por tarefas MCP reais. O pacote altera
seis corpos de Function nodes: quatro adaptadores do observador do host, o
terminal dry-run e dois fragmentos de diagnóstico já publicados que ainda não
estavam carregados. As demais propriedades, ligações e geometria permanecem
iguais. O hash carregado e o persistido foram conferidos em cada fase, com os
horários de início dos sete serviços residenciais preservados.

Cada fase executou reset, baseline, falha, confirmação, repetição para dedupe,
recuperação e limpeza no runtime Node-RED, pelo mesmo caminho de decisões até o
terminal compartilhado. Os recibos correlacionados trazem `simulated: true` e
`dispatched: false`; nenhuma entrega de notificação foi usada como teste.
Isso comprova a transação controlada e o replay nativo. Entrega natural Events,
consumo pelo cliente MCP autorizado, recuperação de integrações e continuidade de 24h exigem suas
próprias evidências.

A rota delegada deve ser explícita no comando selado. UID numérico observado
não comprova, sozinho, autorização para `sudo` direto. A tentativa direta foi
recusada antes do helper; a rota dedicada já aprovada executou o pacote. Não
alterar sudoers ou solicitar senha para corrigir essa diferença de invocação.

Consultar andamento pode preencher o cache de resultado com `inProgress`.
O [gate compartilhado](../../scripts/raspberry-mcp/runtime-source/administrative-recovery/scoped_task_admission.py)
admite essa observação somente para o envio esperado, tarefa/hash/turno exatos,
schema fechado de quatro campos e `completed_at: null`. Resultados terminais,
desconhecidos, malformados, turnos diferentes e outras reservas pendentes
continuam bloqueando. A regressão reproduz a recusa do gate anterior, e os
recibos de reversão/reaplicação confirmam esse caso no runtime. O bundle
original aplicado é preservado; a revisão do protocolo confere seu selo e
payload antes de prosseguir, com novos IDs para envios comprovadamente recusados
antes de qualquer intent. IDs consumidos não são reaproveitados para uma nova ação.

As fontes do [controller fixo](../../scripts/raspberry-mcp/runtime-source/administrative-recovery/apply_nodered_dry_run_receipts.py)
e do [cliente Admin API](../../scripts/raspberry-mcp/runtime-source/administrative-recovery/nodered_receipt_client.cjs)
permitem revisar CAS, intents anteriores a cada POST, barreiras de execução,
limpeza e revogação da sessão opaca. O cliente expõe somente os endpoints
necessários e injects sintéticos nomeados. Esses artefatos descrevem uma
transação consumida; não são um instalador genérico nem autorização para repetir
suas fases ou importar políticas locais de outro servidor.

O resultado da tarefa usa exclusivamente JSON com `operation_id`, `project`,
`state`, `summary` e `next_step`. `state` aceita somente `checkpoint`,
`progress`, `blocked` ou `complete`; `completed` e `failed` são inválidos para
o texto da resposta, mesmo quando aparecem no recibo externo da operação.
Dois JSONs soltos ou saída livre podem produzir
`answer_withheld`. Preserve o recibo terminal e reconcilie seu hash; se precisar
do relato, use um novo envio de checkpoint na mesma tarefa, explicitamente sem
ferramentas ou efeitos e dentro do orçamento. Confirme o relato com o estado do
componente. O leitor legado de threads aceita somente referências registradas;
não ampliar sua allowlist para ler uma tarefa recém-criada.

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
  em `/etc/sudoers.d/<CONCESSAO_APROVADA>`, preservando os recibos.
  A remoção não encerra automaticamente processos root já iniciados.
- Revogação de cliente: remover o acesso ao transporte/chave/conta específica;
  não revogar por acidente a assinatura ou o túnel compartilhado de outros
  clientes. A identidade compartilhada atual não oferece revogação por chatbot.

<a id="reconciliar-control_socket_changed-sem-reiniciar-o-codex"></a>

## Reconciliar `control_socket_changed` sem reiniciar o Codex

O adaptador confere o dispositivo/inode do socket e o PID/UID obtidos por
`SO_PEERCRED` antes de cada RPC. Um daemon substituído pode publicar outro
inode no mesmo caminho. O alias continuar válido e o serviço estar online não
atualizam a autorização Root. O cliente abre uma conexão por consulta; esse
caso não exige apagar um cache ou reiniciar o daemon.

Compare o listener publicado no perfil autorizado com a origem do bind mount,
proprietário, modo `0600`, identidade do processo, início do processo e
executável instalado. Leia somente as referências autorizadas, sem retomar
threads. A documentação do
[App Server](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
distingue `thread/read` de `thread/resume`: a leitura de metadados não carrega
a thread. `notLoaded` não comprova conclusão nem bloqueio. Conserve separados
o estado atual, o último resultado registrado e falhas de observação.

O helper puro
[`control_binding_review.py`](../../scripts/raspberry-mcp/runtime-source/administrative-recovery/control_binding_review.py)
planeja somente a substituição revisada de PID/inode e seus pins: política
legada, hash dessa política na política de tarefas e hashes das duas no
catálogo de reparos. Ele preserva datas de aprovação, validade, boot, referências,
limites, código e campos futuros. Não descobre sockets, escreve, envia RPC ou
renova autorizações. A aplicação exige pacote Root protegido, prévia contra os
bytes originais, nova conferência do mesmo peer, locks e intent anterior à
troca. Conserve os backups e consulte o estado após perda de retorno; não
repita a aplicação nem reenvie operações incertas.

O [aceite da reconciliação](../../scripts/raspberry-mcp/control-binding-review.acceptance.json)
registra duas rodadas de `status`/`read` nas três referências, paginação completa
do inventário permitido e preservação dos registros de operações. Um registro
antigo sem metadados confirmados permanece desconhecido. A correção desse
vínculo não amplia a concessão nem comprova a execução atual de todas as tarefas.
