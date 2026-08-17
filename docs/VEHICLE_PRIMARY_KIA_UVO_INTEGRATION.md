# Integracao vehicle_primary (kia_uvo / Hyundai Bluelink Brasil)

## O que e

`custom_components/kia_uvo` (fork local, nao HACS puro) conecta ao Hyundai
Bluelink Brasil via `hyundai_kia_connect_api` (`HyundaiBlueLinkApiBR`) para
expor localizacao, status (motor, portas, combustivel etc.) e controles do
vehicle_primary como entidades Home Assistant. Documentado tambem em
[docs/ILUMINACAO_SEGURANCA_NODERED.md](ILUMINACAO_SEGURANCA_NODERED.md)
(uso das entidades `vehicle_primary_*` no fluxo de chegada/seguranca).

## Estado atual (2026-08-16)

- Componente sincronizado com o upstream `kia_uvo` **3.10.1** e
  `hyundai_kia_connect_api` **4.26.5**. O diff oficial 3.10.0 -> 3.10.1
  altera somente essa dependencia. Entre 4.26.1 e 4.26.5 nao houve mudanca
  no backend Brasil nem no comando horn/light; entraram correcoes EU, USA e
  do sentinel de agenda CCS2.
- A biblioteca 4.26.x incorporou o suporte nativo ao vehicle_primary brasileiro:
  `/ccs2/carstatus/latest`, parser CCS2, wake real por
  `/ccs2/carstatus`, rejeicao de snapshot que nao avancou e interpretacao do
  campo `Date` como UTC. Os monkey patches locais que duplicavam essas funcoes
  foram removidos.
- Permanecem locais somente as extensoes necessarias nesta instalacao:
  viagens de hoje e ontem, estimativa conservadora de consumo, refresh do
  tripinfo por movimento do odometro, tolerancia ao `DTE.Unit` anomalo e o
  alias historico de autonomia de combustivel. Tambem permanece uma correcao
  estreita para `Location.TimeStamp`: a API 4.26.5 ainda rotula esse relogio UTC
  como horario regional e desloca somente a entidade de localizacao em +3 h.
  O stub reservado `OffPeakTime: {Mode: 1}` dos modelos a combustao tambem e
  ignorado para nao criar horarios EV ficticios em 00:00 nem warning por poll.
- O botao de force refresh conserva um piso de **15 minutos entre wakes reais**.
  Dentro desse intervalo ele faz apenas leitura do cache. Com `options: {}` o
  scheduler nativo consulta cache a cada 30 minutos e so considera wake proprio
  apos 1440 minutos; a politica Node-RED pede wake a cada 15 minutos quando
  habilitada.
- O historico de viagens e carregado uma vez ao iniciar a integracao, quando o
  odometro avanca e na chegada do vehicle_primary. O dashboard nao depende mais de press
  manual para voltar a exibir viagens depois de restart.
- Bateria 12 V `unknown` pode ser um estado correto: quando
  `SensorReliability=1`, o valor bruto e deliberadamente descartado pela
  biblioteca e o painel informa que aguarda uma leitura confiavel.

### Fluxo de dados e contratos

```text
Bluelink BR -> hyundai_kia_connect_api 4.26.5 -> coordinator kia_uvo
             -> entidades Home Assistant -> contexto_vehicle_primary (Node-RED)
             -> security.vehicle_primary-context.v1 -> chegada/iluminacao
```

`contexto_vehicle_primary` reage a mudanca de zona e a deslocamento GPS acumulado de no
minimo 250 m, descontando a precisao reportada. A coordenada fica somente no
contexto persistente e nunca vai para logs. Movimento solicita atualizacao dos
dados, mas **nao** autoriza sozinho qualquer acao fisica: iluminacao continua
exigindo motor/contexto frescos.

O refresh grava baseline dos timestamps de localizacao, motor e trava. Uma
tentativa so vira sucesso quando pelo menos um deles avanca e o alvo de
readiness e atingido. Sem evidencia, o mesmo recovery segue backoff de
1, 2, 4, 8 e 15 minutos; o contador satura sem criar rajadas ou loops.
Eventos operacionais usam `VEHICLE_PRIMARY_LOCATION_CHANGED`,
`VEHICLE_PRIMARY_MOVEMENT_DETECTED`, `VEHICLE_PRIMARY_REFRESH_REQUESTED`,
`VEHICLE_PRIMARY_REFRESH_RETRY`, `VEHICLE_PRIMARY_NEW_DATA_RECEIVED`, `VEHICLE_PRIMARY_TRIP_UPDATED` e
`VEHICLE_PRIMARY_API_ERROR`, sempre sem coordenadas ou credenciais.

O mesmo estado persistente `security_vehicle_primary_refresh_v1` agora alimenta
`contexto_vehicle_primary.refresh` e o sensor MQTT
`sensor.vehicle_primary_refresh_coordinator`. Os campos publicados sao `state`,
`reason`, `attempt`, `last_request_at`, `last_success_at`, `next_retry_at` e
`cooldown_until`. O ticker MQTT de 5 s somente calcula o tempo restante a
partir desses deadlines; ele nao agenda refresh nem mantem um timer paralelo.
`input_button.vehicle_primary_force_refresh_now` entra no ciclo normal de snapshot com
`reason=manual_force`: pode quebrar cooldown de sucesso, mas nunca o backoff de
uma tentativa em voo nem o piso de 15 minutos do coordinator Python. Se o clique
manual for bloqueado por uma tentativa em backoff, o Home Assistant cria
imediatamente uma notificação persistente informando que nenhuma nova consulta
foi enviada e mostrando o tempo e o horário da próxima tentativa automática.

O carregamento inicial da integração não espera por `/tripinfo`. Esse endpoint
é opcional e pode responder muito lentamente no backend brasileiro; bloquear
nele impediria a criação das entidades de status e faria o painel continuar
mostrando estado restaurado antigo. No startup o odômetro-base é registrado e a
carga de hoje/ontem é iniciada em segundo plano, com timeout de 120 segundos,
uma nova tentativa após 60 segundos e deduplicação por veículo. Movimento do
odômetro agenda outra carga, e existe uma reconciliação de segurança a cada seis
horas mesmo que nenhum movimento tenha sido observado pelo Home Assistant. O
botão específico de viagens continua disponível para atualização explícita.

Os aliases `button.vehicle_primary_force_refresh` e
`button.garagem_vehicle_primary_refresh_trip_info` publicados por
`public_bindings` são estados sintéticos para leitura e não podem receber
`button.press` diretamente. O Node-RED chama as ações allowlisted
`vehicle_primary.force_refresh` e `vehicle_primary.refresh_trip_info` pelo
serviço `public_bindings.call`, que resolve internamente as entidades privadas.
Chamadas redundantes de `homeassistant.update_entity` nos aliases sintéticos
foram removidas; a atualização chega pelos eventos das entidades-fonte após o
serviço bloqueante terminar.

O diagnóstico `sensor.vehicle_primary_refresh_coordinator` é uma entidade MQTT
pública nativa, sem alias intermediário em `public_bindings`. Isso evita disputa
de ID e sufixos dependentes da ordem de inicialização. A descoberta publica uma
tombstone para o tópico-fonte transitório usado durante a migração. No painel,
o backoff da atualização e o comando independente de luzes/buzina são exibidos
em cards separados.

As secoes datadas abaixo preservam o historico da investigacao. Onde falarem
em `_force_ccs2_status_endpoint()` ou `_install_br_wake_force_refresh()`, leia
como solucao anterior, substituida pelo suporte upstream descrito acima.

## Por que o historico de `binary_sensor.vehicle_primary_engine` nao bate com o app Bluelink

**2026-07-10:** usuario reportou que o historico do motor nao refletia o uso
real do carro, enquanto o app Bluelink mostrava certo. Investigacao:

- O sensor `binary_sensor.vehicle_primary_engine` e alimentado pelo campo `engine` do
  endpoint de status (`/status/latest` ou `/ccs2/carstatus/latest`), lido a
  cada poll do coordinator.
- Por padrao (`options: {}` no config entry, ou seja, tudo default) o
  coordinator so faz uma leitura *ao vivo* forcada automaticamente **uma vez
  por dia** (`DEFAULT_FORCE_REFRESH_INTERVAL = 1440` min); todo o resto do
  tempo le o cache do servidor da Hyundai (`update_all_vehicles_with_cached_state`).
  As leituras ao vivo "extras" vêm do `button.vehicle_primary_force_refresh`
  (`nodered/flows.json`, flow `contexto_vehicle_primary`, node
  `vehicle_primary_force_refresh`). A política conjunta em `contexto_chegadas` pede o
  refresh periódico a cada 15 min quando alguém está fora, ou entre 07h e
  22h quando todos estão em casa — ver "Refresh" em
  ILUMINACAO_SEGURANCA_NODERED.md.
- Verificado ao vivo: um `button.press` manual em `button.vehicle_primary_force_refresh`
  de fato busca dado fresco (timestamp `sensor.vehicle_primary_last_updated_at`
  avancou corretamente). O parsing do campo `engine` tambem esta correto
  (`sensor.vehicle_primary_data` expõe o payload cru, `"engine": false` bate com o
  estado do carro no momento).
- Ou seja: o mecanismo funciona, mas so amostra o estado do motor nos raros
  instantes em que o Node-RED decide forcar um refresh. Conferindo o
  historico de `device_tracker.vehicle_primary_location` de 2026-07-09, o carro fez
  duas viagens completas (10:14-14:19 e 22:35-23:14) — nesse mesmo periodo,
  `binary_sensor.vehicle_primary_engine` **nunca uma vez** registrou "on". A API da
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

> **CORRECAO (2026-08-07): a conclusao acima estava errada.** Nao era
> amostragem esparsa — o `button.vehicle_primary_force_refresh` **nunca forcou nada**.
> A implementacao BR so relia o snapshot em cache. O sensor de motor nao
> estava mal amostrado, estava sem dado. Ver a secao
> "Force refresh nunca acordava o carro" abaixo.
>
> A observacao de 2026-07-10 de que "um press manual busca dado fresco"
> provavelmente pegou uma coincidencia: o backend tinha dado novo por outro
> motivo (um evento de estacionamento, ou o proprio app aberto no celular),
> e o timestamp avancou sem que o nosso force tivesse causado isso.

## Historico: force refresh nunca acordava o carro (2026-08-07)

**Sintoma:** usuario ligou o carro e reportou que `binary_sensor.vehicle_primary_engine`
nao mexia — nem no HA, nem no proprio app Bluelink.

**Diagnostico, medido ao vivo com o motor ligado:**

- Cada `button.press` chegava na API sem erro (com a atualizacao para 3.9.0 os
  erros 500 do `br-ccapi` pararam), e `sensor.vehicle_primary_last_scanned_at` avancava a
  cada ciclo — o HA estava recebendo resposta.
- Mas `sensor.vehicle_primary_last_updated_at` (o timestamp **do veiculo**) ficou
  congelado em 16:11:03 durante 4 minutos de motor comprovadamente ligado.
- **A chamada voltava em 160 ms.** Esse foi o dado decisivo: um poll real, que
  acorda o carro pela rede celular, leva 10-30 s. 160 ms so pode ser cache.
- O usuario apertou refresh no app Bluelink; o `last_updated_at` pulou para
  16:17:08 e o nosso ciclo seguinte leu `engine=on` — a primeira transicao do
  sensor em 5 dias.

**Causa raiz:** `HyundaiBlueLinkApiBR.force_refresh_vehicle_state` tem a
docstring "wakes up the vehicle", mas so faz `GET /ccs2/carstatus/latest` (o
snapshot em cache) com um header `REFRESH: true` que o backend BR ignora.

**A engenharia reversa ja estava feita** — na propria biblioteca, para a regiao
EU. `KiaUvoApiEU._force_refresh_vehicle_state_ccs2` documenta a sequencia
correta para veiculos CCS2: `GET /ccs2/carstatus` (**sem** `/latest`) acorda o
veiculo e devolve um envelope de comando assincrono, nao o estado; espera-se o
carro reportar e so entao le-se o `/latest` ja fresco. A classe BR nunca
recebeu esse metodo.

**Fix:** `_install_br_wake_force_refresh()` em
`custom_components/kia_uvo/coordinator.py` porta a sequencia, seguindo o mesmo
padrao de monkey-patch na instancia da API ja usado por
`_force_ccs2_status_endpoint` (o custom_component e versionado no repo; a lib
em site-packages seria perdida no proximo update de imagem).

Confirmado ao vivo logo apos aplicar:

```text
16:24:38  wake -> {"retCode":"S","resCode":"0000","msgId":"7c30a9c0-..."}
16:24:44  o CARRO reportou (6 s depois do wake)
16:25:03  HA leu /latest e aplicou; last_updated_at 16:17:08 -> 16:24:44
```

Duracao da chamada: 25 s (era 160 ms). O envelope `retCode: S` confirma que o
comando de wake foi aceito pelo backend.

**Detalhes que importam se alguem for mexer:**

- O wrapper parte **sempre** de `type(api)._get_vehicle_state` (a funcao da
  classe), nunca do atributo ja instalado na instancia. `_async_update_data`
  reinstala isto a cada ciclo, e envolver o wrapper anterior empilharia mais um
  `sleep(25)` por ciclo.
- **Piso de 15 min entre wakes reais** (`BR_WAKE_MIN_INTERVAL_S`). Acordar o
  carro puxa a bateria de 12 V e conta contra o rate limit — e' por isso que o
  options flow trava o force interval proprio da integracao em 90 min. Quem
  aperta o botão direto (o flow `contexto_vehicle_primary` no Node-RED, a cada 15 min,
  além do wake pontual na entrada da zona) também passa por esse piso.
  Dentro do cooldown a chamada degrada para a leitura em cache.
- O `sleep(25)` e o valor medido pelo upstream EU. Um refinamento possivel e
  trocar por `check_action_status(vehicle_id, msgId, ...)`, que ja e usado
  neste coordinator para comandos remotos e esperaria o tempo exato em vez de
  um valor fixo. Nao foi feito: o valor fixo funcionou e espelha o upstream.
- Nem todo wake produz dado novo. A tentativa das 16:23:24 foi aceita mas o
  `last_updated_at` nao avancou; a das 16:24:38 avancou. Vale lembrar que a
  API BR so aceita `/location/park` com o carro parado (400 em movimento), o
  que sugere que o backend continua limitado durante a viagem.

## Partida remota exige o carro TRAVADO (2026-08-07)

Ao testar o ciclo completo liga/desliga por `switch.vehicle_primary_climate`, a partida
falhava silenciosamente: HTTP 200, o switch nao latchava, nada acontecia no
carro (confirmado com o usuario olhando o veiculo).

**`retCode: "S"` no BR significa "comando enfileirado", NAO "comando
executado".** O request e a resposta imediata pareciam perfeitos:

```text
Start climate request:  {'action': 'start', 'options': {...,'igniOnDuration': 10},
                         'hvacType': 1, 'tempCode': '15H', 'unit': 'C'}
Start climate response: {'retCode': 'S', 'resCode': '0000', 'msgId': 'c35a0850-...'}
```

O desfecho real so aparece depois, no `check_action_status` — que devolve o
historico de comandos com `result` e uma mensagem em portugues:

```text
'action': 'bluelink://control/engine/start', 'result': 'fail',
'record': '[Falha] Falha na partida remota do motor. Verifique o status do seu
           veiculo. (por exemplo, Marcha na posicao P, Porta / Porta-Mala /
           Capo trancado e fechado, Ignicao desligada, etc.)'
```

**Causa:** o carro estava `unlocked`. Travando (`lock.lock` em
`lock.vehicle_primary_door_lock`) e repetindo, a partida funcionou de primeira —
confirmado fisicamente pelo usuario.

**Precondicoes da partida remota:** marcha em P, ignicao desligada, e portas /
porta-malas / capo **trancados e fechados**.

**Como depurar comandos remotos aqui:** nunca confie no `retCode` da resposta
imediata. Ligue o debug (`logger.set_level` em `custom_components.kia_uvo` e
`hyundai_kia_connect_api`) e leia o `Action status response` — o campo `record`
diz em portugues exatamente qual precondicao falhou. Sem isso o sintoma e
"HTTP 200 e nada acontece".

**Ciclo completo validado ao vivo, e a prova final do fix de wake:**

```text
17:04:57  partida enviada (carro travado)
17:05:04  HA le engine=on, climate=on   (last_updated_at 17:05:04)
17:05:44  parada enviada
17:05:51  HA le engine=off, climate=off (last_updated_at 17:05:51)
```

`binary_sensor.vehicle_primary_engine` — que tinha **0 transicoes em 5 dias** — registrou
o on->off inteiro sem ninguem abrir o app Bluelink. O sensor sempre funcionou;
o que faltava era dado fresco.

Nota: comandos remotos (`start_climate`/`stop_climate`) disparam o proprio
refresh da integracao pelo caminho `async_await_action_and_refresh`, entao
neste teste o dado fresco veio de la, nao do wake — o wake estava em cooldown
(409 s de 900 s) e degradou para cache, exatamente como projetado.

## Fix: sensor de historico de viagens (`sensor.garagem_vehicle_primary_day_trip_info`)

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
- `button.py`: novo botao `button.garagem_vehicle_primary_refresh_trip_info` (chave
  `refresh_trip_info`) que dispara esse refresh.
- `sensor.py`: novo `DayTripInfoEntity` →
  `sensor.garagem_vehicle_primary_day_trip_info`. Estado = numero de viagens hoje;
  atributos = lista de viagens (`start_time`, `drive_time_min`,
  `idle_time_min`, `distance`, `avg_speed`, `max_speed`) + resumo do dia.
  Fica `unknown` ate o botao ser pressionado ao menos uma vez.

**Nota de nomenclatura:** o device do vehicle_primary tem `area_id: garagem`, e
entidades novas herdam o prefixo da area no entity_id
(`garagem_vehicle_primary_...`), diferente das entidades antigas (`vehicle_primary_force_refresh`
etc., criadas antes da area existir/mudar de comportamento). Inconsistente,
mas intencionalmente deixado assim em vez de mexer no entity registry ao
vivo — usar o entity_id real (`garagem_vehicle_primary_*`) em qualquer automação nova
que referencie o botao/sensor de trip info.

### Quando o histórico é atualizado

`/tripinfo` e uma chamada de API separada do status/localizacao normal.
Chamar isso no mesmo ritmo do refresh de localização multiplicaria as chamadas
à API da Hyundai sem necessidade — dados de viagem só mudam quando uma viagem
termina, não a cada minuto durante ela. A integração consulta hoje/ontem em
segundo plano no startup, após avanço do odômetro e no máximo a cada seis horas
como reconciliação. Além disso, `nodered/flows.json`
(`vehicle_primary_arrival_actions` → `vehicle_primary_trip_refresh`) pressiona
o botão automaticamente quando o veículo chega em casa, momento natural em que
uma viagem encerrada deve aparecer no endpoint. Todas essas rotas preservam a
deduplicação e não bloqueiam a disponibilidade das entidades de status.

### Testado ao vivo (2026-07-10)

Apos pressionar `button.garagem_vehicle_primary_refresh_trip_info` manualmente,
`sensor.garagem_vehicle_primary_day_trip_info` mostrou corretamente a viagem da
manha: inicio `07:40:40`, 16 km, velocidade media 26 km/h, maxima 88 km/h —
dado que `binary_sensor.vehicle_primary_engine` nunca capturou.

## Manutencao

Sempre que mexer na chegada de `contexto_vehicle_primary`, lembrar que
`vehicle_primary_arrival_actions` depende de `security.arrival.v1` continuar publicando
`arrival_source_type: vehicle_primary`, `arrival_stage` e `event_at`.

Desde a etapa de recovery, a chegada e a atualização de trip info têm dedupe
persistente de 10 minutos. O lifecycle da viagem (`trip_active`,
`trip_started_at`) e o último `vehicle_primary_in_use` confirmado sobrevivem ao restart,
mas nunca substituem as entidades atuais: motor/trava expiram em 5 minutos e
localização em 30 minutos. Motor stale `off` durante uma viagem não encerra o
lifecycle; localização fresca fora de casa pode revalidar o estado persistido.
Sem evidência suficiente o contrato publica `in_use: null`/pending.

O parser do recovery rejeita tipos inesperados (por exemplo,
`in_use: "false"`), versões antigas, confirmação futura acima de 60 s e
confirmação sem timestamp. A confirmação expira após 24 h sem revalidação; a
limpeza publica contexto pending e não dispara ações físicas.

O refresh Bluelink persiste `attempts`, `next_allowed_at` e
`last_success_at`. Falhas usam backoff de 1, 2, 4, 8 e no máximo 15 minutos;
sucesso limpa tentativas e volta ao cooldown normal de 15 minutos. Isso evita
storm após restart e não registra viagem falsa durante indisponibilidade.

## Update do fork removeu e depois reportou o sensor de trip-log (2026-07-19)

Um update de upstream (HACS-style) sobrescreveu o fork local sem commit
previo, trazendo features novas (botoes de valet mode, sensores de pressao
dos pneus, `drive_mode`, fix do device_class de bateria em EV/PHEV;
`hyundai_kia_connect_api` 4.23.1 → 4.25.2, `manifest.json` versao 3.6.0 →
3.8.0) mas **removendo silenciosamente** tudo que foi adicionado na secao
"Fix: sensor de historico de viagens" acima:
`coordinator.async_refresh_day_trip_info`, o botao
`button.garagem_vehicle_primary_refresh_trip_info` e a entidade `DayTripInfoEntity`
(`sensor.garagem_vehicle_primary_day_trip_info`).

**Reportado de volta no mesmo dia**, ja que `nodered/flows.json`
(`vehicle_primary_trip_refresh`) continua dependendo dessa entidade.
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

Para esse vehicle_primary a flag sempre retornou `0`. Testando manualmente (chamada
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
   `sensor.vehicle_primary_fuel_driving_range`).

**Testado ao vivo, ponta a ponta:** antes do fix, script standalone
reproduzindo a chamada `/ccs2/carstatus/latest` batia num bug separado da
lib (`float(None)` em `Drivetrain.FuelSystem.DTE.Total` — bug de nivel
errado, nao da Hyundai) ate eu descobrir o drill-down correto. Depois do
fix completo + restart: config entry foi de `setup_retry` (contínuo desde
07-14) para `loaded`; `sensor.vehicle_primary_fuel_level` = 20 (antes
`unavailable`), `sensor.vehicle_primary_car_battery_level` = 62,
`sensor.vehicle_primary_fuel_driving_range` = 110.0, `sensor.vehicle_primary_last_updated_at`
= 2026-07-18T17:24:41Z (dado fresco, nao mais o cache de 07-11),
`device_tracker.vehicle_primary_location` = home. Zero erros nos logs pos-restart.
De bonus, o parser CCS2 preenche ~65 campos que o parser BR nunca setava
(pressao dos pneus, drive_mode, avisos de oleo/bateria 12V, varios campos
EV) — as `SENSOR_DESCRIPTIONS` de `tire_pressure_*`/`drive_mode`
adicionadas pelo update de upstream (ver secao anterior) agora tem chance
real de popular, quando o veiculo reportar esses dados (esse vehicle_primary
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

## Recorrencia (2026-08-02): o update de fork derrubou o fix CCS2 de novo

Mesmo padrao da secao de 2026-07-19: um update de upstream (agora bump da
lib `hyundai_kia_connect_api` 4.25.2 -> **4.25.3**) sobrescreveu o fork
local e removeu **tanto** o `_force_ccs2_status_endpoint` do `coordinator.py`
**quanto** o sensor de trip-log (`button.py`/`sensor.py`/`strings.json`/
`translations/en.json`). O backup automatico noturno `876aeaf` (2026-07-27)
capturou esse estado ja quebrado, e o `/status/latest` voltou a 503ar
continuamente (resCode 5031) — `sensor.vehicle_primary_fuel_level` ficou
`unavailable` de novo.

**Correcao:** restaurados os 5 arquivos verbatim do commit `212211a`
(backup de 2026-07-20, ultimo estado bom) via `git show 212211a:<path> |
docker cp`, **mantendo o `manifest.json` em 4.25.3** (a lib ja instalada no
container) — o parser `ApiImplType1._update_vehicle_properties_ccs2`
continua com a mesma assinatura `(self, vehicle, state)` em 4.25.3, e
`data_timezone` segue existindo em `HyundaiBlueLinkApiBR`, entao o fix bom
e compativel sem downgrade. Confirmado ao vivo apos `homeassistant.restart`:
`sensor.vehicle_primary_fuel_level` `unavailable` -> `90`, `sensor.vehicle_primary_last_updated_at`
com timestamp do proprio dia, zero 503 nos logs.

**Origem do overwrite — FINALMENTE identificada (2026-08-02).** As duas notas
anteriores diziam que a fonte era "desconhecida" / "algo fora do git tocando
os arquivos". Era o proprio auto-updater do repo: `scripts/docker-auto-update.mjs`
no modo `ha-updates` (cron a cada 30 min) lista as entidades `update.*` do HA
que "parecem seguras" e chama `update/install` em cada uma. O HACS expoe a
atualizacao do kia_uvo como `update.kia_uvo_hyundai_bluelink_update`; quando o
upstream lanca uma versao nova, essa entidade vira `on` e o watcher **instala o
release do HACS por cima do fork local**, apagando o fix CCS2 e o trip-log. Nao
era HACS "sozinho" nem edicao manual — era o nosso cron auto-instalando o update
do HACS.

**Blindagem (2026-08-02):** `updateLooksSafe` em `docker-auto-update.mjs` ganhou
uma lista `PROTECTED_UPDATE_PATTERNS` (`kia_uvo`, `hyundai`, `bluelink`, `uvo`)
que barra o auto-install dessas entidades (match por substring em
entity_id+friendly_name, resiste a mudanca de id). Testado via unit-test do
predicado: o update do kia_uvo retorna `false` (nao instala), os demais seguem
`true`. Agora o fork so muda por acao manual explicita — se um dia quiser
mesmo atualizar o kia_uvo, faca no HACS e depois **re-aplique o fix CCS2 +
trip-log** antes de considerar concluido. Se adicionar outro custom_component
forkado, adicione o padrao dele nessa mesma lista.

**Padrao a vigiar:** sempre que o vehicle_primary voltar a ficar `unavailable`, rodar
`git status homeassistant/custom_components/kia_uvo/` e
`grep -c _force_ccs2_status_endpoint coordinator.py` — se o grep der `0`, e o
mesmo overwrite (alguem atualizou o kia_uvo manualmente por fora da blindagem);
restaurar do ultimo backup bom (checar `git log` do `coordinator.py` por um
commit que ainda tenha a funcao) mantendo o `manifest.json` na versao de lib
atual do container.

## Recorrencia (2026-08-07): update para o componente v3.9.0 / lib 4.26.0 — nova politica

Caiu de novo, mas com contexto diferente e **origem NAO sendo o cron**: o log do
`docker-auto-update.mjs` mostrou "no safe integration updates pending" o tempo
todo desde 02/08 — a blindagem `PROTECTED_UPDATE_PATTERNS` **segurou**. O
overwrite (componente kia_uvo `3.8.1` -> **`3.9.0`**, lib `4.25.3` -> **`4.26.0`**)
veio pelo **proprio HACS**, um vetor diferente do cron. O `auto_update` por-repo
do HACS esta desligado (flag `None` em `hacs.repositories`), entao foi provavel
install manual pela UI ou um reset de estado do HACS durante o recreate dos
containers pelo **update do DietPi** que rodava em paralelo (o container
`homeassistant` chegou a sair com `Exit (128)` e o `docker compose up` falhou com
`unsupported protocol: Yunix` enquanto o runtime do Docker era atualizado — isso
e efeito do update do sistema, nao do kia_uvo; os containers voltaram sozinhos ao
fim da etapa).

**Mudanca de politica (a pedido):** em vez de reverter para o fork antigo, agora
**mantemos a versao atualizada** do upstream e reaplicamos **so** os nossos dois
patches por cima, cirurgicamente. Motivo: o 4.26.0 traz melhorias legitimas
(criacao de entidade de bateria 12V e pressao de pneus que nao dependem mais de
valor no setup, etc.) que vale a pena manter.

**Como foi reaplicado (workflow reutilizavel):** dois scripts de patch idempotentes
com ancoras old->new (mesma forma dos `Edit`), `docker cp` + `docker exec -u 0`:
`patch1` = fix CCS2 no `coordinator.py` (imports `types`/`ApiImplType1`, a chamada
`self._force_ccs2_status_endpoint()` apos o refresh de token, e o metodo); `patch2`
= trip-log (metodo `async_refresh_day_trip_info` no coordinator, descricao do botao
`refresh_trip_info`, classe `DayTripInfoEntity` + append no `sensor.py`, e as chaves
de traducao). Compatibilidade com 4.26.0 confirmada em container ANTES de aplicar:
`ApiImplType1._update_vehicle_properties_ccs2` mantem `(self, vehicle, state)`,
`data_timezone` segue em `HyundaiBlueLinkApiBR`, `update_day_trip_info` existe.
Verificado ao vivo apos `homeassistant.restart`: `fuel_level` 65, autonomia 299,
`last_updated` do proprio dia, **0x 503**, e o botao de trip retornou as viagens de
hoje.

**Os DOIS vetores automaticos agora estao fechados:** (1) cron `ha-updates` —
guard `PROTECTED_UPDATE_PATTERNS` (02/08); (2) HACS `auto_update` por-repo — ja
`off`. Ou seja, o kia_uvo so muda por **install manual explicito no HACS**. Se
fizer isso de proposito, **reaplique CCS2 + trip-log logo em seguida** (os scripts
de patch sao o caminho rapido) e verifique `0x 503` antes de considerar pronto.

## Dashboard, comandos e manutencao segura (atualizado em 2026-08-16)

O dashboard Lovelace `vehicle_primary-viagens` (titulo "vehicle_primary",
`homeassistant/dashboards/vehicle_primary.yaml`) usa o layout nativo responsivo
`type: sections`, sem dependencia nova. Ele separa visao geral, localizacao,
viagens, bateria 12 V, historico, comandos fisicos e diagnostico. A area
"Atualizacao dos dados" mostra o estado real do coordenador, a ultima consulta,
o deadline de retry/cooldown e o botao `Forcar atualizacao agora`.

O mapa e rotulado como **ultimo estacionamento**, pois a API Hyundai Bluelink
Brasil rejeita `/location/park` enquanto o veiculo esta em movimento. Com o
motor ligado, o painel avisa explicitamente que o ponto e o ultimo estacionamento
confirmado e exibe sua idade; ele nunca apresenta esse timestamp como uma
posicao GPS atual nem o avanca sem uma nova coordenada confirmada pelo backend.

As viagens renderizadas vem de
`sensor.garagem_vehicle_primary_recent_trip_info` e cobrem hoje e ontem. O consumo em
km/L so aparece quando o recorder possui leituras confiaveis de combustivel e
odometro antes e depois da viagem; caso contrario o card explicita que aguarda
amostras, em vez de fabricar uma media. Para o calculo, snapshots historicos
desse sensor sao mesclados por data e horario durante toda a retencao configurada
do Recorder (30 dias nesta instalacao), sem chamadas adicionais ao endpoint
rate-limited `/tripinfo`. Os atributos detalham a janela maxima pesquisada,
viagens disponiveis/consideradas,
amostras usadas, distancia, litros estimados, queda minima de 2% e gap maximo
de quatro horas. O card principal mostra o intervalo efetivamente usado.

`button.vehicle_primary_start_hazard_lights_and_horn` chama exclusivamente o endpoint
oficial Brasil `/ccs2/control/hornlight` com `command=on`. A API nao oferece
duracao configuravel; a integracao documenta cerca de 30 segundos. O
coordinator reaproveita `_action_lock`, aguarda `check_action_status` por ate
60 s, publica `sensor.garagem_vehicle_primary_remote_command_status` e registra somente
`VEHICLE_PRIMARY_REMOTE_LOCATE_REQUESTED`, `ACCEPTED` ou `FAILED`, sem IDs, tokens ou
coordenadas. Ha cooldown local de 60 s. No Lovelace, tap nao executa nada: e
necessario segurar e confirmar explicitamente.

### HACS e futuras versoes

O aviso `Installed v3.9.0 / Latest v3.10.1` tinha causa convehicle_primary: o codigo foi
sincronizado e commitado manualmente, mas o registro
`hacs.repositories[356385629]` continuou com `installed_commit=52f943d` e
`version_installed=v3.9.0`. O manifesto local ja estava em 3.10.0. Alterar so o
manifesto nao e suficiente para corrigir o HACS; a instalacao oficial deve ser
executada uma vez e o overlay local reaplicado.

`scripts/kia-uvo-safe-update.mjs` representa o delta como **base upstream
versionada + commits do proprio repositorio**. Em `check` ele baixa base e
alvo para diretorio temporario, gera o delta local, aplica com `git apply` no
alvo, compila e verifica marcadores. Conflito para antes de tocar na instalacao.
Em `apply`, que exige token e comando explicitos, cria backup do componente e
dos metadados HACS, chama o servico oficial `update.install`, reaplica o staging,
reinicia somente o Home Assistant e valida entidades/biblioteca/HACS. Qualquer
falha restaura componente e metadata e reinicia a versao anterior.

O modo `ha-updates` de `scripts/docker-auto-update.mjs` continua proibido de
instalar Kia/Hyundai cegamente. Quando a entidade protegida fica `on`, ele
registra `VEHICLE_PRIMARY_INTEGRATION_UPDATE_AVAILABLE` e chama apenas `check`. O estado
fica em `/config/.storage/kia_uvo_safe_update` e aparece como
`sensor.integracao_vehicle_primary`; `apply` permanece uma decisao explicita apos revisar
compatibilidade.

O estado do motor no recorder continua sendo telemetria amostrada, nao um log
de ignicao garantido. Para saber quando o carro rodou, o `/tripinfo` permanece
a fonte autoritativa compartilhada com o app Bluelink.
