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

## Update do fork removeu e depois reportou o sensor de trip-log (2026-07-19)

Um update de upstream (HACS-style) sobrescreveu o fork local sem commit
previo, trazendo features novas (botoes de valet mode, sensores de pressao
dos pneus, `drive_mode`, fix do device_class de bateria em EV/PHEV;
`hyundai_kia_connect_api` 4.23.1 → 4.25.2, `manifest.json` versao 3.6.0 →
3.8.0) mas **removendo silenciosamente** tudo que foi adicionado na secao
"Fix: sensor de historico de viagens" acima:
`coordinator.async_refresh_day_trip_info`, o botao
`button.garagem_creta_refresh_trip_info` e a entidade `DayTripInfoEntity`
(`sensor.garagem_creta_day_trip_info`).

**Reportado de volta no mesmo dia**, ja que `nodered/flows.json`
(`sec_refresh_creta_trip_info`) continua dependendo dessa entidade.
`VehicleManager.update_day_trip_info` e `Vehicle.day_trip_info` continuam
com a mesma assinatura na versao nova da lib (confirmado via
`inspect.signature` dentro do container), entao o reporte foi um
copy-paste direto do codigo que ja existia no commit `fcefeec` para cima
da base nova — sem alteracoes de logica. Tambem adicionadas as chaves
`day_trip_info` (sensor) e `refresh_trip_info` (button) em `strings.json`
e `translations/en.json` (so ingles, mesmo escopo do commit original).
Entidades confirmadas de volta no entity registry (`restored: true`,
`friendly_name` correto) apos restart; ficam `unavailable` ate a API da
Hyundai voltar a responder (ver secao de fix abaixo), o que e esperado.

**Licao:** esse componente e um fork local editado diretamente no host
(nao um HACS gerenciado), mas alguma coisa (HACS rodando dentro do
container? processo manual?) consegue sobrescreve-lo com uma versao
upstream sem passar por git. Vale investigar a origem do update numa
proxima sessao para nao perder essa feature de novo silenciosamente — por
ora, so vigiar `git status` nesse diretorio de vez em quando.

## Fix: `UpdateFailed` com traceback completo no log (2026-07-19)

Sintoma: setup falhando com `Config Not Ready: Error communicating with
API: Traceback (most recent call last): ...` — um traceback inteiro
dumpado dentro da mensagem de erro do config entry, causado por um 503 da
API da Hyundai BR (`br-ccapi.hyundai.com.br`, servico deles fora do ar
temporariamente — nao e algo que da pra corrigir do nosso lado).

O bloco de fallback em `coordinator.py::_async_update_data` (quando tanto
o force-refresh quanto o `update_all_vehicles_with_cached_state` falham)
usava `traceback.format_exc()` dentro do proprio `UpdateFailed(...)`,
deixando o log ilegivel, e nao passava `retry_after`, entao o config entry
ficava preso no backoff padrao (mais longo) do HA em vez de tentar de novo
rapido. Alinhado com o padrao ja usado no bloco de refresh de token (ver
`fcefeec`): mensagem curta com `retry_after=60`, traceback completo so no
`_LOGGER.debug`. Testado ao vivo: apos o fix, `reason` do config entry
passou a ser `Config Not Ready: Error communicating with API, will retry
in 60s: 503 Server Error: ...` em vez do traceback completo.

**Correcao importante:** o paragrafo acima (escrito antes da investigacao
abaixo) dizia que o 503 "nao e algo que da pra corrigir do nosso lado".
Isso estava errado — era um endpoint errado sendo chamado, nao a Hyundai
fora do ar. Ver secao seguinte.

## Fix de verdade: endpoint `/status/latest` obsoleto para este veiculo (2026-07-19)

**Sintoma:** desde 2026-07-14, TODA chamada a
`/spa/vehicles/{id}/status/latest` (usada tanto pelo poll cached quanto
pelo force-refresh) retornava 503 com corpo
`{"resCode":"5031","resMsg":"Unavailable remote control - Service
Temporary Unavailable"}`. `get_vehicles()` (`/spa/vehicles`, sem o id) e
`/location/park` continuavam funcionando normalmente — so esse endpoint
especifico quebrado, de forma consistente, nao intermitente. Confirmado
via `docker logs` que a ultima leitura real de status foi 2026-07-11
13:15, e as falhas comecaram sem parar em 2026-07-14 04:01 (~900+
ocorrencias entre 07-14 e 07-19).

**Causa raiz:** `HyundaiBlueLinkApiBR._get_vehicle_state` escolhe entre
dois endpoints com base na flag `ccuCCS2ProtocolSupport` que a propria
Hyundai retorna em `/spa/vehicles` (lista de veiculos):

```python
if not vehicle.ccu_ccs2_protocol_support:
    url = url + "/status/latest"          # flag == 0
else:
    url = url + "/ccs2/carstatus/latest"   # flag == 1
```

Para esse Creta a flag sempre retornou `0`. Testando manualmente (chamada
GET direta, read-only, com o token ja salvo) descobri que
`/ccs2/carstatus/latest` retorna **200 com dados frescos** para o mesmo
veiculo, no mesmo momento em que `/status/latest` retorna 503. Ou seja: a
Hyundai migrou o backend desse veiculo (ou desse lote de veiculos/versao
de TCU) para o protocolo CCS2 em algum momento por volta de 14/07, mas
**nao atualizou a flag** que a propria API expoe para indicar isso. O app
oficial funciona porque, aparentemente, nao depende dessa flag (ou usa
CCS2 por padrao). Nao e bloqueio anti-abuso nem sessao/token/device_id —
username+senha+device_id compartilhado da lib continuam funcionando 100%
normal (login, listagem de veiculos, controle) o tempo todo; so esse
endpoint de status especifico estava apontado errado.

**Fix, em duas partes** (`coordinator.py::_force_ccs2_status_endpoint`,
chamado a cada `_async_update_data`):

1. Forca `vehicle.ccu_ccs2_protocol_support = True` para ignorar a flag
   errada da Hyundai e sempre usar `/ccs2/carstatus/latest`.
2. A resposta do CCS2 tem um schema completamente diferente (aninhado,
   `resMsg.state.Vehicle.Cabin.Door.Row1.Driver.Open` em vez de
   `resMsg.doorOpen.frontLeft`), entao so trocar a URL nao bastava — o
   parser `_update_vehicle_properties` da BR (feito pra shape plano) lia
   tudo errado silenciosamente (`.get()` sempre caindo no default). A lib
   ja tem um parser CCS2 completo e maduro em `ApiImplType1` (usado por
   outras regioes que sao CCS2-nativas, como EU/AU — referencias a varias
   issues reais do GitHub nos comentarios: #1538, #1786, #1783, #1232,
   #1652, #1205, #1187, #1771). Em vez de reescrever o parsing, o fix
   troca dinamicamente o metodo bound `api._update_vehicle_properties`
   (via `types.MethodType`) por um wrapper que faz o drill-down
   `resMsg["state"]["Vehicle"]` (a lib EU chama
   `_update_vehicle_properties_ccs2` ja com esse nivel, confirmado lendo
   `KiaUvoApiEU.py`) e delega pro parser CCS2 existente. Unica dependencia
   de `self` nesse parser e `self.data_timezone`, que a classe BR tambem
   define com o mesmo nome — por isso da pra "emprestar" o metodo sem
   reescrever nada.
3. Unico campo que o parser CCS2 nao preenche e o parser BR preenchia:
   `fuel_driving_range` (ele so seta `total_driving_range`, um atributo
   diferente). Descoberto comparando programaticamente todo `vehicle.X =`
   dos dois parsers. Corrigido com um alias de uma linha depois de chamar
   o parser CCS2, em vez de mudar `sensor.py` (mantem o mesmo entity_id
   `sensor.creta_fuel_driving_range`).

**Testado ao vivo, ponta a ponta:** antes do fix, script standalone
reproduzindo a chamada `/ccs2/carstatus/latest` batia num bug separado da
lib (`float(None)` em `Drivetrain.FuelSystem.DTE.Total` — bug de nivel
errado, nao da Hyundai) ate eu descobrir o drill-down correto. Depois do
fix completo + restart: config entry foi de `setup_retry` (contínuo desde
07-14) para `loaded`; `sensor.creta_fuel_level` = 20 (antes
`unavailable`), `sensor.creta_car_battery_level` = 62,
`sensor.creta_fuel_driving_range` = 110.0, `sensor.creta_last_updated_at`
= 2026-07-18T17:24:41Z (dado fresco, nao mais o cache de 07-11),
`device_tracker.creta_location` = home. Zero erros nos logs pos-restart.
De bonus, o parser CCS2 preenche ~65 campos que o parser BR nunca setava
(pressao dos pneus, drive_mode, avisos de oleo/bateria 12V, varios campos
EV) — as `SENSOR_DESCRIPTIONS` de `tire_pressure_*`/`drive_mode`
adicionadas pelo update de upstream (ver secao anterior) agora tem chance
real de popular, quando o veiculo reportar esses dados (esse Creta
especifico nao reporta `drive_mode`/pressao individual dos pneus — ficam
`None`, o que e esperado, nao erro).

**Nao investigado:** por que a Hyundai migrou esse veiculo pra CCS2 sem
atualizar a flag, e se isso pode acontecer de novo (mudar pra `0` de
novo, ou algum outro veiculo BR ter o mesmo problema). Se `ccuCCS2ProtocolSupport`
comecar a vir `1` no futuro, `_force_ccs2_status_endpoint` continua
funcionando igual (forcar True quando ja e True e no-op).

Editado via `docker cp` + `docker exec -u 0` (ver secao de ownership
acima); aplicado com `homeassistant.restart` via API (reload de config
entry sozinho **nao** reimporta o modulo Python do custom_component —
confirmado ao vivo: apos so um reload, o traceback continuou aparecendo no
formato antigo, com numeros de linha incoerentes porque o objeto de codigo
em memoria ainda era o antigo mas o `linecache` estava lendo o arquivo
novo do disco).
