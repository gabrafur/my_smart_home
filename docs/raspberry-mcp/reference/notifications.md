# Notificações sanitizadas e seus relógios

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

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
| `notification_age_seconds` | Idade da criação/atualização; não mede latência até cliente MCP autorizado |
| `associated_errors` | Exceção, mensagem sanitizada, causas limitadas, até seis frames públicos no total e contexto revisado |
| `associated_errors[].context` | Fluxo e nó quando mapeados publicamente; ausentes permanecem desconhecidos |
| `associated_errors[].observed_at`, `age_seconds` | Momento e idade do registro de erro associado |
| `latest_associated_error_type`, `latest_associated_error_reason`, `associated_correction_guidance` | Diagnóstico associado separado do texto e erro originais do aviso |
| `associated_errors_collection_error` | Associação exata ausente, fonte inacessível ou formato inválido, sem inventar stack |
| `recovery_proven` | Sempre falso nesta ferramenta; remoção e desaparecimento não comprovam recuperação |

`created_or_updated_at` preserva o `created_at` fornecido pelo Home Assistant.
No produtor nativo, criar ou atualizar um aviso atribui um novo horário UTC;
isso não fornece o horário da remoção. `observed_at` pertence ao frame lido
pelo coletor: uma nova fotografia `current` pode atualizar esse campo, portanto
não o trate automaticamente como o primeiro recebimento daquela revisão.
Para medir um trecho, correlacione a mesma revisão com o registro de mudança
retido e declare quais relógios e etapas foram observados. Ausência de horário
de origem ou de registro correspondente permanece desconhecida. Nem a idade
do aviso nem `last_processing_latency_ms` comprovam chegada ou execução no cliente MCP autorizado.

### Horários por revisão dos avisos

O coletor acrescenta `source_timing` a cada mudança nova no seu cache
sanitizado: horário de origem da revisão, entrada no callback, observação pelo
redutor e tipo do frame. O cache mantém schema 1; o marcador
`source_timing_schema_version=1` identifica o produtor que oferece esses
metadados. Eventos anteriores permanecem sem horário adicional. Nenhum desses
campos altera IDs, revisões, payload assinado, assinatura ou orçamento de envio.

O worker registra a primeira observação em `event_source_timing`, no SQLite já
existente. A escrita opcional ocorre em um único savepoint por snapshot, depois
do enqueue canônico. Duplicatas não reescrevem o recibo; falha desse diagnóstico
não autoriza repetir uma entrega nem bloquear a fila original. O limite é 4.352
recibos, correspondente aos limites existentes de eventos e arquivo. Registros
anteriores não são apagados para abrir espaço.

`events_status.ha_notification_source_timing` separa registros retidos, recibos,
fontes medidas e fontes desconhecidas na seleção das últimas 24 horas. Ausência
de metadados, remoção, fotografia de reconexão, ordem dos relógios não confirmada
e recibo inválido têm razões distintas. A seleção de 24 horas não comprova uma
observação contínua dessa duração. Os intervalos civis reportados não têm uma
prova monotônica do relógio de origem: `full24h_proven`,
`all_HA_MQTT_latency_proven` e `assistant_execution_proven` permanecem falsos.
Nem zero excedentes reportados nem a presença do marcador do produtor substituem
as evidências que faltam.

A instalação revisada inclui `notification_state.cjs`, `registry.py`,
`worker.py` e `source_timing.py`. Atualize somente o pin do state nas políticas
admin/repair e o pin transitivo da política admin na repair; preserve todas as
autorizações e a validade. Recarregue apenas `raspberry-ha-notices.service` e
`raspberry-mcp-events.service`. Confira o marcador pela chamada MCP real, os
contadores e o ledger anterior, e aguarde mudanças naturais para comprovar os
novos recibos. Home Assistant, Node-RED, observador do host, procmon e heartbeat
não precisam reiniciar. Reversão exige comparação dos arquivos com os hashes
aplicados, restauração dos módulos/pins anteriores e preservação da tabela
aditiva; não restaure um banco antigo nem remova eventos ou intents.

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
[`runtime-source/ha-notices`](../../../scripts/raspberry-mcp/runtime-source/ha-notices/notification_reader.py)
e seus destinos/hashes em
[`SOURCE-MAP.json`](../../../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json).
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

Antes de alterar módulos compartilhados, confira também cada política que fixa
seus hashes. Uma atualização do sanitizador pode exigir os três pins do catálogo
de reparos e o pin de `notification_state.cjs` na política administrativa.
Como o catálogo também fixa os bytes dessa política, calcule primeiro a nova
política administrativa e só depois o pin correspondente no catálogo. Não
adote hashes apenas porque os arquivos estão instalados: compare os bytes com
as versões públicas anterior e revisada, confira as demais dependências e
preserve validade, autorização, tarefas, limites e recibos. Divergência mantém
a recusa; não desative a checagem para recuperar o diagnóstico.

O helper puro
[`notice_dependency_review.py`](../../../scripts/raspberry-mcp/runtime-source/administrative-recovery/notice_dependency_review.py)
planeja somente essas duas políticas e suas referências fixas, sem escrita,
rede, instalação ou renovação. O operador ainda precisa verificar proprietário,
modo, baseline e edição concorrente, gravar intent e backups antes da troca
atômica e conferir o MCP real. Após efeito incerto, consulte os arquivos e
recibos; não repita a operação. O
[aceite da reconciliação](../../../scripts/raspberry-mcp/notice-dependency-review.acceptance.json)
registra a recusa inicial por pin antigo, a referência transitiva que faltou na
primeira aplicação e a recuperação posterior sem reinício de serviço.

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
[`ha-notifications-content.acceptance.json`](../../../scripts/raspberry-mcp/ha-notifications-content.acceptance.json).
Ele comprova leitura, não que cliente MCP autorizado executou uma correção ou que os serviços
voltaram a responder. Nenhum callback, nova assinatura, conta ou efeito
residencial foi criado.

## Horários de notificações no Node-RED

O [contrato de horários dos hubs](../../NODERED_NOTIFICATION_HUBS.md#horários-canônicos-e-limites-de-latência)
preserva observação da fonte, primeira detecção e decisão, quando disponíveis,
até o recibo do Home Assistant e o histórico privado. Há uma única definição
estrutural incorporada pelos geradores; não exige novas dependências, acesso
ou ferramentas MCP. Dados antigos ou incompletos não ganham durações zero.

O [aceite da transação](../../../scripts/raspberry-mcp/notification-timing.acceptance.json)
registra três tarefas MCP seriais: aplicação, rollback e reapply de 22 corpos
de função, preservando os demais campos, contexto de produção e início dos
sete serviços. Cada fase confirmou sete passos de replay do host, dedupe,
limpeza e revogação da sessão Admin API. Aplicação e reaplicação confirmaram
também os três terminais de histórico, em dry-run, sem JSONL de teste. O
conflito entre relógio sintético do host e relógio civil permaneceu explícito,
com intervalos nulos. A normalização posterior de indentação preservou o hash
semântico dos flows e não reaplicou nem recarregou o runtime.

Esse teste prova a transação e o processamento dos metadados no runtime. Não
comprova tempos de incidentes reais, chegada de push, execução natural do cliente MCP autorizado,
24 horas de continuidade ou recuperação funcional de integrações e backups.
As operações e seus IDs foram consumidos; não repetir para produzir evidência.
