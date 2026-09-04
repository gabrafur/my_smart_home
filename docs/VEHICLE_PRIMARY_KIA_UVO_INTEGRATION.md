# Integracao vehicle_primary (kia_uvo / Hyundai Bluelink Brasil)

## O que e

`custom_components/kia_uvo` (fork local, nao HACS puro) conecta ao Hyundai
Bluelink Brasil via `hyundai_kia_connect_api` (`HyundaiBlueLinkApiBR`) para
expor localizacao, status (motor, portas, combustivel etc.) e controles do
vehicle_primary como entidades Home Assistant. Documentado tambem em
[docs/ILUMINACAO_SEGURANCA_NODERED.md](ILUMINACAO_SEGURANCA_NODERED.md)
(uso das entidades `vehicle_primary_*` no fluxo de chegada/seguranca).

## Estado atual (2026-08-31)

- Componente sincronizado com o upstream `kia_uvo` **3.11.0** e
  `hyundai_kia_connect_api` **4.27.2**. A promocao preserva o delta local,
  valida uma leitura inicial e observa a consulta periodica seguinte ao cache
  antes de aceitar o runtime, sem forcar uma chamada adicional.
- A biblioteca 4.26.x incorporou o suporte nativo ao vehicle_primary brasileiro:
  `/ccs2/carstatus/latest`, parser CCS2, wake real por
  `/ccs2/carstatus`, rejeicao de snapshot que nao avancou e interpretacao do
  campo `Date` como UTC. Os monkey patches locais que duplicavam essas funcoes
  foram removidos.
- O app Android brasileiro 1.0.20 trocou o `ccsp-application-id` e deixou de
  usar o `deviceId` fixo da biblioteca. Em 18/08/2026 o backend invalidou esse
  identificador: todas as chamadas passaram a retornar `resCode 4002` e todas
  as entidades ficaram indisponíveis. A compatibilidade local agora replica o
  registro mínimo do app em `/spa/notifications/register`, aceita somente o
  `deviceId` emitido pelo servidor, persiste-o no token e repete uma única vez
  a chamada que recebeu 4002. Outros erros 400 não acionam registro nem retry.
- Permanecem locais somente as extensoes necessarias nesta instalacao:
  viagens de hoje e ontem, estimativa conservadora de consumo, refresh do
  tripinfo por movimento do odometro, tolerancia ao `DTE.Unit` anomalo e o
  alias historico de autonomia de combustivel. Tambem permanece uma correcao
  estreita para `Location.TimeStamp`: a API 4.26.5 ainda rotula esse relogio UTC
  como horario regional e desloca somente a entidade de localizacao em +3 h.
  O stub reservado `OffPeakTime: {Mode: 1}` dos modelos a combustao tambem e
  ignorado para nao criar horarios EV ficticios em 00:00 nem warning por poll.
- O Node-RED e o unico coordenador do agendamento de wakes reais. No backend
  brasileiro, o `kia_uvo` consulta o cache do servidor a cada 15 minutos para
  renovar token e manter as entidades publicadas, mas
  `_async_update_data` nao chama
  mais `check_and_force_update_vehicles`, nem no intervalo legado de 1440
  minutos. As opcoes antigas de force refresh permanecem aceitas apenas por
  compatibilidade de config entry. `sensor.vehicle_primary_last_scanned_at`
  registra a consulta mais recente ao cache e pode avancar mesmo sem mudar o
  snapshot semantico; `sensor.vehicle_primary_last_updated_at` continua sendo
  a evidencia de dado novo produzido pelo carro.
- A confirmacao de um wake periodico depende do avanco desse timestamp
  semantico, mesmo quando motor e trava continuam com o mesmo estado e por isso
  nao ganham um novo `last_updated` no Home Assistant. O mesmo critério vale
  quando a iluminação solicita recovery: a resposta do wake e o readiness do
  motor são resultados distintos, publicados em campos separados. A correlação causal termina 20 minutos
  depois da solicitação: dados que chegam mais tarde continuam válidos para
  estacionamento e telemetria, mas não transformam o wake antigo em sucesso.
- `sensor.vehicle_primary_current_location_since` preserva o instante em que o
  carro entrou na localizacao atual. Republicacoes do mesmo ponto nao alteram
  esse horario; fora de zonas nomeadas, um deslocamento de aproximadamente
  250 m abre uma nova permanencia.
- O Node-RED usa **15 minutos** quando algum morador esta `not_home` ou
  `chegando` e **30 minutos** no ciclo saudável quando ambos estao `home`.
  Recuperação e backoff usam o piso de 15 minutos, inclusive em casa, enquanto
  a janela de wake está ativa, para não prolongar uma indisponibilidade
  confirmada. Com os dois em casa, wakes automaticos ficam suspensos entre
  00:00 e 05:59. O
  coordinator Python mantém um lock de processo; requests concorrentes sao
  coalescidos. Agendamento, manual, recovery, chegada e movimento convergem no
  mesmo estado persistente e passam por um guard final antes do binding
  publico. O clique manual `Atualizar agora` ignora o cooldown e a janela
  noturna; ele nunca atravessa uma chamada em andamento. Depois de qualquer
  wake, o prazo automatico seguinte e ancorado no aceite da chamada pelo Home
  Assistant e usa a politica de presença corrente.
- O backend BR pode publicar o snapshot mais de dois minutos depois de aceitar
  o wake. Se o aguardo fixo de 25 segundos da biblioteca expirar, o coordinator
  agenda seis releituras limitadas de `/latest` ao longo dos 150 segundos
  seguintes. Essas releituras e o polling contínuo de 15 minutos consultam
  somente o cache, nao emitem outro wake
  e param assim que o timestamp semantico do veiculo comprova dado posterior
  a solicitacao.
- O cliente também valida o envelope funcional do endpoint de wake. HTTP 200
  sozinho não é aceite: somente `retCode=S` e `resCode=0000` produzem
  `CRETA_WAKE_ACCEPTED`. Rejeições funcionais agora falham imediatamente com o
  endpoint `/ccs2/carstatus` identificado, em vez de parecerem um veículo que
  simplesmente não respondeu depois de 25 segundos.
- Ao vencer o prazo de uma tentativa que ainda aguarda evidência, o Node-RED
  chama primeiro `kia_uvo.update`, que relê somente o cache, aguarda 15 s pela
  republicação e executa outro snapshot. Telemetria semântica nova confirma o
  wake anterior e cancela o wake redundante; cache antigo libera exatamente
  uma nova tentativa. Essa sondagem não altera `last_request_at`, não aumenta
  `attempts` e também passa pelo terminal dry-run nos testes.
- Se o backend responder `RateLimitingError`, o coordinator interrompe polling,
  wakes e releituras tardias com backoff progressivo de 15 min, 30 min, 1 h,
  2 h, 4 h e 6 h. O estado e compartilhado entre as instancias recriadas pelo
  retry de setup do Home Assistant, portanto um novo coordinator nao contorna
  o prazo. Uma leitura posterior bem-sucedida zera o contador. O erro nao
  dispara uma segunda leitura de fallback nem produz traceback por minuto.
- HTTP 403 do backend brasileiro segue a mesma contenção, inclusive em wake,
  releitura de cache e histórico de viagens. O cliente BR de upstream engole
  falhas de `/tripinfo`; a camada local as torna observáveis antes de publicar
  novamente o coordinator. Assim, uma recusa do provedor não pode ser tratada
  como sucesso nem formar um ciclo de chamadas a partir das entidades
  republicadas. Se o corpo 403 identificar especificamente `resCode=4002`, o
  registro controlado de `deviceId` ocorre uma vez e a chamada original é
  repetida antes de aplicar backoff.
- A API 4.27.2 moveu a troca de refresh token para uma implementacao generica
  que espera atributos ausentes no cliente BR e prefixa `Bearer` onde o backend
  brasileiro espera o token cru. A compatibilidade local fornece os endpoints
  BR, preserva o token no formato correto e, se o refresh receber `5091`,
  propaga o rate limit sem cair imediatamente em um login completo. Isso evita
  varias chamadas de autenticacao dentro de uma unica tentativa do coordinator.
- O historico de viagens e carregado uma vez ao iniciar a integracao, quando o
  odometro avanca e na chegada do vehicle_primary. O dashboard nao depende mais de press
  manual para voltar a exibir viagens depois de restart.
- Bateria 12 V `unknown` pode ser um estado correto: quando
  `SensorReliability=1`, o valor bruto e deliberadamente descartado pela
  biblioteca e o painel informa que aguarda uma leitura confiavel.

### Fluxo de dados e contratos

```text
Bluelink BR -> hyundai_kia_connect_api 4.27.2 -> coordinator kia_uvo
             -> entidades Home Assistant -> contexto_vehicle_primary (Node-RED)
             -> security.vehicle_primary-context.v1 -> chegada/iluminacao
```

`contexto_vehicle_primary` reage a mudanca de zona e a deslocamento GPS acumulado de no
minimo 250 m, descontando a precisao reportada. A coordenada fica somente no
contexto persistente e nunca vai para logs. Movimento solicita atualizacao dos
dados, mas **nao** autoriza sozinho qualquer acao fisica: iluminacao continua
exigindo motor/contexto frescos.

Antes das leituras autenticadas, o cliente usa o identificador de aplicação do
app brasileiro atual. Se o backend responder especificamente `4002`, um lock
serializa o registro de dispositivo para impedir duplicação por chamadas
concorrentes. O retry reaplica o novo identificador tanto nos headers quanto no
payload de comandos e o token atualizado é salvo pelo loop do Home Assistant.
Esse recovery não acorda o carro e não amplia a frequência normal de polling.

O refresh grava como baseline o estado de
`sensor.vehicle_primary_last_updated_at`, que e o relogio semantico retornado
pelo proprio Bluelink. O
retorno de `public_bindings.call` significa apenas que o Home Assistant aceitou
a chamada e limpa somente o marcador `request_in_flight`. Uma tentativa só
vira sucesso quando esse relógio avança e é posterior ao wake avaliado. O
readiness derivado do motor é registrado separadamente e não converte uma
resposta semântica válida do wake em erro.
Mudancas em `last_updated` das entidades do Home Assistant nao contam: elas
tambem ocorrem em reload e republicacao do mesmo cache. Sem evidencia, o mesmo recovery permanece em backoff e
as retentativas automaticas de recuperação respeitam 15 minutos fora da pausa
noturna; o ciclo saudável continua em 30 minutos com ambos em casa. Com ambos
em casa, qualquer wake automático fica suspenso das 00:00 as 05:59. Antes de
repetir o wake, o vencimento relê o
cache e aguarda sua propagação para aproveitar uma resposta tardia do wake
anterior, desde que essa resposta ainda esteja dentro da janela causal máxima
de 20 minutos. Uma atualização passiva muitas horas depois pode alterar o
estacionamento confirmado, mas não confirma o wake anterior. O contador satura
sem criar rajadas ou loops. Somente o clique
manual explicito pode antecipar prazo ou janela. O aceite estende
`next_allowed_at` pelo intervalo selecionado depois da conclusao da chamada.
Uma evidencia nova posterior pode confirmar sucesso, mas nunca encurta esse
deadline para o instante do despacho.
Chegadas do veículo usam `location_observed_at`, e não o `last_updated` da
entidade republicada, como identidade temporal. Durante dez minutos, a mesma
etapa de chegada pode produzir no máximo um wake e uma atualização de viagens;
uma transição real de `approach` para `home` continua sendo um novo estágio.
`request_in_flight`, seu lease e `next_allowed_at` sobrevivem a restart. Erros
inesperados sao classificados pelo catch do Node-RED, liberam o lock logico e
mantem o deadline. O resultado BR esperado em que o wake foi aceito mas o
veiculo nao publicou telemetria fresca, assim como uma indisponibilidade
transitoria de autenticacao, preserva o cache e retorna sem criar erro
WebSocket; a ausencia de timestamp semantico novo mantem o mesmo backoff e gera um
alerta deduplicado para `resident_primary`. O polling BR reavalia autenticacao
em ate 60 segundos sem descarregar o config entry, permitindo recuperacao
posterior sem tempestade. Os rechecks posteriores ao wake renovam a
autenticacao antes de cada leitura de cache e param diante de falha de
autenticacao. Ao recarregar a entrada da integracao, os rechecks de wake e de
historico ainda pendentes sao cancelados para que a instancia antiga nao
continue fazendo consultas.
Eventos operacionais usam `VEHICLE_PRIMARY_LOCATION_CHANGED`,
`VEHICLE_PRIMARY_MOVEMENT_DETECTED`, `VEHICLE_PRIMARY_REFRESH_REQUESTED`,
`VEHICLE_PRIMARY_REFRESH_RETRY`, `VEHICLE_PRIMARY_NEW_DATA_RECEIVED`, `VEHICLE_PRIMARY_TRIP_UPDATED` e
`VEHICLE_PRIMARY_API_ERROR`, sempre sem coordenadas ou credenciais.

O mesmo estado persistente `security_vehicle_primary_refresh_v1` agora alimenta
`contexto_vehicle_primary.refresh` e o sensor MQTT
`sensor.vehicle_primary_refresh_coordinator`. Os campos publicados sao `state`,
`reason`, `attempt`, `last_request_at`, `last_success_at`, `next_retry_at` e
`cooldown_until`, alem de `request_in_flight`, `in_flight_until`,
`service_accepted_at`, `last_success_reason`, `lighting_ready_after_wake`,
`last_evidence_domains`, `last_failure_class`, `engine_communication_failed`, `failure_endpoint` e
`failure_stage`. O ticker MQTT de 5 s somente calcula o tempo restante a
partir desses deadlines; ele nao agenda refresh nem mantem um timer paralelo.
Quando uma chamada real informa que o serviço `kia_uvo.update` não existe
porque o config entry não conseguiu carregar, a falha é publicada como
`integration_unavailable`. Readiness incompleto ou entidades stale não são
tratados como prova de indisponibilidade da integração. Nesse
estado, o dashboard prioriza a indisponibilidade sobre uma confirmação antiga
de wake e apresenta o tempo restante para a próxima tentativa automática. Um
wake com telemetria semântica nova é mostrado como confirmado mesmo quando o
estado do motor não muda. A idade do evento específico do motor é informativa
e não invalida `ON`/`OFF`; somente uma falha real de comunicação/revalidação
marca o motor como não confiável e oferece
`switch.garagem_vehicle_primary_bypass_do_motor_para_iluminacao_de_chegada`.
Essa chave só afeta a
iluminação de chegada durante essa falha e nunca ignora um `OFF` conhecido. O prazo publicado pelo provedor é também
sincronizado com o coordenador persistente do Node-RED, inclusive no startup,
para impedir novas chamadas automáticas antes do deadline. Durante esse estado,
o bypass do motor é ligado automaticamente. A recuperação só o desliga quando
o próprio fluxo havia feito a ativação; um `ON` manual preexistente ou posterior
é preservado. Na
primeira detecção de cada incidente, o coordenador envia um push deduplicado a
`resident_primary` e cria uma notificação persistente no Home Assistant. A
mensagem identifica o endpoint e a etapa do fluxo que falhou. Uma mudança real
da classe ou do endpoint da falha produz um novo aviso; repetições idênticas são
deduplicadas. Depois de sucesso semântico, os detalhes antigos são limpos e a
notificação persistente correspondente é removida. As tentativas
seguintes respeitam o backoff de 15 minutos; quando o serviço volta, a próxima
releitura de cache segue o ciclo normal.
O backoff brasileiro também publica o evento `kia_uvo_api_retry` com o deadline
UTC calculado pela própria integração. O sensor de timestamp
`sensor.vehicle_primary_api_retry_at` restaura esse prazo mesmo quando o config
entry não conclui o carregamento; o Node-RED também consome esse estado inicial
e não tenta reler o serviço ausente durante o backoff. Por isso o card mostra o tempo do retry da API,
e não o timer independente do Node-RED. Um acesso confirmado limpa o deadline e
o card volta às mensagens normais do ciclo de atualização.
O nível consecutivo e o deadline também ficam no `Store` privado do Home
Assistant. Um restart recompõe o relógio monotônico a partir do deadline UTC,
sem voltar artificialmente ao primeiro intervalo. O card usa diretamente o
status `rate_limited` desse sensor e descreve o prazo como liberação para uma
nova tentativa; o agendador do config entry ainda pode efetuar a chamada alguns
minutos depois. A persistência começa no primeiro rate limit registrado por
esta versão; ciclos anteriores, que existiam apenas na memória, não podem ser
reconstruídos com segurança.
`input_button.vehicle_primary_force_refresh_now` entra no ciclo normal de snapshot com
`reason=manual_force`: ignora `next_allowed_at`, inclusive durante cooldown ou
backoff, e envia um novo wake. Ele nao quebra uma tentativa em voo; nesse unico
caso bloqueado, o Home Assistant cria imediatamente uma notificacao persistente
informando que nenhuma nova consulta foi enviada. O aceite do wake manual
reinicia a agenda automatica em 15 ou 30 minutos conforme a presença corrente.

O carregamento inicial da integração não espera por `/tripinfo`. Esse endpoint
é opcional e pode responder muito lentamente no backend brasileiro; bloquear
nele impediria a criação das entidades de status e faria o painel continuar
mostrando estado restaurado antigo. No startup o odômetro-base é registrado e a
carga de hoje/ontem é iniciada em segundo plano, com timeout de 120 segundos,
uma nova tentativa após 60 segundos e deduplicação por veículo. Movimento do
odômetro agenda outra carga, e existe uma reconciliação de segurança a cada seis
horas mesmo que nenhum movimento tenha sido observado pelo Home Assistant. O
botão específico de viagens continua disponível para atualização explícita.

O binding `button.vehicle_primary_force_refresh` existe somente como destino
interno da ação e usa `expose_state: false`; por isso não aparece como um
segundo controle ao lado de `input_button.vehicle_primary_force_refresh_now`.
O alias `button.garagem_vehicle_primary_refresh_trip_info` continua sendo um
estado sintético para leitura. Esses IDs não recebem `button.press` diretamente.
O Node-RED chama as ações allowlisted
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

A chegada nao chama mais `vehicle_primary.force_refresh` diretamente. O ramo
usa `link out`/`link in` para retornar ao mesmo coordenador, e o despacho final
separa producao e `test_mode`. No teste manual, force refresh e tripinfo chegam
ao terminal dry-run com `simulated: true`, `dispatched: false` e
`external_call_sent: false`, sem alcancar o binding ou a API Bluelink.

As secoes datadas abaixo preservam o historico da investigacao. Onde falarem
em `_force_ccs2_status_endpoint()` ou `_install_br_wake_force_refresh()`, leia
como solucao anterior, substituida pelo suporte upstream descrito acima.

## Por que o historico de `binary_sensor.vehicle_primary_engine` nao bate com o app Bluelink

**2026-07-10:** usuario reportou que o historico do motor nao refletia o uso
real do carro, enquanto o app Bluelink mostrava certo. Investigacao:

- O sensor `binary_sensor.vehicle_primary_engine` e alimentado pelo campo `engine` do
  endpoint de status (`/status/latest` ou `/ccs2/carstatus/latest`), lido a
  cada poll do coordinator.
- Historicamente, com `options: {}` no config entry, o
  coordinator so faz uma leitura *ao vivo* forcada automaticamente **uma vez
  por dia** (`DEFAULT_FORCE_REFRESH_INTERVAL = 1440` min); todo o resto do
  tempo le o cache do servidor da Hyundai (`update_all_vehicles_with_cached_state`).
  As leituras ao vivo "extras" vêm do `button.vehicle_primary_force_refresh`
  (`nodered/flows.json`, flow `contexto_vehicle_primary`, node
  `vehicle_primary_force_refresh`). A política conjunta em `contexto_chegadas` pede o
  refresh periódico a cada 15 min quando alguém está fora ou chegando e a cada
  30 min quando ambos estão em casa, com pausa entre 00h e 06h nesse último
  caso — ver "Refresh" em
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
- **Agenda automatica orientada a presença no Node-RED.** Acordar o carro puxa
  a bateria de 12 V e conta contra o rate limit: o intervalo e de 15 min com
  alguem fora/chegando, 30 min com ambos em casa e fica suspenso de 00:00 a
  05:59 se os dois continuarem em casa. O botao `Atualizar agora` e
  deliberadamente uma excecao: ele faz wake mesmo dentro do cooldown ou da
  pausa noturna, mas o lock do coordinator ainda rejeita concorrencia. Cada
  aceite manual reinicia o prazo conforme a presença corrente.
- O `sleep(25)` e o valor medido pelo upstream EU. Um refinamento possivel e
  trocar por `check_action_status(vehicle_id, msgId, ...)`, que ja e usado
  neste coordinator para comandos remotos e esperaria o tempo exato em vez de
  um valor fixo. Nao foi feito: o valor fixo funcionou e espelha o upstream.
- Nem todo wake produz dado novo. A tentativa das 16:23:24 foi aceita mas o
  `last_updated_at` nao avancou; a das 16:24:38 avancou. Vale lembrar que a
  API BR so aceita `/location/park` com o carro parado (400 em movimento), o
  que sugere que o backend continua limitado durante a viagem.
- A confirmacao causal admite ate 20 minutos desde o inicio continuo da espera.
  Esse prazo nao e reiniciado nem antecipado por uma nova tentativa, e duas
  transicoes de moradores em sequencia nao podem transformar o contador de
  tentativas em um falso alerta de 20 minutos.

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
mas nunca substituem as entidades atuais: a idade de motor/trava é registrada
após 5 minutos e a localização expira em 30 minutos. O estado conhecido do
motor não expira apenas pelo tempo: `off` encerra o lifecycle e `on` o mantém;
a idade ainda pode solicitar wake. Localização fresca fora de casa só revalida
o estado persistido quando o motor está desconhecido.
Sem evidência suficiente o contrato publica `in_use: null`/pending.

O parser do recovery rejeita tipos inesperados (por exemplo,
`in_use: "false"`), versões antigas, confirmação futura acima de 60 s e
confirmação sem timestamp. A confirmação expira após 24 h sem revalidação; a
limpeza publica contexto pending e não dispara ações físicas.

O refresh Bluelink persiste `attempts`, `next_allowed_at` e
`last_success_at`. Falhas mantêm backoff automático de 15 minutos em qualquer
estado de presença fora da pausa noturna; o ciclo saudável usa 30 minutos com
ambos em casa. Nessa condição, todo wake automático pausa entre 00:00 e 05:59.
Sucesso limpa tentativas e volta ao
cooldown normal. O clique manual pode
antecipar ambos, sem atravessar uma chamada em andamento. O TTL de 5 minutos de motor/trava continua
bloqueando efeitos físicos, mas não quebra esse piso nem cria chamadas de cache
que seriam contabilizadas como novas falhas. Isso evita storm após restart e
não registra viagem falsa durante indisponibilidade. O cooldown começa no
aceite da chamada, incluindo no intervalo o tempo que o serviço levou para
retornar; a confirmação posterior de telemetria preserva esse prazo.

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
km/L usa a mediana da eficiencia implicita nas leituras pareadas de autonomia e
nivel de combustivel do proprio veiculo. Apenas pares do mesmo refresh (gap
maximo de cinco minutos) e com tanque entre 20% e 80% entram no calculo; os
extremos sao descartados porque a boia inteira e nao linear fica especialmente
imprecisa perto do cheio e da reserva. Sao exigidas pelo menos cinco amostras e
uma faixa observada de 10 pontos percentuais. Isso evita atribuir a uma viagem
curta uma queda de combustivel ocorrida horas depois, causa que produzia medias
artificialmente baixas. A estimativa global e referencia da janela, nunca uma
medicao direta de viagem individual. Como o endpoint `/tripinfo` nao
fornece combustivel consumido por trajeto, o consumo individual e modelado:
o total de combustivel implicito na media da janela e distribuido entre as
viagens atualmente exibidas segundo distancia e proporcao de marcha lenta. A
normalizacao preserva a media agregada da janela nesse conjunto, enquanto
viagens com maior fracao em marcha lenta recebem km/L menor. Cada linha
identifica o valor e os litros como modelados. O card explicita dados
insuficientes quando os criterios da estimativa global ou os tempos da viagem
nao sao satisfeitos.

Snapshots historicos do sensor de viagens continuam mesclados por data e
horario durante toda a retencao configurada do Recorder (30 dias nesta
instalacao), sem chamadas adicionais ao endpoint rate-limited `/tripinfo`.

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
reinicia somente o Home Assistant, valida entidades/biblioteca/HACS e faz uma
segunda observacao por ate 18 minutos, aguardando o polling natural de 15
minutos. A promocao so e aceita quando `last_scanned_at` avanca e o combustivel
continua disponivel, sem injetar uma segunda chamada ao provedor. Qualquer
falha restaura componente e metadata e reinicia a versao anterior.

O tab Node-RED `atualizacoes_diarias` agenda a analise Kia/Hyundai a cada 30
minutos e ao subir. A ponte coalescente solicita ao host somente
o watcher `scripts/docker-auto-update.mjs ha-updates`; o container Node-RED nao
recebe token, checkout nem Docker socket. Para Kia/Hyundai, o watcher executa
somente `scripts/kia-uvo-safe-update.mjs check` e resolve o alvo pelo `latest_version` da
entidade oficial `update.*`, sem depender do metadata HACS possivelmente stale.
O antigo cron direto `ha-updates` e removido pelo
instalador da ponte. O estado fica em
`/config/.storage/kia_uvo_safe_update` e aparece como
`sensor.integracao_vehicle_primary`; `apply` permanece uma decisao explicita
apos revisar compatibilidade e nunca e chamado pelo fluxo.

O estado do motor no recorder continua sendo telemetria amostrada, nao um log
de ignicao garantido. Para saber quando o carro rodou, o `/tripinfo` permanece
a fonte autoritativa compartilhada com o app Bluelink.
