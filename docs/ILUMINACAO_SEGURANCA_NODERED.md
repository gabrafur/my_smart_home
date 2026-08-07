# Iluminacao de seguranca (Node-RED)

Flow `iluminacao_seguranca` (`nodered/flows.json`, tab `2fd40fd570e6f37a`).

## Objetivo

Ligar o `switch.refletor_portao_carros` **antes** de Gabriel, Valeria ou o
Creta chegarem em casa durante a noite, dando visibilidade contra possiveis
invasores proximos ao portao/garagem.

Requisito do usuario: o refletor precisa estar aceso **pelo menos 2 minutos
antes da chegada**. E por isso que o gatilho principal e a travessia do anel
`zone.chegando` (1500 m), e nao a chegada em si — ver "Zona de aproximacao".

**O refletor so acende em chegada REAL de carro** (2026-08-07). Sao duas
condicoes, ambas obrigatorias:

1. **Creta em uso** (trava `creta_in_use`) — gate duro, sem excecao; e
2. **evidencia de aproximacao** por qualquer uma das tres fontes, isolada ou
   combinada: localizacao do Creta, do Gabriel ou da Valeria.

Proximidade de pessoa sozinha **nao** acende. Ver "Gate do Creta" e
"Desligamento".

## Zona de aproximacao (`zone.chegando`)

Definida em `homeassistant/packages/zonas_presenca.yaml` (YAML, versionada no
repo — zonas criadas pela UI ficariam so no `.storage`, fora do git).

**O insight que destravou isto:** o app Companion registra cada zona
nao-passiva do HA como um *geofence de region monitoring* do iOS. Ate
2026-08-07 a unica zona existente era a `zone.home` (raio 100 m), ou seja, o
iOS tinha sido instruido a avisar sobre **um unico limite** — e nao reportava
nada no caminho, por projeto, porque e assim que ele poupa bateria.

Isso explica a medicao que parecia "GPS ruim": **0 leituras na faixa de
100–300 m em 2 dias**, nos tres trackers. Nao era limitacao de GPS, era
ausencia de zona. Nenhuma quantidade de ajuste de limiar no fluxo resolveria,
porque o dado nunca chegava.

Com o anel de 1500 m, o proprio iOS avisa da travessia na hora, em nivel de
sistema operacional, mesmo com o app suspenso ou encerrado — sem polling e
sem custo de bateria. O raio esta dimensionado no cabecalho do YAML; o fluxo
**nao** tem o raio hardcoded, so reage ao estado `chegando`.

> **Depois de criar/alterar a zona, abra o app do HA uma vez em cada iPhone.**
> O Companion so registra o geofence novo quando sincroniza; ate la o iPhone
> continua vigiando apenas as zonas que ja conhecia.

Efeito colateral esperado: dentro do anel, `device_tracker.*` e `person.*`
reportam o estado `chegando` no lugar de `not_home`.

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

## Coordenadas de referencia

`HOME_LAT`/`HOME_LON` (casa) e `GATE_LAT`/`GATE_LON` (portao/entrada) **nao
ficam no repositorio** — este repo e publico e o ponto de casa e o endereco da
familia. Eles vem do `.env`, entregue ao container pelo `env_file` do servico
`nodered` no `docker-compose.yml`, e sao lidos com `env.get(...)` em
`sec_prepare_arrival_context` e `sec_refresh_anyone_away`. A zona
`zone.chegando` usa `!secret home_latitude`/`home_longitude`.

Sem essas variaveis o fluxo **degrada de proposito** para o estado de zona do
Home Assistant (`home`/`chegando`/`not_home`), que ja e o fallback de quando o
GPS nao e confiavel; ele nunca calcula distancia a partir de coordenada
invalida (guardas `HOME_KNOWN`/`GATE_KNOWN`).

> `docker restart nodered` **nao** recarrega o `env_file`. Depois de mexer no
> `.env`, use `docker compose up -d nodered` para recriar o container, senao o
> fluxo roda degradado sem avisar.

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
3. **Gatilho principal — pre-acendimento pela travessia do anel.** Os nos
   `server-state-changed` de localizacao expoem, via `$entity()` /
   `$prevEntity()`, os campos `trigger_entity`, `trigger_state` e
   `trigger_prev_state` (transicao de zona da entidade que disparou).
   `sec_detect_arriving_source` trata como chegada toda **entrada no anel
   vindo de fora**: `trigger_state == "chegando"` e o estado anterior nao e
   `chegando` nem `home`. E dai que saem os ~2–3 min de antecedencia. O
   estagio fica em `payload.arrival_stage` (`approach`).

   > **Sair de casa tambem cruza o anel** (`home -> chegando`), a ~100 m — ou
   > seja, dentro do raio de 300 m do `isHome()` do ponto 4. Por isso
   > `sec_detect_arriving_source` descarta **qualquer** evento cujo estado
   > anterior seja `home`. Sem esse corte o refletor acenderia toda vez que
   > alguem SAI no escuro (bug latente que existia antes do anel, so que
   > mascarado porque nada disparava).
   >
   > **O pre-acendimento nao consome o `armed`.** Se a pessoa parar dentro do
   > anel (mercado a 1 km) e o backstop apagar o refletor antes dela chegar,
   > nao havera nova travessia da borda — quem precisa reacender e a entrada
   > na `zone.home` (ponto 4), e para isso ela tem que continuar armada. Quem
   > desarma no fim e o `sec_update_arming_context`, quando ela chega a
   > <=100 m de casa.
   >
   > **Corroboracao entre trackers (`any_tracker_home`).** Se QUALQUER um dos
   > dois trackers da pessoa diz "em casa", a entrada no anel e ignorada — nao
   > ha como se aproximar de onde ja se esta. Isso barra tracker **congelado**:
   > ver "Historico relevante", 2026-08-07, o caso real da Valeria.

4. **Rede de seguranca — chegada ja em casa.** A chegada tambem e detectada
   (node `sec_detect_arriving_source`, `arrival_stage = "home"`) quando uma
   entidade armada volta para ate **300 m** de `HOME_LAT`/`HOME_LON`
   **ou** para ate **300 m** de `GATE_LAT`/`GATE_LON`
   (`ARRIVAL_DISTANCE_M`, mesmo valor para os dois pontos). O ponto do
   portao/entrada (`GATE_LAT`/`GATE_LON`, vindos do ambiente do container — ver abaixo; ~168 m
   de `HOME_LAT`/`HOME_LON`) existe para acender o refletor um pouco antes
   da chegada de fato em casa. O campo `creta_home` (mesmos 300 m, so contra
   `HOME_LAT`/`HOME_LON`) continua sendo calculado em
   `sec_prepare_arrival_context`, mas **desde 2026-08-07 nao decide mais o
   desligamento** — quem decide e `sec_evaluate_turn_off`, e "chegada
   confirmada" la e a transicao para a `zone.home` (100 m), nao os 300 m. Ver
   "Desligamento". **Ja a limpeza do armamento por contexto (`sec_update_arming_context`)
   usa o mesmo limiar de 100 m do armar, nao 300 m**: com 300 m havia
   sobreposicao (100–300 m armava e limpava no mesmo passo → liquido
   desarmado), e um `context_update` com a pessoa se aproximando nessa faixa
   apagava o armado antes da deteccao de chegada disparar. Com 100 m, armar
   (>100 m) e limpar (<=100 m) sao complementares e quem se aproxima na faixa
   100–300 m continua armado ate a chegada disparar.
5. **GATE OBRIGATORIO — Creta em uso** (node `sec_check_engine_on`, renomeado
   "Creta em uso? (gate obrigatorio)"). Nenhuma chegada acende o refletor sem
   ele. Proximidade de pessoa sozinha **nao** acende — ver "Gate do Creta".
   O ramo separado por tipo de chegada (`sec_route_arrival_source`) foi
   removido: pessoa e Creta passam pelo mesmo gate.
6. **Nao liga para quem ja esta em casa ha um tempao (carencia de 10 min).**
   `sec_prepare_arrival_context` calcula, para cada entidade, `primary_home`
   (dentro de `ARM_DISTANCE_M` = 100 m do ponto `HOME`, usando **apenas** o
   tracker em tempo real — `mobile_app` das pessoas, o unico tracker do Creta)
   e `primary_home_for_ms` (ha quanto tempo esse tracker esta no estado atual,
   via `last_changed`). Em `sec_detect_arriving_source`, a chegada so e
   descartada se `primary_home` for `true` **e** `primary_home_for_ms` for
   maior que `PRIMARY_HOME_GRACE_MS` (10 min). Isso ainda cobre o caso alvo —
   o tracker secundario (iCloud) so agora "alcancando" o estado real de quem
   ja esta em casa ha minutos, que o merge por distancia mantinha "fora" ate o
   iCloud atualizar — porque o iCloud so faz poll a cada ~30 min, bem alem da
   carencia. Se `last_changed` nao vier, o tratamento e **fail-open** (acende):
   o modo de falha caro aqui e a luz nao acender na chegada.

   > **Nao troque isso por um corte absoluto por posicao.** Entre 2026-08-02 e
   > 2026-08-07 este guard foi `primary_home === true -> return null`, sem
   > carencia, e isso matou **100%** das chegadas (ver "Historico relevante",
   > 2026-08-07): os trackers nunca reportam na faixa de 100–300 m, entao a
   > unica leitura que existe dentro do raio de chegada ja vem com
   > `primary_home` true — era exatamente o evento que acendia o refletor.

   Trade-off remanescente: se o `mobile_app` estiver **travado** reportando
   "em casa" ha mais de 10 min enquanto a pessoa esta realmente fora (falha
   rara de suspensao do iOS), a chegada real dela ainda nao acende o refletor.
7. So liga se estiver escuro (`sun.sun` = `below_horizon`) e se o refletor
   ainda nao estiver ativo por chegada (evita re-disparo).
8. **Desligamento**: cinco condicoes independentes, qualquer uma basta — ver
   "Desligamento" abaixo.

## Gate do Creta (`creta_in_use`)

O refletor so acende com o Creta em uso. O gate **nao** le
`binary_sensor.creta_engine` ao vivo, e sim uma trava mantida em
`sec_prepare_arrival_context`:

- **liga** a trava quando o motor e visto `on`;
- **solta** quando o motor esta `off` **e** (porta destravada **ou** Creta a
  <=100 m de casa).

A ordem importa: na saida o carro esta em casa mas com o motor ligado, e a
trava tem que permanecer.

> **Por que uma trava e nao a leitura ao vivo.** `binary_sensor.creta_engine`
> so ganha dado novo quando algum refresh acorda o carro
> (docs/CRETA_KIA_UVO_INTEGRATION.md): em 5 dias registrou **zero** transicoes,
> incluindo uma viagem comprovada. Exigir `engine == "on"` no instante exato da
> travessia do anel deixaria o refletor sem acender quase sempre — o dado
> tipicamente ainda diz "off" durante a viagem. Com a trava, o estado
> sobrevive aos buracos de polling: liga na partida e persiste ate haver
> evidencia real de fim de uso.

Na travessia do anel o fluxo ainda pede um refresh real ao carro
(`sec_approach_wake_gate` -> `sec_force_refresh_creta`, reaproveitando o node
que ja existia), para o gate decidir com o dado mais fresco possivel. E um
evento raro — algumas vezes por dia — e o cooldown de 15 min do coordinator
protege contra excesso.

## Desligamento

Cinco condicoes **independentes**, avaliadas em `sec_evaluate_turn_off`;
qualquer uma sozinha apaga o refletor:

| # | Condicao | Quando |
| --- | --- | --- |
| 1 | Creta desligado **e** destravado | imediato |
| 2 | chegada do Gabriel confirmada | apos carencia |
| 3 | chegada da Valeria confirmada | apos carencia |
| 4 | chegada do Creta confirmada | apos carencia |
| 5 | 15 min ligado | backstop (`sec_auto_off_delay`) |

**Carencia de 90 s** (`sec_arrival_off_grace`, delay em modo `delayv` lendo
`msg.delay`): as chegadas so apagam 90 s depois que o refletor acendeu. Sem
isso a luz morreria justo no trajeto carro->porta, que e o proposito dela — a
chegada e detectada **antes** de estacionar, desligar e destravar, entao a
condicao 2/3/4 preemptaria sempre a condicao 1.

> **"Chegada confirmada" e a TRANSICAO para a `zone.home`**
> (`trigger_state == "home"` e anterior diferente de `home`), nao o estado
> "esta em casa". Usar o estado quebraria na hora: o tracker do app da Valeria
> passou 2 dias congelado enquanto o iCloud dela marcava casa, o que deixaria
> a condicao permanentemente verdadeira e apagaria o refletor 90 s depois de
> cada acendimento.
>
> **Por que destravar e nao travar:** o Kia trava as portas sozinho ao andar,
> entao o carro fica `locked` justamente *durante* a aproximacao. Usar
> `locked` como gatilho de desligar (comportamento antigo) apagava a luz no
> meio da chegada. O sinal real de "cheguei e estou saindo do carro" e o motor
> desligado **com** a porta destravada.

**Anti-religamento:** `sec_turn_off_if_active` grava
`refletor_suppressed_until = agora + 5 min`, e o gate do Creta recusa acender
dentro dessa janela. Sem isso o proximo evento de localizacao logo apos o
desligamento reacenderia o refletor.

## Aviso "Valeria chegando" (`sec_notify_valeria_approaching`)

Push para o iPhone do Gabriel quando a Valeria entra no anel — mesmo sinal do
pre-acendimento, disparado por `sec_update_arming_location` out1.

Antes **nunca disparava**: exigia `valeria.distance_m` entre 50 e 700 m, faixa
que nao existe no dado (mesma causa raiz do refletor — so havia a `zone.home`),
e exigia ainda o Creta a <=1000 m pela nuvem da Kia, que fica dias sem
atualizar. Eram duas maneiras independentes de nunca disparar.

Hoje o Creta e **metadado, nao condicao**: muda so o texto ("Valéria está
chegando de carro." quando ha evidencia positiva de que o Creta estava fora e
chegou junto; "Valéria está chegando." caso contrario). O dado da Kia faltando
nao engole mais o aviso. O `data` do node e JSONata lendo `payload.message`.

Dedup: um aviso por retorno. Rearma quando ela sai do anel (`not_home`) ou,
como reserva, quando aparece a mais de 1000 m.

## Atualizacao de localizacao (refresh)

Node `sec_refresh_every_10min` (inject, apesar do nome roda a cada **30 s**)
dispara `sec_refresh_anyone_away` a cada ciclo. Como o tick base agora e' de
30 s, cada canal tem sua cadencia controlada **por tempo** (timestamps no
flow context), nao pelo periodo do inject:

- Enquanto alguem estiver fora, pede `request_location_update` para os
  iPhones a cada **1 min** por padrao, acelerando para **30 s** quando a
  pessoa mais proxima que ainda esta fora chega a <= 2000 m de casa
  (`IPHONE_NEARBY_DISTANCE_M`). E' barato e sem rate limit conhecido; o
  timestamp (`sec_iphone_last_refresh_ts`) e' marcado de forma otimista (se o
  HA estiver fora, perde-se no maximo um ciclo).
- O refresh forcado do Creta (`button.creta_force_refresh` +
  `homeassistant.update_entity`) roda **a cada 5 min** por padrao, mas passa
  a rodar **a cada 1 min** quando o proprio Creta esta a menos de 1500 m de
  casa (`KIA_NEARBY_DISTANCE_M`). Esse **piso de 1 min e' por tempo**, entao
  continua valendo mesmo com o tick a cada 30 s — de proposito **nao** se
  acelera o Creta abaixo de 1 min: a integracao `kia_uvo` tem lag e rate
  limit da API da Kia/Hyundai, e forcar refresh com frequencia alta arrisca
  bloqueio temporario da conta e drena a bateria de 12V do carro. A
  aceleracao so perto de casa concentra o refresh extra exatamente na janela
  em que a deteccao de chegada precisa de dado fresco.
- **Piso de 10 min mesmo sem ninguem fora (2026-08-02):** quando ninguem esta
  fora (carro em casa), o Creta ainda e' forcado a atualizar a cada **10 min**,
  mas **so das 07h as 22h** (`KIA_BASELINE_INTERVAL_MS` / `KIA_BASELINE_HOUR_START`
  / `KIA_BASELINE_HOUR_FINISH`). Mantem `binary_sensor.creta_engine` e a
  localizacao razoavelmente frescos ao longo do dia sem depender de alguem estar
  fora; de madrugada **nao** acorda o carro parado, para poupar a bateria de 12V
  (mesma razao da janela `no_force_refresh` 22h-07h da integracao `kia_uvo`, cujo
  piso oficial de `force_refresh` e' 90 min — por isso o piso de 10 min mora aqui,
  apertando o botao, e nao nas opcoes da integracao). Deliberadamente e' o **unico**
  controlador do `button.creta_force_refresh` (uma automacao equivalente no HA
  chegou a ser criada e foi removida): dois controladores ignorariam o cooldown
  `sec_kia_last_force_refresh_ts` um do outro.
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

- 2026-08-07 (**refletor so em chegada real de carro**): pedido do usuario —
  acender somente quando houver situacao real de chegada em casa **com o
  Creta**, nunca so porque alguem esta perto. Duas decisoes de projeto tomadas
  com ele antes de implementar, porque a regra literal colidia com o que foi
  medido nesta mesma sessao:

  1. **Gate por trava, nao por leitura ao vivo.** Exigir
     `binary_sensor.creta_engine == "on"` no instante da travessia do anel
     deixaria o refletor sem acender quase sempre: o sensor so ganha dado novo
     quando um refresh acorda o carro, e registrou 0 transicoes em 5 dias
     incluindo uma viagem comprovada. Adotada a trava `creta_in_use` — ver
     "Gate do Creta".
  2. **Carencia de 90 s nos desligamentos por chegada.** Como a chegada e
     detectada antes de estacionar/desligar/destravar, a condicao "chegada
     confirmada" preemptaria sempre a condicao "desligado e destravado" e
     apagaria a luz justo no trajeto carro->porta, que e o proposito dela.

  Implementado: gate `sec_check_engine_on` (renomeado "Creta em uso? (gate
  obrigatorio)") passou de pass-through a gate real; `sec_route_arrival_source`
  removido (pessoa e Creta usam o mesmo gate); novo `sec_evaluate_turn_off` com
  as cinco condicoes independentes, alimentado por `sec_prepare_arrival_context`
  out0 (turn_off) e out2 (location_update); novo `sec_arrival_off_grace` (delay
  `delayv`); novo `sec_approach_wake_gate` reaproveitando `sec_force_refresh_creta`
  para acordar o carro na travessia do anel; `sec_turn_off_creta_home` (o switch
  de 300 m) removido.

  Dois detalhes que so aparecem na pratica: **"chegada confirmada" tem que ser
  a transicao para a `zone.home`, nao o estado "esta em casa"** — com o estado,
  o tracker congelado da Valeria (iCloud marcando casa) deixaria a condicao
  permanentemente verdadeira e apagaria o refletor 90 s depois de cada
  acendimento. E **a trava so pode soltar com o motor `off`** — senao a saida
  de casa (carro em casa, motor ligado) limparia a trava na hora.

  Validado com replay dos nos reais contra 6 cenarios: pessoa sem o Creta (nao
  acende), chegada de carro com dado de motor velho (acende pela trava),
  chegada pela localizacao do Creta, desligamento por desligado+destravado,
  anti-religamento, e tracker congelado com e sem o Creta em uso.

- 2026-08-07 (**pre-acendimento: a causa raiz nao era GPS, era falta de
  zona**): pedido do usuario — o refletor tem que estar aceso **pelo menos
  2 min antes da chegada**, nao no momento em que ele abre o portao.

  Ao investigar, a descoberta: **so existia `zone.home` (100 m)**. O app
  Companion registra cada zona nao-passiva como geofence de region monitoring
  do iOS, entao o sistema tinha sido instruido a avisar sobre um unico limite
  e nao reportava nada no caminho — de proposito, e assim que ele poupa
  bateria. Os "0 pontos na faixa 100–300 m" medidos horas antes nao eram GPS
  ruim: era ausencia de zona. Nenhum ajuste de limiar dentro do fluxo
  resolveria, porque o dado nunca ia chegar.

  Implementado: `zone.chegando` (1500 m, dimensionada para os 2 min — ver
  `homeassistant/packages/zonas_presenca.yaml`); os nos de gatilho passaram a
  expor `trigger_state`/`trigger_prev_state` via `$entity()`/`$prevEntity()`;
  `sec_detect_arriving_source` acende na entrada do anel (`arrival_stage =
  "approach"`) e mantem a entrada na `zone.home` como rede de seguranca
  (`"home"`). Backstop 10 -> 15 min. Ver pontos 3 e 4.

  Dois bugs achados no caminho: (a) **sair de casa acenderia o refletor** — a
  travessia `home -> chegando` acontece a ~100 m, dentro do raio de 300 m do
  `isHome()`; era latente antes do anel, mascarado porque nada disparava.
  Corrigido descartando todo evento com estado anterior `home`. (b) o
  pre-acendimento consumia o `armed`, entao quem parasse dentro do anel e
  chegasse depois do backstop ficava sem luz; agora so o estagio `home`
  consome.

- 2026-08-07 (**tracker congelado da Valeria**): logo apos criar o anel, a
  Valeria apareceu como `chegando` estando **em casa**. Nao era o anel: o
  `device_tracker.iphone_de_valeria` (mobile_app) reportava **uma unica
  posicao, 644 m, havia 2 dias inteiros** — congelado — enquanto o
  `..._valeria_2` (iCloud) mostrava 25–40 m (casa, correto). Antes do anel
  esses 644 m liam como `not_home` e passavam despercebidos; com o raio de
  1500 m viraram `chegando`, e a reavaliacao de zona gerou um
  `not_home -> chegando` que, a noite, teria acendido o refletor e disparado
  o push. Corrigido com `any_tracker_home` (ponto 3): se qualquer tracker da
  pessoa diz "em casa", a entrada no anel e ignorada.

  **A causa raiz e o iPhone, nao o fluxo** — vale conferir no app do HA da
  Valeria: localizacao "Sempre", localizacao precisa ligada e atualizacao em
  segundo plano. Enquanto o mobile_app dela estiver congelado, o
  pre-acendimento dela depende so do iCloud (poll ~30 min).

- 2026-08-07 (**aviso "Valeria chegando" nunca disparava**): mesma causa raiz
  do refletor. Exigia `distance_m` entre 50 e 700 m (faixa inexistente) **e** o
  Creta a <=1000 m pela nuvem da Kia — duas maneiras independentes de nunca
  disparar. Agora dispara na travessia do anel e o Creta virou metadado (muda
  so o texto). Ver "Aviso Valeria chegando".

- 2026-08-07 (**regressao: o refletor parou de acender de vez**): o usuario
  reportou que o fluxo "deixou de funcionar". O recorder confirmou:
  `switch.refletor_portao_carros` **nao ligou nenhuma vez** entre 02/08 e
  07/08 (todo o historico retido). Causa raiz: o guard `primary_home`
  introduzido em `sec_detect_arriving_source` (ponto 6) era **absoluto** —
  `if (sourcePosition.primary_home === true) return null` — e descartava toda
  leitura com o tracker em tempo real dentro de 100 m de casa.

  O que tornou isso fatal: **os trackers nunca reportam na faixa de
  100–300 m**. Medido no recorder (2 dias, `iphone_de_gabriel_furlan`,
  `iphone_de_valeria`, `creta_location`): **0 pontos** na faixa para os tres;
  a chegada do Creta em 05/08 pulou de **486 m -> 32 m numa unica leitura**.
  Ou seja, a unica leitura que cai dentro do raio de chegada de 300 m ja vem
  com `primary_home` true — o guard cobria exatamente o evento que fazia a luz
  acender, e a janela em que ele *nao* dispararia (100–300 m) nunca ocorre na
  pratica. Reproduzido offline rodando os nos do tab contra estados reais:
  chegada "pula direto para casa" -> `sec_detect_arriving_source` retornava
  `null`; chegada sintetica a 250 m -> acendia.

  Correcao: o corte virou **temporal** em vez de posicional — descarta so se o
  tracker em tempo real ja estava em casa ha mais de `PRIMARY_HOME_GRACE_MS`
  (10 min), via novo `primary_home_for_ms` (`last_changed`) calculado em
  `sec_prepare_arrival_context`. Chegada real cai em segundos e acende;
  catch-up do iCloud (poll ~30 min) continua descartado. Sem `last_changed`,
  fail-open. Ver ponto 6.
- 2026-08-02 (luz de pessoa desacoplada do Creta): auditoria do recorder do
  HA (10 dias, 23/07–02/08) mostrou que os gatilhos do Creta usados no ramo de
  pessoa nao sao confiaveis: `binary_sensor.creta_engine` reportou **"on" 1x
  em 10 dias** (48 s); `device_tracker.creta_location` tem coordenadas boas
  (`gps_accuracy=0`) mas poll grosso — na chegada real de 02/08 **pulou de
  3090 m (17:52) para 36 m (17:58) sem nenhuma leitura na faixa de 700 m**, com
  gaps de ate ~29 min e um **apagao de 6 dias (27/07–01/08) sem dados**. O
  celular (`device_tracker.iphone_de_valeria`) e' bem mais confiavel (dados
  todos os dias, ate 30 s de cadencia na aproximacao). Decisao do usuario:
  remover o gate do Creta no ramo de pessoa — `sec_check_engine_on` virou
  pass-through ("Chegada de pessoa (acende por proximidade)") e a luz acende
  quando Gabriel ou Valeria chega (celular <= 300 m, escuro, nao ja em casa),
  independente do carro. **Revertido em 2026-08-07**: o Creta voltou a ser gate obrigatorio, agora como a trava `creta_in_use` — ver "Gate do Creta".
- 2026-08-02 (aviso "Valeria chegando de carro"): o aviso
  `sec_notify_valeria_approaching` (push para Gabriel) estava **religado no
  no errado** — era alimentado por `sec_detect_arriving_source` out0, que
  dispara para *qualquer* chegada (Gabriel, Valeria **ou** Creta), sempre com
  o texto fixo "Valeria...". A logica dedicada da Valeria (700 m, dedup,
  reset) existia em `sec_update_arming_location` mas saia por out1, que estava
  **desconectada** (codigo morto — por isso a afirmacao antiga de "so dispara
  para source === valeria" ficou falsa por um tempo). Correcao: (a) removido
  o aviso do fan-out de `sec_detect_arriving_source` (segue so para
  `sec_check_dark` e `sec_creta_trip_refresh_gate`); (b) ligado
  `sec_update_arming_location` out1 -> aviso; (c) condicao de "de carro" =
  `source === "valeria"` **e** Valeria a <= 700 m **e** o Creta chegando junto
  (estava armado/fora e agora a <= 1000 m — usa a POSICAO do Creta, nao
  `binary_sensor.creta_engine`, que o poll kia_uvo quase nunca pega "on"; o
  limiar folgado de 1000 m tolera o lag de GPS da Kia); (d) texto -> "Valéria
  está chegando de carro.". Nao e' bloqueado pelo escuro (dispara a qualquer
  hora do dia, como pedido). Se o Creta ficou o dia parado em casa (Valeria em
  outro carro/a pe), seu armamento ja foi limpo por contexto (<=100 m) e o
  aviso nao dispara.
- 2026-08-02 (refresh do Engine + gatilho de chegada de carro): o usuario
  notou que `binary_sensor.creta_engine` nao atualizava ao ligar o carro.
  Contexto: no backend BR o Engine so' e' reportado de forma confiavel perto de
  estacionar (ver [[project-creta-kia-uvo-integration]]), e o poll ao vivo
  padrao roda so' 1x/24h. (a) Adicionado o **piso de 10 min** (07h-22h) de
  force-refresh do Creta mesmo sem ninguem fora — ver "Atualizacao de
  localizacao". Uma automacao equivalente no HA foi criada e depois removida
  para manter um unico controlador do botao. (b) Confirmado (e documentado)
  que **a chegada do proprio Creta ja acende o refletor direto pela LOCALIZACAO
  GPS**, sem depender do motor — o `sec_check_engine_on` (motor OU Creta
  fora-e-<=700m) fica so' no ramo da *pessoa*, como confirmacao secundaria de
  "chegou de carro". Optou-se por **nao** adicionar velocidade de aproximacao
  como reforco: o caminho do Creta + a cadencia de 1 min perto de casa ja
  cobrem a chegada de carro. (c) Corrigido o nome do inject de "A cada 1 min"
  para **"A cada 30 s"** (o `repeat` sempre foi 30 s) e o comentario do refresh.
- 2026-08-02: revisao geral de bugs dos flows. (a) `sec_sun_changed` e
  `sec_creta_lock_context_changed` (eventos `context_update`) nao buscavam
  `gabriel_icloud`/`valeria_icloud`, entao rodavam o `mergeWithIcloudFallback`
  so com o `mobile_app` — um evento de por-do-sol ou de trava do Creta podia
  limpar indevidamente o `armed` de quem estava fora com o `mobile_app`
  travado em "casa" (a falha de 2026-07-10). Adicionados os dois trackers
  iCloud nesses gatilhos, alinhando com os demais. (b) Cadencia de refresh
  passou a acelerar perto de casa: tick base 1 min -> 30 s, iPhones 1 min ->
  30 s quando alguem fora esta a <= 2000 m, Creta mantem 5 min/1 min mas com
  o piso de 1 min agora imposto por tempo (nao pelo periodo do tick), para
  nao estourar o rate limit da Kia com o tick mais rapido. (c) Adicionado
  `primary_home` (tracker em tempo real) para nunca acender o refletor com a
  pessoa/carro ja em casa — ver ponto 6 de "Logica de chegada". (d) Removida a
  sobreposicao 100–300 m em `sec_update_arming_context`: a limpeza do armado
  passou a usar 100 m (nao 300 m), para nao apagar o armado de quem se aproxima
  na faixa 100–300 m antes da chegada disparar — ver ponto 4. (e) Gatilho de
  desligar por trava trocado de `locked` para `unlocked`
  (`sec_creta_locked_changed`, renomeado "Creta destravou (se em casa)"): o
  Kia trava sozinho ao andar, entao `locked` ocorria durante a aproximacao e
  apagava a luz cedo demais; o refletor agora fica aceso ate o motor desligar
  ou a porta ser destravada — ver "Desligamento".
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
  `GATE_LAT`/`GATE_LON` (portao/entrada, ~168 m
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
