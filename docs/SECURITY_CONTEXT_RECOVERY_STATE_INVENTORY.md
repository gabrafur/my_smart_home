# Inventário de estado e recovery dos flows de segurança

Este inventário cobre `localizacao_pessoas`, `contexto_creta`,
`contexto_chegadas` e `iluminacao_seguranca`. A regra arquitetural é:

> Entidades atuais representam verdade física. Persistência representa apenas
> intenção, lifecycle e histórico temporal necessário para recuperação.

O store padrão do Node-RED permanece `memoryOnly`. As chaves explicitamente
marcadas abaixo usam o store nomeado `persistent` (`localfilesystem`). Todos os
timestamps são epoch Unix UTC em milissegundos; timezone só é aplicado ao
horário operacional de refresh (07h–22h, timezone do container).

## Classificação completa

| Estado | Flow / produtor | Consumidores | Armazenamento atual | Significado e classe | Derivável / transitório / físico / intenção / temporal | Sobrevive? / destino | Risco se perdido | Recovery, TTL e invalidação |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Entidades dos quatro iPhones | HA; lidas por eventos/snapshot de `localizacao_pessoas` | normalizador | entidade HA e propriedades de `msg.payload` | verdade física externa | derivável: não; transitório no `msg`; físico; temporal | HA sobrevive; não copiar para persistência | chegada falsa por dado velho | validar `last_updated/last_changed`, GPS ≤100 m e freshness 15 min; stale fica unknown |
| Posição normalizada de Gabriel/Valéria | `people_normalize` | chegadas, refresh, coordenador, iluminação | `people_context_v1` em flow memory e contrato/msg | snapshot derivado | derivável; transitório; não físico; temporal | reconstruir; não persistir | decisões com snapshot parcial | reconstruir das entidades; rejeitar `updated_at` fora de ordem |
| `people_arrival_armed` | `people_normalize` | detector de chegada | memory + `security_people_recovery_v1.arrival_armed` persistent | intenção/lifecycle de travessia | não totalmente derivável durante restart; temporal | persistir | perder chegada ou gerar catch-up falso | revalidar com localização atual; sem TTL fixo, reset por retorno confirmado a ≤100 m; registro persistent expira logicamente pelas transições |
| Dedupe de chegada das pessoas | `people_normalize` | publicador `security.arrival.v1` | `security_people_recovery_v1.recent_arrivals` persistent | histórico temporal | transitório; intenção de idempotência; temporal | persistir por 10 min | chegada, luz, viagem ou desarme duplicados | chave origem/estágio/estado/timestamp; prune >10 min ou timestamp inválido |
| Dedupe/away-cycle do aviso da Valéria | `people_normalize` | `contexto_chegadas` / notify | memory + campos persistent em `security_people_recovery_v1` | lifecycle e histórico | parcialmente derivável; temporal | persistir | aviso duplicado após restart | flag é restaurada; chave origem/estado/timestamp tem TTL 10 min; reset em nova saída/casa |
| `people_last_refresh` | `people_refresh_decide` | refresh iPhones | `security_people_last_refresh_at` persistent | cooldown/intenção | não físico; temporal | persistir | storm de localização no restart | intervalos 30/60 s; futuro >60 s é inválido; sobrescrito na próxima solicitação aceita |
| Localização, motor e trava do Creta | HA/Bluelink; eventos/snapshot | `creta_normalize` | entidades HA e `msg.payload` | verdade física externa | não derivável; físico; temporal | HA sobrevive; não persistir cópia como verdade | viagem falsa ou encerramento falso | localização 30 min; motor/trava 5 min; unknown/stale não vira false |
| Snapshot `creta_context_v1` | `creta_normalize` | coordenador, iluminação, refresh | flow memory e contrato/msg | snapshot derivado | derivável; transitório; temporal | reconstruir; não persistir | gate indevido ou snapshot antigo | reconstruir das entidades + contexto confirmado; monotonicidade de `updated_at` |
| `creta_in_use` confirmado | `creta_normalize` | chegada, viagem, iluminação | memory + `security_creta_recovery_v1.in_use` persistent | intenção/contexto de viagem, não verdade física | parcialmente derivável; temporal | persistir confirmação, publicar só após revalidar | motor stale `off` derrubar viagem | `on` fresco confirma true; `off` fresco + casa confirma false; persistido true + posição fresca fora confirma true; senão contrato publica null/pending; confirmação TTL 24 h |
| Lifecycle de viagem | `creta_normalize` | observabilidade e atualização pós-chegada | `trip_active`, `trip_started_at` em `security_creta_recovery_v1` persistent | histórico/intenção | temporal; parcialmente derivável | persistir | viagem duplicada/encerrada por ausência | só muda com `in_use` confirmado; stale preserva evidência, não encerra; TTL 24 h desde última confirmação |
| `creta_arrival_armed` | `creta_normalize` | detector de chegada | memory + recovery persistent | lifecycle de travessia | parcialmente derivável; temporal | persistir | perder/duplicar chegada | revalidar com posição atual; reseta em casa confirmada |
| Dedupe de chegada/viagem do Creta | normalizador e `creta_arrival_actions` | wake e refresh trip info | chaves persistent | idempotência temporal | transitório; temporal | persistir 10 min | wake/trip refresh duplicado | chave origem/estágio/evento; TTL 10 min; sobrescrever no próximo evento |
| Retry/cooldown Bluelink | `creta_refresh_decide`/ack | button refresh | `security_creta_refresh_v1` persistent | intenção temporal | não físico; temporal | persistir | storm ou retry nunca retomado | backoff 1/2/4/8/15 min, máximo cinco tentativas; sucesso zera e arma 15 min; deadline absurdo é descartado |
| `refresh_cycle_id` e `refresh_pending` | `context_coordinator` | snapshots/refresh | flow memory e `msg` | coordenação transitória | derivável; transitório; temporal | descartar | ciclo incompleto | novo epoch por tick; exige dois snapshots ready do mesmo ciclo; sem retry recursivo |
| Caches people/Creta do coordenador | contratos recebidos | política conjunta/aviso | flow memory | snapshot derivado | derivável; transitório | reconstruir | antigo sobrescrever novo | aceitar apenas `updated_at` monotônico; solicitar snapshots a cada 30 s |
| Candidato/aviso da Valéria | people → coordinator → notify | usuário | `msg` | evento externo/side effect | transitório; temporal | evento descartável; dedupe persiste no produtor | notificação duplicada | só notificar com Creta ready; dedupe upstream 10 min |
| `sun_below_horizon`/`sun_ready` | evento HA em `iluminacao_seguranca` | gate de luz/readiness | flow memory | verdade externa espelhada/derivada | reconstruível; físico/temporal | reconstruir; não persistir | acender no claro | `outputInitially`; booleano válido é obrigatório |
| Estado físico do refletor | `switch.refletor_portao_carros`; consulta/evento | reconciliador, gates, off | entidade HA + `security_light_physical_state` memory | verdade física externa | físico; temporal | consultar/reconstruir; não persistir como verdade | desligar ação manual ou presumir off | somente `on/off` reconciliam; unknown/unavailable bloqueiam ações |
| Lifecycle do refletor por chegada | `light_mark_active` | recovery, off e gates | `security_light_lifecycle_v1` persistent | intenção da automação | não físico; temporal | persistir | perder autoria e timers | estrutura v1, TTL 24 h; exige `on_since` e `force_off_at` coerentes; compara com switch físico |
| `on_since` / `force_off_at` | `light_mark_active` | delay e recovery | lifecycle persistent + `msg.delay` | backstop temporal | intenção; temporal | persistir | luz ficar ligada após restart | deadline 15 min; vencido offline gera reavaliação imediata; inválido descarta autoria |
| `pending_off_at`, reason e source | `light_evaluate_off` | recovery e off final | lifecycle persistent + delay variável | carência temporal | intenção; temporal | persistir | apagar cedo ou nunca | deadline 90 s desde o acendimento; ao vencer revalida `current_home` do tracker fresco ou `home` do Creta; cancela se condição sumiu |
| `cooldown_until` | `light_turn_off_if_active` | gate de acendimento/reconciliador | lifecycle persistent | supressão temporal | intenção; temporal | persistir | religar após restart | deadline 5 min; expirado é limpo; futuro >30 min é inválido |
| `light_reconciled` / `security_light_ready` | reconciliador | preparação de chegada/recovery | flow memory | readiness derivada | derivável; transitório | reconstruir | side effect durante startup parcial | true apenas com pessoas, Creta, sol e switch físico prontos |
| Deadlines residentes nos `delay` nodes | mark/evaluate/recovery | off final | runtime/mensagem | execução transitória | derivável dos deadlines absolutos | descartar e reconstruir | timer perdido | startup republica tempo restante; off final revalida deadline e condição |
| `msg` de contexto/arrival/refresh | produtores de domínio | links/consumidores | mensagem Node-RED | transporte transitório | derivável/evento; temporal | não persistir | replay ou ordem errada | contratos versionados, timestamps, origem/razão e dedupe nos limites |
| Serviços físicos (turn_on/off, notify, wake, trip refresh) | action nodes | HA/dispositivos | side effect externo | ação, não estado interno | físico/externo | nunca persistir como se executado | ação duplicada | readiness + estado físico + dedupe + ack/cooldown específico |

Nenhum `global context` ou `node context` é usado nesses quatro flows. `node
context` também não guarda handles de timer; os `delay` nodes são apenas meios
de execução e podem ser reconstruídos. As propriedades de `msg` não são fonte
de verdade depois que a mensagem termina.

## Startup ordering e convergência

| Ordem | Comportamento |
| --- | --- |
| HA operacional, Node-RED reinicia | restaura intenção, lê o switch após 1 s, pede snapshots após 2 s, revalida e retoma deadlines |
| Node-RED operacional, HA reinicia | entidades ficam unavailable, readiness cai; eventos iniciais da reconexão e tick periódico convergem novamente |
| Ambos reiniciam juntos | persistência pode ser lida, mas nenhum efeito é liberado antes de entidades atuais e switch físico estarem prontos |
| Node-RED antes do HA | consultas podem falhar/retornar unavailable; política conservadora aguarda eventos confiáveis |
| HA antes do Node-RED | startup lê imediatamente o estado atual; snapshot antigo não vence leitura nova |

## Limitações e riscos residuais

- Freshness mede idade reportada pelo HA/integração; não prova que a API remota
  observou fisicamente o veículo naquele instante.
- Um refletor ligado por outra automação é indistinguível de acionamento manual;
  ambos são conservadoramente preservados quando não há lifecycle válido.
- `localfilesystem` faz flush periódico (padrão Node-RED, cerca de 30 s). Uma
  perda abrupta de energia imediatamente após uma transição ainda pode perder a
  última gravação; a reconciliação física evita transformar isso em ação crítica.
- O sensor de viagens diário continua sendo a fonte externa de histórico final;
  o lifecycle persistido evita duplicação, mas não substitui `/tripinfo`.
- A confirmação pendente do flow separado `alarme_desarme_chegada` continua em
  memória; o dedupe persistente de `security.arrival.v1` evita recriá-la no
  restart, mas uma confirmação já aberta não é retomada.
