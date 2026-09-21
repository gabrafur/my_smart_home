# Hubs canônicos de notificação do Node-RED

Os flows de negócio não chamam celulares, Alexa nem
`persistent_notification` diretamente. A fronteira de saída fica em três tabs
independentes e visualmente explícitos:

- `hub_notificacoes_moveis`;
- `hub_notificacoes_alexa`;
- `hub_notificacoes_persistentes_ha`.

Os nomes públicos dos destinatários são papéis lógicos. A resolução para o
serviço ou dispositivo privado continua exclusivamente em `public_bindings`;
nenhum identificador privado novo é gravado em `flows.json`.

## Hub de notificações móveis

Entrada canônica: link call `notification_hub_mobile_in`.

| Campo | Obrigatório | Contrato |
| --- | --- | --- |
| `msg.payload` | sim | mensagem não vazia |
| `msg.notification.source` | sim | origem lógica não vazia |
| `msg.notification.recipients` | sim | lista explícita com `resident_primary`, `resident_secondary` ou ambos |
| `msg.notification.profile` | sim | `simple`, `actionable` ou `background_command` |
| `msg.notification.title` | não | título textual |
| `msg.notification.data` | não | metadata do Companion App preservada sem normalização destrutiva |
| `msg.notification.test_mode` | não | desvia ao terminal dry-run |
| `msg.notification.delivery_under_test` | não | permite somente o smoke test de push já autorizado e identificado como `TESTE` |

O roteamento é fail-closed. Lista ausente, vazia, duplicada, com papel
desconhecido, `all`, `both` ou `broadcast` é rejeitada antes de qualquer
serviço. Não existe destinatário padrão. A rejeição produz
`notification_delivery.status = rejected`, status vermelho no node e o log
sanitizado `NOTIFICATION_HUB_REJECTED`; o conteúdo da mensagem não é incluído
no log.

Perfis:

- `simple`: preserva `mobile_primary/notify_3` ou
  `mobile_secondary/notify_2` e `queue: all`;
- `actionable`: preserva `notify_actionable`, inclusive `tag`, `actions`, URL,
  som, push, nível de interrupção e demais chaves em `notification.data`;
- `background_command`: aceita somente `request_location_update` e
  `clear_notification`, preservando `queue: first`.

Exemplos conceituais de Change Node antes do link call:

```text
msg.payload = "Mensagem"
msg.notification = {
  "source": "meu_fluxo",
  "recipients": ["resident_primary"],
  "profile": "simple",
  "title": "Título"
}
```

Troque a lista por `["resident_secondary"]` para o celular secundário. Para os
dois, a lista deve ser exatamente explícita:

```json
{"recipients":["resident_primary","resident_secondary"]}
```

Nunca omita `recipients` e nunca crie um fallback para todos.

## Hub de notificações Alexa

Entrada canônica: link call `notification_hub_alexa_in`.

| Campo | Obrigatório | Contrato |
| --- | --- | --- |
| `msg.payload` | sim | texto não vazio a anunciar |
| `msg.notification.source` | sim | origem lógica |
| `msg.notification.targets` | sim | lista explícita de targets lógicos |
| `msg.notification.mode` | sim | atualmente `announce` |
| `msg.notification.data` | não | opções adicionais repassadas ao binding atual |

O único target observado na auditoria foi `voice_assistant_primary`, que
preserva exatamente `public_bindings` com papel `mobile_primary` e ação
`notify`. Não há fallback para todas as Alexas. Um target ausente ou
desconhecido é rejeitado sem anúncio.

O painel `/chat-assistants/alexa` publica o evento
`alexa_text_announcement_requested` com o texto digitado. O adaptador visual no
próprio hub remove espaços das extremidades, limita o contrato a 255 caracteres
e fixa `source=chat_dashboard`, `mode=announce` e o único target permitido,
`voice_assistant_primary`. O dashboard não chama Alexa, `notify` nem
`media_player` diretamente.

```text
msg.payload = "Atenção: evento confirmado"
msg.notification = {
  "source": "meu_fluxo",
  "targets": ["voice_assistant_primary"],
  "mode": "announce"
}
```

## Hub de notificações persistentes do Home Assistant

Entrada canônica: link call `notification_hub_persistent_in`.

| Campo | Obrigatório | Contrato |
| --- | --- | --- |
| `msg.payload` | em `create` | mensagem não vazia |
| `msg.notification.source` | sim | origem lógica |
| `msg.notification.operation` | sim | `create` ou `dismiss` |
| `msg.notification.delivery` | sim | `queued` (`queue: all`) ou `immediate` (`queue: none`) |
| `msg.notification.notification_id` | sim | ID estável, também usado para atualização/substituição e remoção |
| `msg.notification.title` | em `create` | título não vazio |

Criar ou atualizar:

```text
msg.payload = "Detalhes do incidente"
msg.notification = {
  "source": "meu_fluxo",
  "operation": "create",
  "delivery": "queued",
  "notification_id": "meu_incidente_estavel",
  "title": "Título"
}
```

Remover usa o mesmo ID:

```text
msg.payload = ""
msg.notification = {
  "source": "meu_fluxo",
  "operation": "dismiss",
  "delivery": "queued",
  "notification_id": "meu_incidente_estavel"
}
```

## Retorno, falha e confirmação móvel

O hub retorna ao link call com `msg.notification_delivery.status` igual a
`accepted`, `failed`, `rejected` ou `simulated`. O payload e o objeto
`notification` que existiam antes do adaptador são restaurados antes do
retorno, para preservar os contratos dos nós de confirmação e retry.

As actions móveis não mudaram. Tokens de confirmação, cancelamento, tags e
chaves de correlação continuam sendo construídos pelo fluxo de negócio e
repassados sem alteração pelo perfil `actionable`. O evento posterior
`mobile_app_notification_action` continua sendo consumido pelos mesmos nós e
com os mesmos tokens.

Falhas reais do serviço retornam ao tratamento local existente e publicam um
alerta sanitizado no observador global. Se a origem já for
`observabilidade_global`, o hub suprime a realimentação para impedir recursão.
Contratos inválidos não usam o observador móvel: são apenas rejeitados, de modo
que destinatário inválido jamais possa produzir outro push.

Os cinco monitores que antes chamavam o subflow legado de infraestrutura
preservam também seu gate comum: `title`, `message` e `id` precisam estar
presentes antes de qualquer ramificação. Se um deles faltar, mobile, Alexa,
criação persistente e dismiss são todos bloqueados e o descarte é registrado.
Depois desse gate, os dois destinatários móveis seguem por chamadas explícitas
e independentes, conservando o fan-out paralelo anterior.

## Inventário e equivalência da migração

A auditoria de base encontrou 44 nós de efeito direto: 14 para o papel móvel
primário, 8 para o secundário, 4 para Alexa, 12 `create` persistentes e 6
`dismiss` persistentes. Não existia um serviço móvel `all` nem um nó de
broadcast. Quatro avisos de negócio tinham duas saídas paralelas explícitas e
o antigo subflow compartilhado, também com duas saídas explícitas, era usado
por cinco chamadores. Portanto, havia nove rotas lógicas para os dois
residentes. As duas saídas do fluxo de chegadas não formam um broadcast: são
rotas simétricas e exclusivas, escolhidas conforme quem está chegando.

Cada linha abaixo preserva evento, destinatário, conteúdo, fila e metadata. Os
IDs antigos permanecem como Change Nodes adaptadores; o sufixo `__hub_call`
identifica a chamada ao hub.

| Fluxo | Evento / nós antigos | Antes | Depois / equivalência preservada |
| --- | --- | --- | --- |
| `garagem` | `gar_notify_relay_on` | HA persistente, ID `portao_garagem_rele_preso`, queued | adaptador de mesmo ID → hub HA `create/queued`; título e mensagem literais iguais |
| `iluminacao_externa` | `9d81b75a18d482f1` | Alexa no target atual | adaptador → hub Alexa `voice_assistant_primary`; `notify_text` igual |
| `iluminacao_externa` | `ext_send_recovery_mobile` | somente móvel primário, actionable | adaptador → hub móvel somente `resident_primary`; tag e actions `confirm_action`/`cancel_action` iguais |
| `alarme_casa` | `alarm_notify_alexa` | Alexa no target atual | adaptador → hub Alexa; `notify_text` igual |
| `resfriamento_raspberry_pi` | início: `349bc...`, `rpi_emergency_cooling_push_primary`, `rpi_emergency_cooling_alexa_primary` | HA persistente immediate + somente móvel primário + Alexa | celular primário + hub HA; anúncio Alexa desativado na configuração atual |
| `resfriamento_raspberry_pi` | normalização `a240a...` | HA persistente immediate | hub HA `create/immediate`; snapshot/fallback e ID iguais |
| `resfriamento_raspberry_pi` | falha `ab4f...` | HA persistente immediate | hub HA `create/immediate`; tentativas, razão, temperatura e ID iguais |
| `resfriamento_raspberry_pi` | `5dd0...`, `36968...`, `4b48...` | três dismiss immediate | hub HA `dismiss/immediate`; os três IDs permanecem iguais |
| `storage_health` | `storage_notify`, `storage_notify_secondary`, `storage_notify_persistent` | ambos os celulares + HA persistente queued | celular primário + hub HA; celular secundário desativado na configuração atual |
| `localizacao_pessoas` | `564fd...` | comando `request_location_update` somente ao primário, queue first | hub móvel `background_command`, somente `resident_primary`, queue first |
| `localizacao_pessoas` | `e0b7...` | comando `request_location_update` somente ao secundário, queue first | hub móvel `background_command`, somente `resident_secondary`, queue first |
| `contexto_vehicle_primary` | refresh manual bloqueado | HA persistente immediate | hub HA `create/immediate`; objeto `notification` e ID iguais |
| `contexto_vehicle_primary` | falha de refresh | somente móvel primário + HA persistente queued | hubs móvel/HA independentes; `alert.title`, `alert.message` e ID iguais |
| `contexto_vehicle_primary` | falha de comando remoto | somente móvel primário + HA persistente queued | hubs móvel/HA independentes; gates e dedupe inalterados |
| `contexto_vehicle_primary` | recuperação de refresh | dismiss queued | hub HA `dismiss/queued`; ID igual |
| `iluminacao_seguranca` | refletor ligado | ambos os celulares | duas chamadas explícitas, uma por papel; texto de produção/TESTE igual |
| `iluminacao_seguranca` | refletor indisponível | ambos os celulares | duas chamadas explícitas, uma por papel; motivo e título iguais |
| `alarme_desarme_chegada` | confirmação de chegada | ambos os celulares, actionable | duas chamadas explícitas; tag, actions, títulos e correlação iguais |
| `recuperacao_rtx` | endpoint recuperado | dismiss persistente queued | hub HA `dismiss/queued`; ID do incidente global igual |
| `alertas_codex` | alerta aceito | somente móvel primário + HA persistente queued | hubs móvel/HA; título, mensagem, tipo no ID, ack, retry e cooldown iguais |
| `backup_git` | falha final | somente móvel primário + HA persistente queued | hubs móvel/HA; ID `git_backup_failure`, ack e retry iguais |
| `notificacoes_chegadas_residentes` | `resident_secondary` se aproxima | somente móvel primário, actionable e time-sensitive | hub móvel somente `resident_primary`; tag, som, interruption level, dedupe e mensagem iguais |
| `notificacoes_chegadas_residentes` | `resident_primary` se aproxima | somente móvel secundário, actionable e time-sensitive | hub móvel somente `resident_secondary`; tag, som, interruption level, dedupe e mensagem iguais |
| `notificacoes_chegadas_residentes` | smoke test solicitado | somente móvel secundário | hub móvel somente `resident_secondary`, com `delivery_under_test` e conteúdo `TESTE`; nunca inclui o primário |
| `monitoramento_vpn` | queda/retorno confirmados | ambos + Alexa + HA persistente; dismiss na recuperação | celular primário + HA persistente e dismiss opcional; secundário e Alexa desativados |
| `monitoramento_internet` | queda confirmada | ambos + Alexa + HA persistente | ambos os celulares + HA persistente; Alexa desativada |
| `monitoramento_internet` | recuperação confirmada | ambos + Alexa + HA persistente + dismiss anterior | ambos os celulares + HA persistente e dismiss opcional; Alexa desativada |
| `monitoramento_zigbee` | queda/retorno/lembrete | ambos + Alexa + HA persistente; dismiss quando informado | celular primário + HA persistente e dismiss opcional; secundário e Alexa desativados |
| `monitoramento_tuya` | queda/retorno/lembrete | ambos + Alexa + HA persistente; dismiss quando informado | celular primário + HA persistente e dismiss opcional; secundário e Alexa desativados |
| `observabilidade_global` | incidente confirmado | somente móvel primário + HA persistente queued | hubs móvel/HA; smoke test, ack, fila e supressão de recursão preservados |

## Histórico privado de notificações — 7 dias

Cada saída bem-sucedida de serviço nos três hubs também grava uma linha JSONL
em `nodered/notification-history/<canal>/<AAAA-MM-DDTHH>.jsonl` (hora UTC).
O diretório é privado, persistente no volume `/data` e ignorado pelo Git.
Não depende do Recorder nem altera a retenção do Home Assistant.

Cada registro contém `accepted_at`, `source` (fluxo de origem), `channel`,
destinatário/target lógico, operação, perfil, título, mensagem, `data`,
`notification_id`, correlação `_msgid` e indicação de teste real de entrega.
Esse formato permite filtrar e reproduzir incidentes sem recuperar o contexto
inteiro da automação. O conteúdo pode conter dados residenciais: exportações
devem permanecer privadas e ser sanitizadas antes de compartilhar.

`status: accepted` significa que a chamada retornou sem erro, não que o celular
exibiu a mensagem, a Alexa falou ou alguém leu. Em um par de celulares há uma
linha por aceite individual, inclusive se a outra chamada falhar. Rejeições,
erros e chamadas ainda na fila não viram envios aceitos. Comandos de background
e remoções de notificações persistentes são registrados com seu perfil/operação;
podem ser excluídos na análise. Não existe reconstrução retroativa de envios.

O grupo de histórico em cada hub dispara a limpeza no início do fluxo e a cada
5 minutos. A retenção é **7 × 24 horas**: buckets antigos são removidos e o
bucket de fronteira é filtrado pelo timestamp de cada linha, preservando o
instante exato do corte. Um registro vencido pode permanecer até o próximo ciclo
(até 5 minutos enquanto o Node-RED está funcionando); após parada, a limpeza
retoma no startup. O purge não toca o arquivo da hora atual. JSON inválido no
bucket de fronteira preserva o arquivo e sinaliza falha ao observador global.
Falhas de escrita também seguem o catch global do tab, com deduplicação existente.
O aceite ao chamador não aguarda o arquivo, evitando reenviar uma notificação
já aceita por causa de falha de armazenamento. Há uma pequena janela de perda
entre o aceite externo e a escrita local em caso de encerramento abrupto.

Teste manual: em cada hub, acione `TESTE: registro sem escrita`. Ele passa pelo
mesmo serializador e termina em `simulated: true`, `dispatched: false`, sem
escrever no histórico, enviar notificações ou limpar dados reais. Os testes
automatizados de retenção usam exclusivamente diretórios temporários sintéticos:

```bash
node nodered/tools/test-notification-history.mjs
```

Para consultar localmente, use um leitor JSONL nos arquivos do canal desejado e
filtre por `source`, `correlation_id` ou `accepted_at`. O histórico não é publicado
em endpoint HTTP nem no Registro de atividades do Home Assistant.

## Reconciliação das escolhas de entrega

A coluna final da matriz acima representa a configuração atual; a coluna de
origem preserva a comparação histórica da migração. O gerador mantém
explicitamente os canais desativados e os testes rejeitam sua reintrodução.
O pedido de confirmação de recovery da iluminação externa termina no celular,
sem anúncio Alexa adicional; o cancelamento pendente continua chegando ao
trigger por ligação direta. Ajustes feitos no editor devem ser refletidos na
fonte geradora e nos contratos antes da próxima regeneração.

## Testes e manutenção

Os três tabs têm controles manuais `test_mode` que atravessam o mesmo
validador e terminam em `simulated: true`, `dispatched: false`. Eles nunca
devem ser usados para produzir uma notificação real. Os dois smoke tests reais
preexistentes continuam isolados e exigem `delivery_under_test`.

Comandos estáticos:

```bash
npm --prefix nodered run flows:update-notification-hubs
npm --prefix nodered run flows:test-notification-hubs
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:validate-layout
```

Os geradores que ainda montam uma representação intermediária legada aplicam
`installNotificationHubs()` antes de gravar o arquivo. O validador bloqueia
qualquer `public_bindings.call` com ação `notify*` fora dos hubs móvel/Alexa e
qualquer `persistent_notification.*` fora do hub persistente.

As notificações nativas do Home Assistant não pertencem a esta migração. Em
particular, o watchdog de indisponibilidade do próprio Node-RED deve permanecer
independente em `homeassistant/packages/nodered_flow_health.yaml`; movê-lo para
o runtime observado eliminaria a capacidade de alertar quando o Node-RED está
fora do ar.
