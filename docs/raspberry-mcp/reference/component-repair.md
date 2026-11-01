# Reparo e diagnóstico por componente

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Núcleo protegido instalado com perfil inicial do host

O núcleo Root foi instalado e consultado pela interface MCP real. O campo
`evidence.data.protected_component_maintenance` de `maintenance_capabilities`
retornou coleta válida e perfil `observacao_host`. Uma chamada real de envio na
mesma tarefa registrou e preparou a candidata; a validação nativa isolada passou
pelas nove verificações do perfil. Tentativas anteriores foram recusadas antes
do efeito, com recibo terminal e limpeza confirmada. Uma execução posterior
concluiu aplicação, confirmação da identidade carregada, teste funcional isolado
após a aplicação e leituras nativas finais. A operação foi verificada e liberada.
Esse aceite cobre somente o isolamento de status do reset de teste do observador;
não equivale a replay completo do fluxo, saúde residencial, reversão real ou
atuação espontânea do cliente.
Uma tentativa posterior concluiu a selagem normalmente, mas terminou a fase de
aplicação sem recibo nativo verificável. Sua incerteza original foi preservada e
posteriormente reconciliada por prova forense protegida de falha anterior ao
registro do worker. O resultado identifica essa origem e não afirma ter
recuperado a saída perdida do processo. A operação foi liberada sem repetir o
efeito. A regressão isolada, por si só, não autoriza essa reconciliação.

A leitura do inventário aceita os quatro registros que o executor já admitia e
continua rejeitando um quinto. A consulta MCP real confirmou os quatro registros
liberados, sem jobs pendentes ou reservas lógicas ativas. Após a mudança de fonte,
o perfil inicial fica obsoleto e informa `profile_refresh_required`; isso não
deve ser confundido com falha do transporte nem com autorização para repetir a
proposta antiga. Um novo reparo exige perfil e proposta compatíveis com a fonte
atual. A recorrência permanece uma configuração separada.

As [fontes exportadas](../../../scripts/raspberry-mcp/runtime-source/component-repair/README.md)
separam autorização, reservas duráveis, observação somente leitura, escrita
canônica, validação isolada, revisão, efeito e recibos. A exportação remove
bindings temporários e não instala políticas, concede sudo ou ativa agenda.
Cada entrada de `SOURCE-MAP.json` informa quando os bytes de origem foram
observados. O snapshot público pode anteceder uma correção instalada ou uma
candidata em revisão: confira os hashes atuais antes de usar a exportação para
reinstalar ou diagnosticar o runtime. Aprovação de uma candidata não comprova
sua instalação; a existência de um arquivo instalado não comprova sua execução.
O transporte imediato usa `codex_task_create`, `codex_task_send`,
`codex_task_status` e `codex_task_reconcile`; nenhum nome ou schema novo de
ferramenta foi necessário. As doze ferramentas do protótipo histórico abaixo
continuam fora do catálogo ativo.

### Descoberta e execução

1. Consultar as capacidades atuais. `execution_active` descreve admissão para
   uma nova preparação; não é permissão genérica ou prontidão funcional.
   Conferir `component_id`, `pending_jobs`, `active_reservations`,
   `canonical_before_matches_profile` e `profile_refresh_required`. Uma operação
   própria já registrada conserva gates independentes para suas fases.
2. Registrar criação/envio reais e conferir o perfil administrativo. O request
   protegido vincula operação, tarefa e esse mesmo envio; texto, flags ou IDs
   inventados não constituem autorização. Um turno diferente do request precisa
   de vínculo revisado antes de executar. Não enviar outro turno para repetir
   fase cujo resultado esteja incerto.
3. O executor usa o CLI interno fechado para `prepare`, `validate`, `seal`,
   `apply`, `rollback`, `status`, `reconcile`, `verify`, `cancel` e `release`.
   Não são ferramentas MCP de shell. Antes de `seal`, o operador autorizado
   revisa o diff e os hashes reais de fonte/render; o modelo não fornece
   simplesmente um booleano de teste aprovado.
4. Aplicação e reversão são jobs duráveis, com intent antes da solicitação
   nativa, CAS de fontes e configuração, locks e revogação da sessão. Status e
   reconciliação não repetem testes, POST ou compensação. Um resultado incerto
   preserva sua reserva. Cancelamento e liberação obedecem ao estado comprovado
   e conservam o histórico.
5. Guardar o resultado terminal e reconhecer o hash exato do turno. Verificar
   separadamente o comportamento nativo exigido pelo componente e a execução
   específica do cliente. Hash carregado, fonte publicada e diagnóstico ativo
   não substituem essas provas.

### Recibos parciais e diagnóstico de recusa

Uma publicação pode terminar de gravar os quatro artefatos e falhar ao devolver
o resultado ao chamador. Antes de concluir que nada ocorreu, confira o recibo,
os hashes e as identidades dos arquivos. Uma reconciliação autorizada pode
concluir uma transição de estado comprovadamente ausente; não deve republicar
os artefatos nem repetir um efeito incerto. Preserve também a falha original.

O diagnóstico protegido do executor registra etapa, classe de exceção, errno e
razão de uma lista fechada. Mensagens livres, argumentos, traceback, credenciais
e payload não fazem parte desse resultado. Uma recusa anterior ao lançamento
do processo não prova falha de autenticação ou indisponibilidade do Node-RED.

Uma incompatibilidade reproduzida na revisão anterior ocorria porque o pai podia preservar
`diagnostic.json` junto ao recibo de recusa, mas o registro do worker rejeitava
esse nome ao examinar operações anteriores. A correção admite somente esse nome
adicional, preservando ownership, modos, links, quantidade e limites de bytes.
Não remova o diagnóstico para contornar o bloqueio.

A reserva lógica do workflow e a reserva de armazenamento têm ciclos separados.
O preparador soma bytes presentes e espaço ainda prometido; espaço livre no host
não substitui esse limite. Encerrar uma operação não apaga seus artefatos nem
libera automaticamente a reserva de disco. Uma reconciliação de reserva precisa
comprovar o encerramento, ausência de efeito e limpeza de segurança, preservar o
recibo original e excluir concorrência. Não aumente o teto nem faça prune para
mascarar uma reserva obsoleta. Uma falha antes de criar a preparação exige prova
desse ponto exato antes de continuar somente a etapa ainda não executada.

Uma reconciliação forense usa evidência Root separada, vinculada à operação e
ao resultado por hash. O resultado conserva `receipt_origin`,
`original_worker_receipt_present: false` e `historical_stdout_recovered: false`.
Não se cria um recibo nativo retroativo. A verificação precisa demonstrar que o
registro obrigatório não ocorreu, que o código correspondente era o pinado,
que o executor terminou, que as fontes continuam consistentes e que não há
limpeza de sessão pendente. Essa prova não é reparo funcional nem autorização
para repetir a operação. A confiança pressupõe integridade do host Root.

Uma operação adicional exige a admissão vigente e um envio novo ainda ativo,
na mesma tarefa e proposta. A liberação de uma operação antiga não apaga seu
registro, não renova autoridade nem zera cotas. Confira o limite efetivo no
contrato atual; não deduza autorização de repetição a partir de um erro.

Para revisar a checagem de frescor, compare a observação com o relógio obtido
depois da coleta e revalide a margem da autorização. Rejeite observações antigas
ou futuras. Para revisar a publicação, confira também o contrato de retorno:
o hash de revisão verificado no recibo deve chegar ao chamador que o exige.
Esses dois contratos têm regressões isoladas; sua correção candidata permanece
distinta de instalação e aceite nativo.

### Escopo e isolamento

Só `observacao_host` está habilitado. O perfil restringe nove fontes canônicas e
uma revisão Git pública coerente, sem copiar configuração privada para testes.
Mudar outro componente ou avançar a revisão exige novo perfil e validação
protegidos. `profile_refresh_required` mantém esse requisito visível.

O rename atômico do SourceWriter requer acesso às duas pastas pai; a restrição
aos nove nomes é aplicada pelo código Root pinado, com comparação de bytes,
metadata e inode. O candidato executa somente no sandbox UID65534, sem rede,
credenciais ou dados privados. A publicação de uma fonte não a executa.

O guard de concorrência é um socket interno somente de leitura/admissão, sem
credencial e com capabilities vazias. Um bind readonly de um único lock permite
comparar seu inode com o WRITE FLOCK do peer em `/proc/locks`, sem alterar modo,
ACL ou proprietário original nem conceder DAC/ptrace amplo. As mutações dos
dispatches registrados consultam esse guard; os executores também checam jobs
legados, reservas, locks de manutenção e estados desconhecidos.

O consumidor funcional inicial prova o defeito específico do reset de teste do
host em execução isolada e sua correspondência com o hash carregado. Ele declara
`native_full_flow_replay: false`: o replay no runtime Node-RED real continua
separado. Não certifica saúde física, Zigbee, outras integrações, reação da Eva
ou a meta completa. A recorrência permanece **desativada**, sem transformar
saúde/webhooks em executores de manutenção.

O núcleo e os contratos não selecionam modelo. Outro chatbot pode usar o mesmo
MCP e a mesma autoridade local; a rota atual de tarefas ainda depende do
adaptador/daemon Codex. Trocar o executor também requer implementação e aceite.

## Protótipo histórico de doze ferramentas desativadas

O [protótipo e seus esquemas](../../../scripts/raspberry-mcp/component-repair-candidate/README.md)
separam fonte revisada, identidade carregada, reservas, recibos e prova funcional.
As doze ferramentas desse protótipo não pertencem ao catálogo ativo. Leitura
administrativa real confirmou as identidades dos dois canvases permitidos e
a prova de código do processo iCloud; isso não equivale a acesso do cliente MCP autorizado ou
execução de reparo pelo MCP. O heartbeat já emite identidade de código em
ciclo natural, vinculada à invocação concluída pelo systemd; a leitura
owner-only não ativa ferramentas novas para o cliente MCP autorizado.

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
[guia do diagnóstico iCloud](../../../scripts/raspberry-mcp/icloud-readiness-candidate/README.md).
A exportação pública tem bindings desarmados e políticas privadas ausentes;
não deve ser copiada sobre uma instalação viva. O aceite do cliente MCP
não identifica por si só uma execução específica do cliente MCP autorizado/dots.


## Contrato iCloud carregado e tentativas naturais

A ampliação de 26/10 acrescenta `native_contract` ao diagnóstico iCloud existente.
O cliente MCP real recebeu os oito booleanos dos dois papéis fixos, vinculados
à prova do processo e ao setup público carregado. A coleta preserva seu horário
original, limita validade independentemente e não chama serviços nem o provedor.
Uma chamada natural posterior registrou erro na etapa `provider_refresh`; a fase
`entry_waiting_user` e o reparo visual confirmado pelo proprietário apontam a
necessidade de reautenticação manual. Isso não comprova a causa de toda falha
histórica nem autoriza OTP automático ou captura de senha/código no chat.

O pacote preservou registros de entidades/dispositivos/entradas, Recorder e
horários dos outros seis serviços. A configuração HA passou antes do único
restart de carregamento. O aceite atual não equivale a recuperação funcional.
Fontes Root/client, schema fechado, testes de frescor e reversão estão no
[contrato carregado desarmado](../../../scripts/raspberry-mcp/loaded-contract-candidate/README.md).
A exportação não contém concessão, política privada ou instalador armado.

## Diagnóstico de todos os componentes Node-RED

O escopo de leitura inclui todos os fluxos e nós carregados necessários no
Raspberry, além do Kia. O cliente real comprovou paginação dos 31 fluxos,
conexões e código de nó em `observacao_host`. O catálogo estático de fontes
continua disponível; duas raízes virtuais na primeira página acrescentam a
observação carregada e o diagnóstico fixo da atualização Kia:

```json
{"name":"project_files","arguments":{"host":"raspberry","category":"nodered","offset":0}}
{"name":"project_read","arguments":{"host":"raspberry","file_id":"<ID de 32 hex retornado>","offset":0}}
```

Em `project_files`, `offset` continua paginando apenas o catálogo estático.
Raízes virtuais aparecem somente em `offset=0`; `pagination_semantics` informa
essa diferença. Os IDs são opacos e somente leitura. Os documentos JSON podem
ter várias páginas de 4000 caracteres: concatenar `text` seguindo `next_offset`
antes de interpretar o JSON. Recursos internos usam `resource_id`; passar esse
valor em `project_read.file_id`. Seguir `resources`/`next_page` para inventários,
parâmetros, fonte e continuação da fonte. Nenhum parâmetro aceita caminho livre.

Cada coleta recebe snapshot, origem, horário, idade, erros e cobertura. A ordem
do inventário é por ID. Nós globais/configuração são descobertos pela raiz
`all_nodes`. Código e parâmetros só são divulgados após correspondência com
commit público aprovado e sanitização, com `redacted_fields` e motivo quando
retidos. Drift privado não produz hash dos valores privados. A base dos hashes
de código é `sanitized_reviewed_source`; não confundir com bytes privados.
O processo limita cache e entrada; TTL máximo é 120s. O serviço pode sair após
30s ocioso, exigindo redescoberta antecipada; ID expirado não autoriza acesso
arbitrário nem prova remoção de componente. Não misturar páginas de snapshots.

O proxy local reutiliza usuário e autenticação; não expõe HTTP livre, shell,
Docker, histórico de contexto ou credenciais. A pré-leitura Root tem alvos fixos
e mantém namespace e capabilities vazias. Consultas não injetam mensagens,
criam assinaturas ou executam dispositivos. O listener systemd pode apresentar
UID 0 a frio e UID do serviço durante a operação: o cliente verifica somente
essas identidades previstas, além do dono/modo do inode. Autenticação de
entrada continua pertencendo ao MCP existente, não a um novo chatbot específico.

A ativação incluiu uma correção mínima de retorno TCP do mesmo contêiner,
aprovada especificamente. Não se concede uma subnet Docker. O destino HTTP
permanece fixo. A coleta também tem deadline absoluto, porque request.setTimeout
sozinho não cobre TCP ainda não conectado. Falha não repete autenticação/envio
automaticamente. O cliente preserva reason codes fechados e nunca erro bruto.
Recibos de falhas iniciais, manifestos, recuperações e aprovações são mantidos
fora do Git; a presença do código público não substitui esses recibos.

A leitura nova foi autorizada até revogação, inclusive sua pré-leitura Root fixa.
Isso não renova o prazo administrativo nem permite executar reparos depois dele.
Revogação e rollback comparado estão no
[guia Node-RED e Kia desarmado](../../../scripts/raspberry-mcp/nodered-readonly-candidate/README.md).
Para instalar por outra IA, conectar o mesmo endpoint MCP pelo transporte
compatível e autenticação do proprietário; descobrir o schema, ler as duas
raízes e verificar os campos recebidos. Outra implantação do servidor requer
binding privado, versões/rotas conferidas, política selada, aprovação e teste
pelo cliente real. Não transportar tokens do Raspberry para o chatbot.

## Atualização Kia: estado observado não é instalação

Por padrão, a segunda raiz virtual reúne o sensor da integração, estado protegido
do safe updater, worker, merge/promoção, flags de pendência e agendamento/TZ.
Não é atualização dos dados do veículo. O cliente MCP observou versão 3.19.0 no
manifesto do HA e candidata v3.20.0: merge success às 06:06 UTC e promoção failed
às 06:11 UTC em 26/10. O motivo exato do recibo antigo permanece desconhecido;
`reason_code=null` não é transformado em causa inventada. Auditoria posterior
com conflito não apaga essa falha nem comprova execução install ou publicação.
O agendamento carregado é 03h com fuso America/Sao_Paulo, mas a cadeia antiga
perdeu o ID do ciclo na ponte target-only; correlação por versão é parcial.
O manifesto em HA não é atestado de todos os objetos Python carregados.
Nenhuma instalação, wake, refresh veicular ou operação incerta foi repetida.
O próximo ciclo natural e a recuperação funcional ainda precisam de prova.

No aviso antigo de `host_obs_resource_age`, o cliente MCP confirmou o switch e
normalizador carregados. Cinco casos sintéticos usando o switch e util nativos
da mesma imagem passaram, sem configuração residencial ou rede. O operador
`null` existe nessa versão. O erro histórico não foi reproduzido; não mudar a
política de disponibilidade nem inventar uma causa baseada só no título.

A leitura descrita é implementação comprovada. A aplicação controlada geral de
componentes Node-RED, validação funcional e execução específica do cliente MCP autorizado continuam
aceites separados, sujeitos a locks, versão, reversão e recibo. O desaparecimento
de notificações ou contêiner saudável não fecha esses aceites.

### Indicadores nativos Kia com autorização separada

A leitura opcional `runtime_facts` permanece desarmada sem um vínculo protegido
pelo Root e aprovação específica. Seu escopo corresponde aos seis papéis do
validador existente: combustível, último scan, botão de refresh, botão de alerta,
viagem recente e retorno de comando. A seleção exige uma correspondência única
por papel, na mesma integração, entrada e dispositivo. A descoberta usa somente
metadados do registro de entidades; não lê configuração de contas.

O coletor verifica a identidade já aprovada antes de enviar um template fixo ao
Home Assistant. O resultado contém apenas `missing`, `unknown`, `unavailable`
ou `value`, o horário da coleta e o horário válido do último scan.
Valores numéricos do veículo, atributos, localização e IDs privados ficam fora
da resposta. Os estados dos botões são lidos; nenhum botão é acionado. O módulo
não recebe templates, caminhos ou destinos do cliente e não cria assinaturas,
chama serviços, solicita dados do provedor ou instala integrações.

O vínculo local usa `/etc/raspberry-nodered-diagnostics/kia-runtime-binding.json`,
com owner Root, permissão de leitura para o grupo do diagnóstico, seis alvos
fixos e referência da aprovação. O arquivo não integra o repositório. Vínculo
ausente, inválido ou revogado impede a consulta. A revogação usa o marcador fixo
`/var/lib/raspberry-nodered-diagnostics/kia-runtime-facts-revoked` e encerra a
sessão de diagnóstico para invalidar o cache anterior; não reinicia os serviços
residenciais. Identidade, resposta ou transporte inválidos mantêm `unknown`.
Há prazo absoluto de um segundo e resposta limitada a 16 KiB; falha desta leitura
opcional preserva o diagnóstico de metadados anterior.

Esses fatos não atestam os objetos Python carregados, a causa de uma falha antiga
ou recuperação funcional. O avanço do scan exige duas observações naturais
correlacionadas; continuidade, atualidade e aceite de instalação permanecem
verificações separadas. A fonte publicada e os testes não comprovam ativação:
esta exige aprovação, aplicação selada e nova leitura pelo MCP real.


## Sessão iCloud: transporte, concorrência e aceite

A correção de 26/10 separa transporte tipado durante a validação do token salvo
de autenticação realmente expirada. Um snapshot do gate sob lock evita reparos
falsos durante validações concorrentes. Setup mantém o backoff nativo; keep-alive
não repete a chamada imediatamente. Login primário, renovação autenticada, OTP e
reabertura de estados antigos bloqueados não foram automatizados. O contrato
operacional e seus testes estão em [ICLOUD_MANUAL_AUTH.md](../../ICLOUD_MANUAL_AUTH.md).

O cliente MCP real confirmou os objetos Python novos e a identidade do processo.
Após o reinício, o estado observado continuou `entry_waiting_user`; por isso o
aceite da correção local não equivale a sessão remota recuperada. As chamadas
naturais anteriores concluídas continuam evidência histórica. Os mesmos IDs
do catálogo público foram preservados, com os hashes de fonte revisados
atualizados; nenhum caminho ou permissão de edição foi acrescentado.


## Aplicação e reversão de diagnóstico Kia pelo MCP existente

Em 26/10/2026, a delegação `eva-admin-` existente executou três fases seriais:
aplicação, reversão confirmada e reaplicação de uma correção de diagnóstico Kia.
Cada fase teve criação/envio registrados antes da chamada, recibo root e resultado
terminal reconhecido pelo hash exato. O cliente MCP refez a descoberta e leu todas
as partes do documento Kia entre as fases: os novos campos apareceram, desapareceram
na reversão e reapareceram na reaplicação. Isso comprova efeito real além do catálogo
ou da identidade administrativa.

O pacote modifica somente o promotor, a biblioteca de projeção Kia e seu selo de
dependência. Mantém grants, prazo, quotas, credenciais, rede, integração e recibo
original. O helper exige os locks existentes e exatamente a tarefa/envio admitidos
para aquela fase; qualquer outra pendência impede o efeito. Não altera nem limpa
ledgers. Atribuição permanece no principal já autenticado, sem isolamento
criptográfico novo por conversa.

Apenas `raspberry-nodered-diagnostics.service` foi ativado. Seu encerramento ocioso
após 30 segundos é normal; snapshot expirado exige `project_files` novamente antes
de `project_read`. Paginar o recurso da descoberta atual evita confundir cache
perdido com queda do Node-RED. A projeção conserva etapa desconhecida dos recibos
antigos e não comprova saúde do veículo.

O [aceite sanitizado](../../../scripts/raspberry-mcp/kia-promotion-evidence.acceptance.json)
e o [runbook Kia](../../VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md) delimitam o resultado.
Essa prova cobre a correção de diagnóstico; aplicação geral de flows Node-RED,
consumo natural de Events pelo cliente MCP autorizado e recuperação funcional da candidata continuam
exigindo suas próprias evidências. Não há nova ferramenta ou gateway de shell.
