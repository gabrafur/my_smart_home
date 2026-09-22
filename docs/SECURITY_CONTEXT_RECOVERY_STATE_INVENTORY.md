# Inventário de estado e recovery dos flows de segurança

Este inventário cobre `localizacao_pessoas`, `contexto_vehicle_primary`,
`contexto_chegadas` e `iluminacao_seguranca`. A regra arquitetural é:

> Entidades atuais representam verdade física. Persistência representa apenas
> intenção, lifecycle e histórico temporal necessário para recuperação.

O store padrão do Node-RED permanece `memoryOnly`. As chaves explicitamente
marcadas abaixo usam o store nomeado `persistent` (`localfilesystem`). Todos os
timestamps são epoch Unix UTC em milissegundos; timezone só é aplicado ao
horário operacional de refresh (07h–22h, timezone do container).

No ambiente Docker, `settings.js` está em `/data/settings.js` e configura
explicitamente `dir: __dirname` + `base: "context"`: o store fica em
`/data/context`, dentro do bind mount persistente `./nodered:/data`. O cache em
memória usa flush de 30 s. O diretório é criado pelo Node-RED com o usuário do
container; `/data` foi verificado como gravável. Recriar o container não remove
o store, mas uma queda abrupta ainda pode perder a janela não descarregada.

## Classificação completa

| Estado | Flow / produtor | Consumidores | Armazenamento atual | Significado e classe | Derivável / transitório / físico / intenção / temporal | Sobrevive? / destino | Risco se perdido | Recovery, TTL e invalidação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Entidades dos quatro iPhones | HA; lidas por eventos/snapshot de `localizacao_pessoas` | normalizador | entidade HA e propriedades de `msg.payload` | verdade física externa | derivável: não; transitório no `msg`; físico; temporal | HA sobrevive; não copiar para persistência | chegada falsa por dado velho | validar `last_updated/last_changed`, GPS ≤100 m e freshness 15 min; stale fica unknown |
| Decisão canônica de resident_primary/resident_secondary | seleção e classificação visual de `localizacao_pessoas` | normalizador, notificações e publicação MQTT para painéis | `canonical_location_decisions_v1` + `canonical_near_home_people_v1` persistent + trackers MQTT retidos | decisão derivada única | derivável; temporal; estado anterior necessário para transição | revalidar e substituir com as fontes atuais | painel e automação divergirem ou perder a borda `not_home -> near_home` | mesma política visual para todos os consumidores; raios home 100 m e near_home 700 m; o geofence técnico de 1.500 m apenas acorda o iOS e o antigo raio inativo de refresh rápido foi removido; freshness 15 min, heartbeat 75 min, diferença material 60 s e GPS ≤100 m; painel consome flags prontas |
| Posição normalizada de resident_primary/resident_secondary | `people_normalize`, depois da seleção canônica | chegadas, refresh, coordenador, iluminação | `people_context_v1` em flow memory e contrato/msg | snapshot derivado | derivável; transitório; não físico; temporal | reconstruir; não persistir | decisões com snapshot parcial | reconstruir da decisão canônica; rejeitar `updated_at` fora de ordem |
| `people_arrival_armed` / `local_excursions` | `people_normalize` | detector de chegada | memory + `security_people_recovery_v1` persistent | intenção de travessia externa ou passeio local | não totalmente derivável durante restart; temporal | persistir | perder chegada ou gerar catch-up falso | ciclo externo continua exigindo observação fora; `home -> near_home` não arma chegada, mas abre por até 90 min um passeio local restrito à iluminação; ele exige o `on` da partida, depois `off` e novo `on`; `not_home` encerra o passeio local e volta ao contrato externo; `home` além da carência canônica também encerra o passeio |
| Candidata HOME pareada | snapshot atual com saída externa comprovada | evento direcional da mesma observação | `security_people_recovery_v1.home_arrival_candidates` persistent | transferência limitada da evidência externa | temporal | persistir por até `arrival_recovery_minutes` | snapshot anterior ao evento perder a chegada longa | snapshot sozinho não emite; timestamp deve coincidir; evento consome; expiração, saída e permanência em casa invalidam |
| Dedupe de chegada das pessoas | `people_normalize` | publicador `security.arrival.v1` | `security_people_recovery_v1.recent_arrivals` persistent | histórico temporal | transitório; intenção de idempotência; temporal | persistir por 10 min | chegada, luz, viagem ou desarme duplicados | chave origem/estágio/estado/timestamp; prune >10 min, tipo inválido ou futuro >60 s; mapa limitado pela janela |
| Reserva e dedupe dos avisos de chegada | `notificacoes_chegadas_residentes` | notify de ambos os residentes | persistent em `resident_notification_delivery_v4`; testes somente em memória | aceite do Home Assistant e idempotência da chamada por destinatário | parcialmente derivável; temporal | persistir aceite; reserva expira | chamada duplicada após restart ou retry concorrente | contrato de chegada já traz o ciclo externo; cada evento faz fan-out visual para `mobile_primary` e `mobile_secondary`; chave origem/estágio/timestamp tem TTL visual de 10 min, mas aceite e retry são isolados por destinatário; v3 é migrado preservando somente o destinatário que existia antes |
| Refresh ativo de localização por morador | `people_refresh_decide` | Companion App + Find My/iCloud via binding privado | `security_people_location_refresh_v2` persistent; `__test` somente em memória | cooldown, tentativa e confirmação semântica independentes por morador | não físico; intenção/temporal | persistir produção; isolar teste | storm de localização, pedidos ao morador errado, cache antigo promovido a posição nova ou aceite de serviço confundido com observação | somente o morador stale é selecionado; cooldown de 30 min por morador (máx. 2/h); o pedido segue em paralelo pelo Companion e iCloud; a rota iCloud força uma consulta Find My e usa o `timeStamp` da coordenada devolvida, rejeitando `isOld`, em vez do horário em que o HA republicou o estado; sucesso só é confirmado quando `updated_at` avança; refresh do veículo apenas reavalia a mesma política; residência estacionária em casa com heartbeat de até 75 min não dispara recovery; futuro >60 s é inválido |
| Localização, motor e trava do vehicle_primary | HA/Bluelink; eventos/snapshot | classificador visual de raios → `vehicle_primary_normalize` | entidades HA, `msg.payload` e último estado em `canonical_near_home_vehicle_v1` persistent | verdade física externa + decisão derivada | parcialmente derivável; físico; temporal | HA sobrevive; reclassificar pelas fontes atuais | viagem falsa ou encerramento falso | localização 30 min; motor/trava 5 min; mesmos raios home/near_home da política única; unknown/stale não vira false |
| Snapshot `vehicle_primary_context_v1` | `vehicle_primary_normalize` | coordenador, iluminação, refresh | flow memory e contrato/msg | snapshot derivado | derivável; transitório; temporal | reconstruir; não persistir | gate indevido ou snapshot antigo | reconstruir das entidades + contexto confirmado; monotonicidade de `updated_at` |
| `vehicle_primary_in_use` confirmado | `vehicle_primary_normalize` | chegada, viagem, iluminação | memory + `security_vehicle_primary_recovery_v1.in_use` persistent | intenção/contexto de viagem, não verdade física | parcialmente derivável; temporal | persistir confirmação, publicar só após revalidar | motor stale `off` derrubar viagem | `on` fresco confirma true; `off` fresco + casa confirma false; persistido true + posição fresca fora confirma true; senão contrato publica null/pending; confirmação TTL 24 h |
| Lifecycle de viagem | `vehicle_primary_normalize` | observabilidade e atualização pós-chegada | `trip_active`, `trip_started_at` em `security_vehicle_primary_recovery_v1` persistent | histórico/intenção | temporal; parcialmente derivável | persistir | viagem duplicada/encerrada por ausência | recovery preserva evidência durante stale, mas o contrato atual publica `trip_active: false` enquanto `in_use` estiver pending; TTL 24 h desde última confirmação |
| `vehicle_primary_arrival_armed` | `vehicle_primary_normalize` | detector de chegada | memory + recovery persistent | lifecycle de travessia externa | parcialmente derivável; temporal | persistir | perder/duplicar chegada | somente uma observação posterior em zona externa ou a borda direcional externa `-> near_home` arma; a própria borda de saída e distância isolada nunca armam; saída e rebote sem ciclo externo são bloqueados; retorno confirmado consome o armado |
| Dedupe de chegada/viagem do vehicle_primary | normalizador e `vehicle_primary_arrival_actions` | wake e refresh trip info | chaves persistent | idempotência temporal | transitório; temporal | persistir 10 min | wake/trip refresh duplicado | chave origem/estágio/evento; TTL 10 min; sobrescrever no próximo evento |
| Retry/cooldown Bluelink | `vehicle_primary_refresh_decide`/ack | button refresh | `security_vehicle_primary_refresh_v1` persistent | intenção temporal | não físico; temporal | persistir | storm ou retry nunca retomado | intervalo de 5 min somente com morador `near_home` e localização pronta, 15 min com morador confirmado fora ou durante recovery de localização indisponível, e 30 min com ambos confirmados em casa; um `near_home` stale nunca acelera o carro; com ambos em casa há pausa 00:00–05:59; chegada `home` com refletor ativo e motor ainda `on` atravessa deadline/pausa para confirmar o estado final; o contador satura em cinco; aceite ancora o intervalo e deadline absurdo é descartado |
| `refresh_cycle_id` e `refresh_pending` | trilha visual de ciclo em `contexto_chegadas` | snapshots/refresh | flow memory e `msg` | coordenação transitória | derivável; transitório; temporal | descartar | ciclo incompleto | agenda de 30 s; ciclo em voo é coalescido por 10 s; recovery explícito promove a intenção; depois do limite exato abre novo epoch; exige respostas dos dois snapshots do mesmo ciclo |
| Caches people/vehicle_primary do coordenador | contratos recebidos | política conjunta/saída | flow memory | snapshot derivado | derivável; transitório | reconstruir | antigo sobrescrever novo | switches aceitam o primeiro snapshot mesmo sem timestamp e depois exigem `updated_at` monotônico; futuro >60 s e fora de ordem são rejeitados; mudança derivada no mesmo timestamp é aceita; duplicata exata não altera cache |
| Avisos de chegada aos residentes | `security.arrival.v1` do lifecycle canônico → fan-out → reserva/dedupe por destinatário → notify | usuário | `resident_notification_delivery_v4` | evento externo/side effect | temporal | persistir aceite e tentativas por destinatário | notificação perdida em um dos celulares, chegada direta em casa ou chamada duplicada após restart | aceita `approach` e `home`, exige `returning` e ciclo externo confirmado; envia a mesma chegada para `mobile_primary` e `mobile_secondary`, solicita som e nível `time-sensitive`; o aceite do serviço não prova exibição no aparelho; nenhum tracker bruto alimenta este tab |
| Chegada pendente da iluminação | evento canônico de chegada de morador após gate visual de direção | merge de contexto e gate de acendimento | `security_light_pending_arrival_v1` e `security_light_local_excursion_v1` persistent | intenção de replay | intenção; temporal | persistir por até 15 min; passeio local por 90 min | perder o acendimento enquanto Bluelink, contexto ou sol converge | o evento externo carrega snapshot mínimo da localização canônica para não perder a entrada por corrida entre links; o caminho externo exige retorno confirmado e localização atual em `near_home`; o caminho local exige `home -> near_home`, `on` inicial, `off` posterior e novo `on`, e aceita localização atual em `near_home` ou `home`; ambos voltam pelos mesmos gates de noite, motor/bypass, disponibilidade, dedupe e cooldown; o caminho local não alcança avisos nem alarme; startup parcial preserva a evidência limitada; somente a fronteira final consome o ciclo; replay revalida o ciclo canônico |
| `sun_below_horizon`/`sun_ready` | evento HA em `iluminacao_seguranca` | gate de luz/readiness | flow memory | verdade externa espelhada/derivada | reconstruível; físico/temporal | reconstruir; não persistir | acender no claro | `outputInitially`; booleano válido é obrigatório |
| Estado físico do refletor | `switch.refletor_portao_carros`; consulta/evento | reconciliador, gates, off | entidade HA + estado/instante de observação em memory | verdade física externa | físico; temporal | consultar a cada 60 s e por evento; não persistir como verdade | desligar ação manual ou presumir off | somente `on/off` reconciliam; leitura futura/fora de ordem e observação com mais de 2 min bloqueiam ações |
| Lifecycle do refletor por chegada | `light_mark_active` | recovery, off e gates | `security_light_lifecycle_v1` persistent | intenção da automação | não físico; temporal | persistir | perder autoria e timers | estrutura v1, TTL 24 h; exige `on_since` e `force_off_at` coerentes; compara com switch físico |
| `on_since` / `force_off_at` | `light_mark_active` | delay e recovery | lifecycle persistent + `msg.delay` | backstop temporal | intenção; temporal | persistir | luz ficar ligada após restart | deadline 15 min; vencido offline gera reavaliação imediata; inválido descarta autoria |
| `vehicle_refresh_at`, reason e source | confirmação `home` de cada morador | recovery e atualização extraordinária do vehicle_primary | `resident_home_refresh_v2` persistent, com registro por morador | confirmação temporal | intenção; temporal | persistir | uma segunda chegada sobrescrever ou cancelar o prazo da primeira | deadline independente 90 s desde cada confirmação `home`, nunca desde `near_home`, desde o acendimento ou desde a posição `home` do veículo; independe do lifecycle do refletor e pode ser agendado mesmo com a integração do carro indisponível; ao vencer revalida somente o morador correspondente e força refresh pelo coordenador; a confirmação não desliga diretamente e cancela se a condição daquela origem sumiu |
| `cooldown_until` | `light_turn_off_if_active` | gate de acendimento/reconciliador | lifecycle persistent | supressão temporal | intenção; temporal | persistir | religar após restart | deadline 5 min; expirado é limpo; futuro >30 min é inválido |
| `light_reconciled` / `security_light_ready` | reconciliador | preparação de chegada/recovery | flow memory | readiness derivada | derivável; transitório | reconstruir | side effect durante startup parcial | true apenas com pessoas, vehicle_primary, sol e switch físico prontos, incluindo observação física nos últimos 2 min |
| Deadlines residentes nos `delay` nodes | mark/evaluate/recovery | off final | runtime/mensagem | execução transitória | derivável dos deadlines absolutos | descartar e reconstruir | timer perdido | startup republica tempo restante; off final revalida deadline e condição |
| `msg` de contexto/arrival/refresh | produtores de domínio | links/consumidores | mensagem Node-RED | transporte transitório | derivável/evento; temporal | não persistir | replay ou ordem errada | contratos versionados, timestamps, origem/razão e dedupe nos limites |
| Serviços físicos (turn_on/off, notify, wake, trip refresh) | action nodes | HA/dispositivos | side effect externo | ação, não estado interno | físico/externo | nunca persistir como se executado | ação duplicada | readiness + estado físico + dedupe + ack/cooldown específico |

Nenhum `global context` ou `node context` é usado nesses quatro flows. `node
context` também não guarda handles de timer; os `delay` nodes são apenas meios
de execução e podem ser reconstruídos. As propriedades de `msg` não são fonte
de verdade depois que a mensagem termina.

## Startup ordering e convergência

O snapshot de localização contém ambos os moradores. A classificação emite
uma mensagem `location_update` para cada transição canônica encontrada, mesmo
quando o snapshot foi solicitado pelo outro morador ou pelo refresh periódico.
Todas percorrem os mesmos gates de direção, freshness, ciclo externo e dedupe;
a classificação não envia avisos nem autoriza o refletor diretamente. Callbacks
pareados sem mudança não repetem a chegada. O finalizador preserva deltas de
estado do outro morador já confirmados durante o processamento concorrente.

O replay em `test-canonical-location-flow.mjs` cobre as três origens de snapshot,
chegadas individuais e simultâneas, callbacks repetidos, a confirmação `home`
usada pelo refresh de 90 s e o aviso ao destinatário oposto até o terminal
dry-run. Nenhum push ou equipamento real é acionado por esse teste.

| Ordem | Comportamento |
| --- | --- |
| HA operacional, Node-RED reinicia | restaura intenção, lê o switch após 1 s, pede snapshots após 2 s, revalida e retoma deadlines |
| Node-RED operacional, HA reinicia | entidades ficam unavailable, readiness cai; eventos iniciais da reconexão e tick periódico convergem novamente |
| Ambos reiniciam juntos | persistência pode ser lida, mas nenhum efeito é liberado antes de entidades atuais e switch físico estarem prontos |
| Node-RED antes do HA | consultas podem falhar/retornar unavailable; política conservadora aguarda eventos confiáveis |
| HA antes do Node-RED | startup lê imediatamente o estado atual; snapshot antigo não vence leitura nova |

## Limitações e riscos residuais

- Freshness do iCloud usa o horário da coordenada informado pelo Find My e
  rejeita a marca `isOld`; nas demais fontes mede a mudança observável exposta
  pela integração. Isso ainda não prova presença física sem erro do provedor.
- Um refletor ligado por outra automação é indistinguível de acionamento manual;
  ambos são conservadoramente preservados quando não há lifecycle válido.
- `localfilesystem` faz flush periódico configurado em 30 s. Uma
  perda abrupta de energia imediatamente após uma transição ainda pode perder a
  última gravação; a reconciliação física evita transformar isso em ação crítica.
- O sensor de viagens diário continua sendo a fonte externa de histórico final;
  o lifecycle persistido evita duplicação, mas não substitui `/tripinfo`.
- A confirmação pendente do flow separado `alarme_desarme_chegada` continua em
  memória; o dedupe persistente de `security.arrival.v1` evita recriá-la no
  restart, mas uma confirmação já aberta não é retomada.
