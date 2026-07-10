# Iluminacao de seguranca (Node-RED)

Flow `iluminacao_seguranca` (`nodered/flows.json`, tab `2fd40fd570e6f37a`).

## Objetivo

Ligar o `switch.refletor_portao_carros` quando Gabriel, Valeria ou o Creta
chegam em casa durante a noite, dando visibilidade contra possiveis
invasores proximos ao portao/garagem.

## Entidades usadas

- `device_tracker.iphone_de_gabriel_furlan` (integracao `mobile_app`,
  primaria) e `device_tracker.iphonegabrielfurlan` (integracao `icloud`,
  fallback)
- `device_tracker.iphone_de_valeria` (integracao `mobile_app`, primaria) e
  `device_tracker.iphone_de_valeria_2` (integracao `icloud`, fallback)
- `device_tracker.creta_location` (integracao `kia_uvo`)
- `binary_sensor.creta_engine`
- `lock.creta_door_lock`
- `sun.sun`
- `switch.refletor_portao_carros`
- `button.creta_force_refresh`

## Fallback de localizacao via iCloud

Gabriel e Valeria tem dois trackers cada: o `mobile_app` (app companion,
push em tempo real) e o `icloud` (Find My, poll periodico). O `mobile_app`
pode ficar "preso" reportando uma posicao antiga de "casa" quando o iOS
suspende as atualizacoes em segundo plano — foi o que aconteceu em
2026-07-10 com Valeria: o tracker `mobile_app` mostrava ~27 m de casa
(estado `home`) enquanto ela estava no trabalho a ~5,2 km, e o tracker
`icloud` (`device_tracker.iphone_de_valeria_2`) ja mostrava a posicao
correta.

Correcao: `sec_gabriel_location_changed`, `sec_valeria_location_changed`,
`sec_creta_location_changed` e `sec_refresh_context_snapshot` agora tambem
buscam `gabriel_icloud`/`valeria_icloud`. As funcoes `sec_refresh_anyone_away`
e `sec_prepare_arrival_context` mesclam os dois trackers de cada pessoa
(`mergeWithIcloudFallback`): quando ambos tem coordenadas confiaveis, vale a
leitura **mais distante de casa** (o modo de falha comum e o `mobile_app`
travado em "perto"), e o resultado mesclado e usado em todo o resto do
fluxo (armar por distancia, detectar chegada, aviso de aproximacao). Se so
um dos dois tiver coordenadas confiaveis, usa esse; se nenhum tiver, usa o
estado bruto preferindo `not_home` em caso de divergencia. `sec_valeria_location_changed`
e `sec_gabriel_location_changed` tambem passaram a disparar o fluxo quando
so o tracker `icloud` muda (antes so o `mobile_app` disparava).

Trade-off aceito: como o tracker mais distante "ganha", uma chegada real
pode demorar um pouco mais para acender o refletor se o `icloud` (que so
faz poll a cada ~30 min) ainda nao atualizou — prefere-se esse atraso a
perder uma saida real por causa de um `mobile_app` travado.

## Logica de chegada

1. Mudancas de localizacao (iPhones, Creta), sol e trava do Creta alimentam
   `sec_prepare_arrival_context`, que mescla o tracker `mobile_app` com o
   `icloud` de cada pessoa (ver secao acima) e calcula distancia ate
   `HOME_LAT`/`HOME_LON` (`distance_m`) e ate `GATE_LAT`/`GATE_LON`
   (`gate_distance_m`) para cada entidade rastreada.
2. Gabriel, Valeria e Creta "armam" (`armed[nome] = true`) quando ficam a
   mais de 100 m de casa (`ARM_DISTANCE_M`, medido so contra
   `HOME_LAT`/`HOME_LON`).
3. A "chegada" e detectada (node `sec_detect_arriving_source`) quando uma
   entidade armada volta para ate **300 m** de `HOME_LAT`/`HOME_LON`
   **ou** para ate **300 m** de `GATE_LAT`/`GATE_LON`
   (`ARRIVAL_DISTANCE_M`, mesmo valor para os dois pontos). O ponto do
   portao/entrada (`GATE_LAT`/`GATE_LON` = 20°18'34.2"S 40°18'57.6"W, ~168 m
   de `HOME_LAT`/`HOME_LON`) existe para acender o refletor um pouco antes
   da chegada de fato em casa. Esse mesmo valor de 300 m (so contra
   `HOME_LAT`/`HOME_LON`) e usado para `creta_home`
   (`sec_prepare_arrival_context`) e para limpar o armamento por contexto
   (`sec_update_arming_context`) — esses dois **nao** contam o ponto do
   portao, de proposito: eles decidem quando o Creta "esta em casa" para
   desligar o refletor/parar de escutar motor e trava, e usar o ponto do
   portao ali desligaria a luz cedo demais, antes do carro/pessoa
   efetivamente chegar.
4. Se a chegada for do Creta, o refletor liga direto (dado que a chegada
   ja e do proprio carro).
5. Se a chegada for de pessoa (Gabriel/Valeria), so liga se
   `binary_sensor.creta_engine` estiver `on`, ou, como fallback (atraso da
   integracao Kia), se o Creta estava armado como fora e ja aparece a ate
   700 m de casa (`CRETA_APPROACH_DISTANCE_M`).
6. So liga se estiver escuro (`sun.sun` = `below_horizon`) e se o refletor
   ainda nao estiver ativo por chegada (evita re-disparo).
7. Desliga sozinho apos 10 minutos, ou imediatamente quando o Creta e
   confirmado em casa (`creta_home`), desliga o motor ou tranca a porta
   estando em casa.

## Atualizacao de localizacao (refresh)

Node `sec_refresh_every_10min` (inject, apesar do nome roda a cada 1 min)
dispara `sec_refresh_anyone_away` a cada ciclo:

- Enquanto alguem estiver fora, pede `request_location_update` para os
  iPhones **a cada 1 min** (barato, sem rate limit conhecido).
- O refresh forcado do Creta (`button.creta_force_refresh` +
  `homeassistant.update_entity`) roda **a cada 5 min** por padrao, mas passa
  a rodar **a cada 1 min** quando o proprio Creta esta a menos de 1500 m de
  casa (`KIA_NEARBY_DISTANCE_M`). Isso existe porque a integracao `kia_uvo`
  tem lag e rate limit da API da Kia/Hyundai — forcar refresh com frequencia
  alta o tempo todo arrisca bloqueio temporario da conta e drena a bateria de
  12V do carro. A aceleracao so perto de casa concentra o refresh extra
  exatamente na janela em que a deteccao de chegada precisa de dado fresco.
- O cooldown de 5 min (`sec_kia_last_force_refresh_ts`) so e marcado pelo
  node `sec_creta_refresh_ack`, alimentado pela saida (antes desconectada)
  de `sec_force_refresh_creta`. Ou seja: so conta como "refresh feito" se a
  chamada `button.press` realmente teve sucesso. Antes o timestamp era
  gravado de forma otimista dentro de `sec_refresh_anyone_away`, antes mesmo
  do node de chamada de servico rodar — se a chamada falhasse (ex: Home
  Assistant fora do ar/reiniciando), o cooldown era consumido do mesmo jeito
  e o proximo retry só aconteceria 5 min depois, mesmo que o tick de 1 min
  continuasse rodando. Ver "Historico relevante" (2026-07-10, HA reiniciando
  em loop).

## Historico relevante

- Commit `2026-07`: raio de chegada ampliado de 50 m para 300 m (GPS do
  iPhone/Kia nao era preciso o suficiente para confirmar chegada a 50 m de
  forma confiavel) — alinhado nos tres pontos que usavam esse valor, e no
  texto do comentario `sec_comment_arrival_light`.
- Mesma leva: refresh de localizacao acelerado (1 min para iPhones sempre
  que alguem esta fora; 1 min para o Creta so quando ele esta perto de
  casa) para reduzir a lentidao entre o carro chegar e o refletor acender.
- 2026-07-10: Valeria aparecia como "em casa" (tracker `mobile_app`, ~27 m)
  enquanto estava no trabalho a ~5,2 km (confirmado pelo tracker `icloud`,
  `device_tracker.iphone_de_valeria_2`). Adicionado fallback via iCloud
  para Gabriel e Valeria — ver secao "Fallback de localizacao via iCloud"
  acima. Testado ao vivo: com os dois trackers reais buscados via API do
  Home Assistant, a logica de merge escolheu corretamente a leitura do
  `icloud` (~5216 m) em vez da leitura travada do `mobile_app` (~27 m).
  Tambem corrigido o texto de `sec_notify_valeria_approaching`, que dizia
  "Valeria ou Gabriel" mas so dispara para `source === "valeria"`.
- 2026-07-10: adicionado um segundo ponto de referencia,
  `GATE_LAT`/`GATE_LON` (20°18'34.2"S 40°18'57.6"W, portao/entrada, ~168 m
  de `HOME_LAT`/`HOME_LON`), para a deteccao de chegada em
  `sec_detect_arriving_source`: chegar a ate 300 m desse ponto conta como
  chegada, igual a chegar a ate 300 m de `HOME_LAT`/`HOME_LON`, para
  Gabriel, Valeria e Creta. Objetivo: acender o refletor um pouco antes da
  chegada em casa de fato. De proposito, `creta_home`
  (`sec_prepare_arrival_context`) e a limpeza de armamento
  (`sec_update_arming_context`) continuam usando so `HOME_LAT`/`HOME_LON` —
  usar o ponto do portao ali desligaria o refletor cedo demais.
- 2026-07-10: investigado por que `binary_sensor.creta_engine` (e as demais
  entidades `creta_*`) nao refletiram o uso do carro nesse dia. Causa
  raiz nao foi o `kia_uvo`/`hyundai_kia_connect_api` em si (a chamada de
  localizacao `/location/park` retorna 400 quando o carro esta em
  movimento — comportamento esperado da API BR da Hyundai, ja tratado com
  try/except na lib e sem efeito nos outros sensores). A causa real: o
  container `homeassistant` foi reiniciado varias vezes seguidas nessa
  manha (~09:13–09:46, sem `OOMKilled` e sem `RestartCount` do Docker —
  ou seja, reinicios externos/manuais, nao crash), e o Node-RED log mostrou
  `[error] [api-call-service:Forcar refresh Creta] ... "Connection lost"`
  as 09:46 exatamente nessa janela. Como `sec_refresh_anyone_away` marcava
  o cooldown de 5 min *antes* de saber se a chamada teria sucesso, essa
  falha bloqueou os proximos retries por 5 min inteiros, e como o HA seguiu
  instavel nessa janela, o Creta ficou sem atualizar por bem mais tempo que
  o esperado. Corrigido movendo a marcacao do cooldown para depois da
  confirmacao de sucesso (node `sec_creta_refresh_ack`) — ver secao
  "Atualizacao de localizacao" acima. Os reinicios repetidos do HA em si
  nao tem causa identificada no repo (nenhum script/cron daqui reinicia o
  container) — se voce nao reiniciou manualmente essa manha, vale investigar
  se ha outro processo/sessao mexendo no `docker compose` da smart home.
- 2026-07-10 (mesmo dia, investigacao separada): mesmo com o fix acima, o
  usuario reportou que o **historico** de `binary_sensor.creta_engine`
  continuava sem bater com o app Bluelink. Causa raiz e fix completo em
  [docs/CRETA_KIA_UVO_INTEGRATION.md](CRETA_KIA_UVO_INTEGRATION.md) —
  resumo: o polling de status so amostra o motor esporadicamente (nunca
  capturou "on" em nenhuma das viagens confirmadas por
  `device_tracker.creta_location`), entao foi adicionado um sensor separado
  (`sensor.garagem_creta_day_trip_info`) alimentado pelo endpoint de
  tripinfo (mesma fonte do historico de viagens do app), atualizado
  automaticamente pelos novos nodes `sec_creta_trip_refresh_gate` →
  `sec_refresh_creta_trip_info` sempre que o Creta chega em casa
  (`arrival_source_type === "creta"` em `sec_detect_arriving_source`).

## Manutencao

Sempre que este flow for alterado (limiares de distancia, cadencia de
refresh, entidades envolvidas), atualizar esta doc na mesma mudanca.
