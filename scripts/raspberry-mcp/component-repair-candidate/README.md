# Candidato de reparo por componente

Estas fontes e esquemas são preparação isolada. As doze ferramentas propostas
não estão registradas no MCP. Há um worker Node-RED candidato, testado em HTTP sintético; não há instalador
ou permissão de produção neste diretório. O transporte MCP instalado está documentado em
[RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md](../../../docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md).

## Contrato proposto

Os esquemas completos ficam em [schemas.mjs](schemas.mjs). Todos recusam host
diferente de `raspberry`, parâmetros extras e caminhos/comandos livres.

| Ferramenta | Entrada adicional ao host | Finalidade |
| --- | --- | --- |
| `component_list` | nenhuma | listar componentes disponíveis |
| `component_read` | component_id, view; artifact_id, offset e expected_digest quando aplicáveis | ler fonte revisada e versão observada |
| `component_prepare_repair` | operation_id, task_id, component_id, artifact_id, expected_source_sha256, old_text, new_text | preparar mudança vinculada à tarefa |
| `component_validate_repair` | operation_id | registrar validação isolada |
| `component_apply_repair` | operation_id, expected_loaded_sha256 | aplicar versão validada |
| `component_repair_status` | operation_id | consultar estado e resultado sanitizado |
| `component_repair_reconcile` | operation_id | reconciliar sem repetir efeito |
| `component_verify_repair` | operation_id | verificar prova funcional e registrar resultado |
| `component_revert_repair` | operation_id, expected_loaded_sha256 | reverter com backup e versão conferidos |
| `component_scope_release` | operation_id, result_hash | liberar reserva terminal com resultado confirmado |
| `component_cancel_repair` | operation_id | cancelar somente antes do efeito |
| `task_scope_list` | page_size e cursor opcionais | listar reservas sanitizadas |

`component_id` admite `localizacao_pessoas`, `observacao_host`,
`external_heartbeat` e `icloud_adapter`. `view` admite `catalog`, `topology`,
`parameters`, `source` e `version`. IDs de operação/tarefa/artefato são
hexadecimais de 32 caracteres; hashes têm 64. Os fragmentos `old_text` e
`new_text` são limitados a 4.000 caracteres, dados para revisão e não comandos.
`expected_source_sha256` identifica o artefato editável revisado; a identidade
do runtime é separada. Preparar não autoriza executar o conteúdo da mudança.

O gateway futuro precisa vincular tarefas ao registro autenticado existente,
compartilhar seus contadores e verificar componentes reservados. Os callbacks
injetáveis destes módulos são interfaces internas de teste, não argumentos
do chatbot. Booleanos ou provas fornecidos pelo cliente não substituem
observações e recibos protegidos do executor.

## Fonte, configuração carregada e execução

O hash do conjunto de artefatos revisados não é o hash dos objetos de código
carregados. O leitor informa `source_identity_kind`, `loaded_identity_kind`,
`comparison_state` e `matches_reviewed_source`; identidades incompatíveis não
são comparadas e mantêm a relação desconhecida.

No Node-RED, `nodered_scoped_configuration_v1` identifica somente o canvas
permitido. A comparação normaliza `wires` ausente como vazio e remove apenas
arrays de portas vazias no final. Preserva posições das portas conectadas,
destinos, outputs, código e demais parâmetros. O arquivo revisado original
permanece intacto. Isso prova configuração implantada, sem provar execução
ou recuperação funcional. Conteúdo carregado não revisado resulta em unknown;
seu texto ou hash privado não é exportado.

Para iCloud, a prova existente contém fingerprint dos objetos Python no
processo HA. O port deve conferir nonce já existente, revisão, idade, PID e
instante de início no namespace do contêiner fixo, sem exec, login Apple,
refresh ou leitura de localização. `entry_ready` não comprova saúde remota.
Um hash dos arquivos não substitui essa prova.

O heartbeat pode comprovar aceite HTTP pelo provedor e preservar falhas antigas
após sucesso posterior. O produtor nativo já emite identidade dos objetos de
código, vinculada à mesma amostra e à invocação concluída do systemd. Sem
essa prova e os bindings revisados, a versão permanece unknown. Os ports reais foram exercitados somente pelo
executor administrativo existente; não estão disponíveis à Eva nas ferramentas
propostas. Arquivos privados, bindings, registros e capturas reais não integram
este diretório público.

## Gates e recibos

Aplicação e rollback exigem confirmação explícita de coordenação; aplicação
também exige recursos confirmados. Ausência, número ou texto no lugar de true
não concede autorização. Intenção é persistida antes do efeito. Resposta
incerta mantém a reserva; reconciliar exige operação exata, recibo verificado
e executor terminal. Ver o hash esperado sozinho não comprova aplicação ou
ausência de envio. Reservas não expiram para liberar efeitos incertos.

Prova funcional exige falha anterior e sucesso posterior da mesma chamada,
componente e operação corretos, tempos finitos/coerentes, regressões verificadas
e ausência de testes domésticos adicionais. Heartbeat exige recibo do destino.
Saúde do contêiner, notificação removida ou notLoaded não encerram a tarefa.

## Teste e ativação futura

```sh
node --test --test-concurrency=1 scripts/raspberry-mcp/component-repair-candidate/candidate.test.mjs scripts/raspberry-mcp/component-repair-candidate/schemas.test.mjs
```

Os testes usam SQLite temporário, relógios e efeitos falsos. O worker usa apenas um servidor HTTP sintético em loopback. Não chama o
daemon, Home Assistant ou dispositivos reais. Participam de make validate-public.

Antes de ativar a ampliação: concluir ports/executor, reservas e orçamentos
compartilhados; preparar diff, hashes, identidade, validade e revogação; obter
a aprovação específica exigida; então instalar pela cadeia existente e validar
submissão, resultado e prova natural pelo cliente MCP real. Não copiar estas
fontes sobre uma política ativa nem interpretar a publicação como aprovação.

## Worker Node-RED com recibo durável

[effects/nodered_effect.cjs](effects/nodered_effect.cjs) contém cliente HTTP
e armazenamento real de recibos. O host, a porta e a autenticação são binding
do operador; nunca parâmetros do chatbot. Não há entrypoint privilegiado instalado nem registro MCP. O port de
subprocesso interno está descrito abaixo; o bootstrap root continua pendente.

O controlador protegido deve comprovar tarefa, principal, revisão da candidata,
budget compartilhado reservado, recursos, validade e posse do lock de manutenção.
O worker confere a identidade exata e a idade dessa admissão. Os testes usam
um provedor falso; seus booleanos não são autorização para produção.

Somente func em nós function ou rules em nós change podem variar no canvas
permitido, após revisão e validação isolada. Nós, tipos, conexões, alvos de
efeitos, libs, initialize e finalize ficam congelados. Funções com inicialização
ou finalização não vazia são recusadas. A restrição estrutural não substitui
a revisão semântica da lógica nem autoriza efeitos residenciais adicionais.

Antes do POST, o worker persiste identidade, backup apenas do canvas permitido
e intenção. Usa rev do Admin API e deploy do tipo nodes. Confere configuração
carregada, identidade esperada e preservação das demais fontes. HTTP 409 tem
recibo de rejeição sem efeito; não é ausência de envio e não dispara retry.
Resposta perdida, verificação divergente ou recibo terminal incompleto mantém
incerteza. Um hash desejado sozinho não resolve o caso.

Apply e rollback usam o mesmo ID de operação e stores separados por finalidade.
O rollback lê o backup protegido, confere a versão e registra intenção própria;
não apaga a aplicação ou seus recibos. Pedidos duplicados leem o recibo existente.
São até 64 operações e 32 MiB por store, sem exclusão automática para liberar
espaço. Diretório/arquivos têm owner do executor, modos 0700/0600, sem symlinks
ou hardlinks; conteúdo e quantidade são limitados.

Falha de revogação da sessão fica explícita. O coordenador mantém pendência de
limpeza, bloqueia novas aplicações e não libera a reserva nem confirma prova
funcional até receber evidência protegida. Uma reversão não apaga pendência
de autenticação da aplicação anterior. Sucesso funcional precisa ser posterior
à conclusão real do deploy, com operação, tarefa e componente corretos.

O teste entre Python, processo Node filho, filesystem e servidor HTTP falso
perde a resposta ao coordenador após o deploy. Recupera o recibo da mesma
operação e reconcilia sem outro POST. Esse teste não é aceite MCP ou produção.

Fluxos distintos já implantados podem aguardar prova funcional enquanto outra
aplicação disjunta ocorre serialmente. Efeito em andamento/incerto ou limpeza
pendente continua bloqueando globalmente; a reserva do mesmo componente não é
liberada por tempo decorrido.

A reconciliação aceita o recibo terminal verificado com `action` exata tanto
para aplicação como para reversão. Uma rejeição definitiva pode conservar
`collection_error` com o motivo (`revision_conflict`), sem se tornar falha de
coleta. Sem identidade completa, recibo terminal verificado e ausência de
efeito comprovada, o erro mantém a operação incerta. A reserva continua retida
quando a reversão foi rejeitada; isso não significa que a versão antiga voltou.

## Admissão protegida e bloqueio de manutenção

[`admission.py`](admission.py) implementa ports internos; não tem CLI nem rota
MCP. O bootstrap root deverá fornecer as dependências e caminhos fixos. Nada
nesse módulo aceita caminho, política, principal ou sinalizador de privilégio
do cliente MCP.

`TaskBudgetPort` usa o lock `coordinator.lock` existente e chama o verificador
de integridade/política instalado. Consulta os bancos de tarefas e legados em
SQLite somente leitura, sem construir os Stores mutáveis, executar DDL,
reservar outro envio ou consumir uma inferência. A tarefa e o envio exatos
precisam existir, ter thread/turn registrados e pertencer à delegação
administrativa. Resultado concluído exige reconciliação. Outros envios
incertos, resultados pendentes e reservas conflitantes bloqueiam a aplicação.
Falhas históricas terminais permanecem no banco. A contagem usa a janela de
24h existente e inclui envios legados e recusados, como o controlador atual;
o envio pai já contado não é contado de novo. Não redefine o limite de
48 envios ou o espaçamento de 60 segundos. Esses são limites de tarefas,
separados das seis tentativas/24h e dez minutos dos Events.

`MaintenanceLease` adquire o flock real do scheduler, sem criar ou substituir
o arquivo de lock. Mantém o descritor aberto até a saída, inclusive quando
ocorre erro. Confere identidade do inode e os gatilhos `processing` de update
e Git; nenhum gatilho é removido. Teste em dois processos comprova exclusão e
liberação. Os testes usam caminhos temporários; nenhum teste bloqueia ou
dispara manutenção residencial.

`ProtectedReview` exige registro protegido de owner/modo e vincula operação,
tarefa, envio, principal, componente, ação e identidades de versão. Aplicação
e reversão têm registros distintos e o mesmo ID de operação. O registro não
é um argumento do MCP. `ProtectedAdmission` exige ambos os locks, revisão,
política vigente, margem de 90s para finalizar, gate de recursos existente e
observação root recente dos demais executores. A leitura do registro de
threads sozinha **não** prova ausência de outros efeitos administrativos.

O pai, o IPC limitado e os leitores de jobs descritos a seguir já têm
implementação e testes isolados. Restam o bootstrap com bindings fixos, criação
segura das revisões e gates recíprocos nos outros caminhos de mutação. As
fixtures de admissão não são autorização root. Leituras owner-only reais não
constituem aceite MCP nem acesso novo da Eva. Não registrar ferramentas ou
executar aplicação antes de completar e revisar o pacote e sua revogação.

## Processo pai, IPC e observação dos executores

[`worker_parent.py`](worker_parent.py) implementa a execução do worker Node-RED
como subprocesso fixo. `run()` recebe somente ID e ação; o conteúdo preparado
vem de um arquivo protegido. O pai confere owner, modo e SHA dos três módulos
antes de lançar `/usr/bin/node` com argumentos fixos. Não há shell. Fontes,
diretórios de estado, autenticação existente e descritores são bindings
internos do futuro bootstrap root, não campos de ferramenta.

Um socketpair privado permite duas consultas sequenciais de admissão,
com ID/tarefa/principal/versões/ação exatos e frames limitados. Credenciais
existentes transitam por outro descritor herdado, não por argv, ambiente ou
logs. O pai faz um preflight antes de ler credenciais. A observação usa precisão
canônica de milissegundos, comum a Python e Node; isso evita rejeitar uma prova
válida por diferença de precisão, sem tolerância adicional para datas futuras.

O pai mantém os locks até a saída do filho. Há prazo máximo de 75s, limites
de heap/CPU/descritores e nenhum core dump. Linux `PR_SET_PDEATHSIG` impede que
o filho continue quando o processo que segura os locks morre. O teste mata
apenas um pai sintético e confirma a saída do seu filho. Resposta perdida após
um grant mantém incerteza; não causa novo POST. Antes de qualquer grant, a
recusa pode gerar recibo protegido de ausência de efeito. Resultado terminal
só é aceito do recibo durável, vinculado à mesma operação. Conteúdo adicional
ou não revisado no recibo é recusado; stdout/stderr brutos não são exportados.

[`executor_observer.py`](executor_observer.py) consulta, sem instanciar Stores
mutáveis, o executor administrativo antigo, jobs duráveis, journal de deploy
e jobs do novo coordenador. Exige locks reais de operações/admin/manutenção.
Uma tentativa histórica `held` só deixa de bloquear quando o contrato root e
os hashes da linha/audit confirmam a correção vinculada em `verified` ou
`contained`. A linha original não muda. Tarefas incertas, cleanup pendente,
novas operações concorrentes e coleta falha continuam bloqueando.

Essa exclusão cobre executores registrados e os locks compartilhados; não
representa exclusão de toda atividade root nem saúde residencial. Uma leitura
owner-only dos registros existentes confirmou a correção vinculada e nenhum
job durável ativo, mas não provou a exclusão de um job novo de componente nem
executou reparo. A integração completa não está instalada.

Faltam criação segura das revisões, bindings/instalador/controle durável dos
jobs e gates nos outros caminhos de mutação para que respeitem reservas ou
incertezas do novo coordenador. Heartbeat e HA ainda precisam de ports de
efeito. A identidade do código do heartbeat já foi emitida e vinculada em
ciclo natural pelo produtor instalado, com leitura owner-only; isso não
ativa o port no MCP. Não ativar o acesso novo com apenas este subprocesso: apresentar o
pacote completo de integridade, validade e revogação e obter aprovação
específica antes do aceite real pelo MCP.
