# Reparo e diagnóstico por componente

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Candidato de reparo por componente ainda desativado

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

