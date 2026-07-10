# Integracao Creta (kia_uvo / Hyundai Bluelink Brasil)

## O que e

`custom_components/kia_uvo` (fork local, nao HACS puro) conecta ao Hyundai
Bluelink Brasil via `hyundai_kia_connect_api` (`HyundaiBlueLinkApiBR`) para
expor localizacao, status (motor, portas, combustivel etc.) e controles do
Creta como entidades Home Assistant. Documentado tambem em
[docs/ILUMINACAO_SEGURANCA_NODERED.md](ILUMINACAO_SEGURANCA_NODERED.md)
(uso das entidades `creta_*` no fluxo de chegada/seguranca).

## Por que o historico de `binary_sensor.creta_engine` nao bate com o app Bluelink

**2026-07-10:** usuario reportou que o historico do motor nao refletia o uso
real do carro, enquanto o app Bluelink mostrava certo. Investigacao:

- O sensor `binary_sensor.creta_engine` e alimentado pelo campo `engine` do
  endpoint de status (`/status/latest` ou `/ccs2/carstatus/latest`), lido a
  cada poll do coordinator.
- Por padrao (`options: {}` no config entry, ou seja, tudo default) o
  coordinator so faz uma leitura *ao vivo* forcada automaticamente **uma vez
  por dia** (`DEFAULT_FORCE_REFRESH_INTERVAL = 1440` min); todo o resto do
  tempo le o cache do servidor da Hyundai (`update_all_vehicles_with_cached_state`).
  As leituras ao vivo "extras" vem do `button.creta_force_refresh`
  (`nodered/flows.json`, node `sec_force_refresh_creta`), disparado a cada 5
  min (1 min quando o Creta esta perto de casa) **apenas enquanto alguem
  esta "fora"** — ver "Atualizacao de localizacao" em
  ILUMINACAO_SEGURANCA_NODERED.md.
- Verificado ao vivo: um `button.press` manual em `button.creta_force_refresh`
  de fato busca dado fresco (timestamp `sensor.creta_last_updated_at`
  avancou corretamente). O parsing do campo `engine` tambem esta correto
  (`sensor.creta_data` expõe o payload cru, `"engine": false` bate com o
  estado do carro no momento).
- Ou seja: o mecanismo funciona, mas so amostra o estado do motor nos raros
  instantes em que o Node-RED decide forcar um refresh. Conferindo o
  historico de `device_tracker.creta_location` de 2026-07-09, o carro fez
  duas viagens completas (10:14-14:19 e 22:35-23:14) — nesse mesmo periodo,
  `binary_sensor.creta_engine` **nunca uma vez** registrou "on". A API da
  Hyundai BR tambem so aceita `/location/park` (localizacao) quando o carro
  esta parado (retorna 400 em movimento, ver
  `hyundai_kia_connect_api.HyundaiBlueLinkApiBR._get_vehicle_location`) — o
  que sugere que o status "ao vivo" desse backend so e reportado de forma
  confiavel em eventos de estacionamento, nao continuamente durante a
  viagem. Amostragem esparsa (a cada poucos minutos, só quando "fora") tem
  chance real de nunca coincidir com uma janela em que o motor estava
  ligado.

**Nao e um bug de parsing nem de deploy** — e uma limitacao de amostragem
(e possivelmente do proprio backend da Hyundai BR) que fazer o polling mais
frequente so mitigaria parcialmente, e aumentaria o risco de rate-limit /
dreno da bateria de 12V (ja documentado em ILUMINACAO_SEGURANCA_NODERED.md).

## Fix: sensor de historico de viagens (`sensor.garagem_creta_day_trip_info`)

Em vez de tentar reconstruir "motor ligado quando" a partir do polling de
status, adicionado um caminho separado que usa a **mesma fonte de dados que
o app Bluelink usa para o historico de viagens**: o endpoint
`/spa/vehicles/{id}/tripinfo`, ja implementado na lib
(`HyundaiBlueLinkApiBR.update_day_trip_info` /
`VehicleManager.update_day_trip_info`) mas nao exposto por nenhuma entidade
antes desta mudanca.

Adicionado em `custom_components/kia_uvo/`:

- `coordinator.py`: `async_refresh_day_trip_info(vehicle_id)` — busca o
  tripinfo do dia atual (`YYYYMMDD` local) e atualiza `vehicle.day_trip_info`.
- `button.py`: novo botao `button.garagem_creta_refresh_trip_info` (chave
  `refresh_trip_info`) que dispara esse refresh.
- `sensor.py`: novo `DayTripInfoEntity` →
  `sensor.garagem_creta_day_trip_info`. Estado = numero de viagens hoje;
  atributos = lista de viagens (`start_time`, `drive_time_min`,
  `idle_time_min`, `distance`, `avg_speed`, `max_speed`) + resumo do dia.
  Fica `unknown` ate o botao ser pressionado ao menos uma vez.

**Nota de nomenclatura:** o device do Creta tem `area_id: garagem`, e
entidades novas herdam o prefixo da area no entity_id
(`garagem_creta_...`), diferente das entidades antigas (`creta_force_refresh`
etc., criadas antes da area existir/mudar de comportamento). Inconsistente,
mas intencionalmente deixado assim em vez de mexer no entity registry ao
vivo — usar o entity_id real (`garagem_creta_*`) em qualquer automação nova
que referencie o botao/sensor de trip info.

### Por que nao busca automaticamente a cada poll

`/tripinfo` e uma chamada de API separada do status/localizacao normal.
Chamar isso no mesmo ritmo do refresh de localizacao (1-5 min enquanto
"fora") multiplicaria as chamadas a API da Hyundai sem necessidade — dados
de viagem so mudam quando uma viagem termina, nao a cada minuto durante
ela. Em vez disso, `nodered/flows.json` (`sec_creta_trip_refresh_gate` →
`sec_refresh_creta_trip_info`) pressiona esse botao automaticamente **uma
vez, exatamente quando o Creta chega em casa** (mesmo evento de "chegada"
que liga o refletor de seguranca, filtrado para `arrival_source_type ===
"creta"`) — o momento natural em que uma viagem acabou de ser concluida e
vai aparecer no tripinfo do dia.

### Testado ao vivo (2026-07-10)

Apos pressionar `button.garagem_creta_refresh_trip_info` manualmente,
`sensor.garagem_creta_day_trip_info` mostrou corretamente a viagem da
manha: inicio `07:40:40`, 16 km, velocidade media 26 km/h, maxima 88 km/h —
dado que `binary_sensor.creta_engine` nunca capturou.

## Manutencao

Sempre que mexer no fluxo de chegada (`sec_detect_arriving_source` e afins)
em ILUMINACAO_SEGURANCA_NODERED.md, lembrar que `sec_creta_trip_refresh_gate`
depende de `msg.payload.arrival_source_type` continuar sendo setado do
jeito que esta hoje.
