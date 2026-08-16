# Contexto de chegada e iluminação de segurança no Node-RED

Os flows relacionados ficam em `nodered/flows.json` e são divididos em quatro
abas:

| Flow | Responsabilidade |
| --- | --- |
| `localizacao_pessoas` | Ler e normalizar os trackers de Gabriel e Valéria, manter o armado individual, detectar aproximação/chegada e controlar o refresh dos iPhones. |
| `contexto_creta` | Normalizar localização, motor e trava do Creta, manter `creta_in_use`, detectar chegada, atualizar viagens e controlar o refresh do veículo. |
| `contexto_chegadas` | Sincronizar os snapshots periódicos, calcular somente a política conjunta `anyone_away` e enriquecer o aviso da Valéria. Não interpreta GPS bruto. |
| `iluminacao_seguranca` | Consumir os contratos de alto nível e decidir ligar/desligar `switch.refletor_portao_carros`, incluindo carência, timeout e anti-religamento. |

Essa separação impede que a iluminação conheça trackers, coordenadas, refresh
da Kia ou detalhes de viagem.

## Arquitetura

```mermaid
flowchart LR
    IP[iPhones / iCloud] --> P[localizacao_pessoas]
    K[Hyundai Bluelink] --> C[contexto_creta]
    T[Tick de 30 s] --> O[contexto_chegadas]

    O -->|snapshot request v1| P
    O -->|snapshot request v1| C
    P -->|people-context v1| O
    C -->|creta-context v1| O
    O -->|refresh-command v1| P
    O -->|refresh-command v1| C

    P -->|arrival v1| L[iluminacao_seguranca]
    C -->|arrival v1| L
    P -->|people-context v1| L
    C -->|creta-context v1| L
    S[sun.sun] --> L
    L --> R[switch.refletor_portao_carros]

    P -->|arrival v1| A[alarme_desarme_chegada]
    C -->|arrival v1| A
```

A comunicação usa `link in`/`link out`. Os links são contratos explícitos; não
há wire direto entre abas, MQTT intermediário, entidade auxiliar ou produtor
oculto em `global context`.

## Contratos entre flows

### `security.people-context.v1`

Produzido somente por `localizacao_pessoas`. Contém:

- `gabriel` e `valeria` já normalizados;
- `distance_m`, `gate_distance_m`, precisão e validade;
- `current_home` (tracker selecionado e fresco), `primary_home`,
  `any_tracker_home` e tempo do tracker primário em casa;
- `anyone_away`, menor distância observada e armado individual;
- metadados da transição que originou a atualização;
- `updated_at`, `valid`, `ready`, `stale`, `source` e `reason`. Cada pessoa
  também publica `updated_at`, `ready` e `stale`.

### `security.creta-context.v1`

Produzido somente por `contexto_creta`. Contém:

- distância e validade da localização;
- `home`, `away`, `approaching_home` e `arrived_home`;
- motor, trava e validade desses estados;
- `in_use` (`true`, `false` ou `null` enquanto pendente), `in_use_pending`,
  `in_use_reason`, lifecycle de viagem e armado de chegada;
- `updated_at`, `valid`, `ready`, `stale`, `reason` e `readiness_reason`.

### `security.arrival.v1`

Produzido por `localizacao_pessoas` ou `contexto_creta` após validar uma
chegada. Preserva o contrato consumido pelo alarme:

- `source`: `gabriel`, `valeria` ou `creta`;
- `arriving`: lista contendo a origem;
- `arrival_source_type`: `person` ou `creta`;
- `arrival_stage`: `approach` ou `home`.
- `event_at`: epoch Unix em milissegundos da observação usada para dedupe.

### Snapshot e refresh

`contexto_chegadas` cria um `refresh_cycle_id`, solicita os dois snapshots e
só publica `security.refresh-command.v1` quando ambos retornam `ready: true` no
mesmo ciclo. O comando inclui `origin`, `reason`, `issued_at` e `ready`; isso
evita duplicação e torna loops diagnosticáveis. Cada domínio continua dono de
seu cooldown. Snapshots com `updated_at` anterior ao cache são ignorados.

## Entidades

### Pessoas

- `device_tracker.iphone_de_gabriel_furlan`
- `device_tracker.iphonegabrielfurlan` (fallback iCloud)
- `device_tracker.iphone_de_valeria`
- `device_tracker.iphone_de_valeria_2` (fallback iCloud)
- serviços `notify.iphone_de_gabriel_furlan` e `mobile_app.request_location_update`

Quando ambos os trackers estão frescos e têm coordenadas confiáveis,
conserva-se o fallback anterior: vence o tracker que reporta a maior distância
de casa, porque a falha
observada foi o Companion App congelado numa posição antiga em casa. Se um
tracker disser `home`, `any_tracker_home` bloqueia uma entrada falsa no anel.
Uma saída completa observada ainda permite o aviso de retorno da Valéria mesmo
com o iCloud atrasado.

### Creta

- `device_tracker.creta_location`
- `binary_sensor.creta_engine`
- `lock.creta_door_lock`
- `button.creta_force_refresh`
- `button.garagem_creta_refresh_trip_info`
- entidades do dispositivo atualizadas pelo serviço `homeassistant.update_entity`

### Iluminação

- `sun.sun`
- `switch.refletor_portao_carros`
- notificações dos iPhones dos moradores

## Coordenadas e fallback

`HOME_LAT`, `HOME_LON`, `GATE_LAT` e `GATE_LON` vêm do ambiente do container;
coordenadas privadas nunca são versionadas. O cálculo só aceita GPS com
precisão de até 100 m. Sem coordenada confiável, usa-se `home`/`not_home` como
fallback. `unknown`, `unavailable` ou precisão ruim produzem `state_valid:
false`, não geram chegada e não limpam o armado anterior.

## Regras de chegada preservadas

- Distância de armado: mais de 100 m de casa.
- Anel de aproximação: entrada em `zone.chegando` a partir de fora. O raio de
  aproximadamente 1500 m é definido em
  `homeassistant/packages/zonas_presenca.yaml`, não duplicado no JavaScript.
- `home -> chegando` é saída, nunca chegada.
- A entrada no anel gera `arrival_stage: approach` e não consome o armado.
- A entrada em casa ou até 300 m de casa/portão é a rede de segurança
  (`arrival_stage: home`) e consome o armado.
- Um tracker primário que já está em casa há mais de 10 min bloqueia o catch-up
  tardio do tracker secundário. Sem `last_changed`, o comportamento permanece
  fail-open para não perder uma chegada real.
- A chegada do Creta atualiza o histórico de viagens do dia; no estágio
  `approach`, também tenta um wake pontual do veículo.
- Atualizações de atributos do tracker também são observadas sem exigir troca
  de zona. Um deslocamento acumulado de pelo menos 250 m (ou maior que a soma
  das precisões GPS) solicita refresh do contexto, mas nunca autoriza sozinho
  a iluminação ou outra ação física.

## Freshness e `creta_in_use`

Freshness é calculada com `last_updated` (ou `last_changed` como fallback),
sempre em epoch Unix UTC, milissegundos:

| Sinal | Janela | Ao expirar |
| --- | ---: | --- |
| trackers de Gabriel e Valéria | 15 min | pessoa `stale`, snapshot não ready; nunca vira `false` |
| localização do Creta | 30 min | localização `stale`; não confirma `home`/`away` para recovery |
| motor e trava | 5 min | sinal inválido/stale; `off` não é interpretado como evidência atual |
| snapshots derivados | monotônico por `updated_at` | antigo e futuro >60 s são descartados; conflito no mesmo timestamp preserva o primeiro |

O estado pertence exclusivamente a `contexto_creta`:

- liga quando o motor é observado `on`;
- permanece ligado durante lacunas do backend da Kia;
- desliga com motor `off` fresco e carro em casa, ou com motor `off` e trava
  destravada frescos;
- após restart, uma viagem persistida só é restaurada como `true` quando a
  localização atual e fresca ainda confirma que o carro está fora;
- sem evidência suficiente publica `in_use: null`, `in_use_pending: true`, e a
  iluminação permanece bloqueada. Nunca converte stale automaticamente em
  `false`.

O gate não usa apenas a leitura ao vivo do motor porque o backend brasileiro
pode manter esse sensor antigo durante uma viagem. A iluminação recebe apenas
`context.in_use` e não sabe como a trava foi calculada.

`security.creta-context.v1` foi mantido em `v1` após a auditoria dos
consumidores reais do repositório. A ampliação de `in_use` de booleano para
`true | false | null` não é puramente aditiva, mas todos os consumidores estão
no mesmo conjunto de flows e usam comparação estrita com `true`; nenhum
consumidor externo ou legado foi encontrado. `null` bloqueia o gate e não é
interpretado como `false`. Uma fronteira externa futura deverá publicar uma
nova versão em vez de assumir essa compatibilidade interna.

## Acendimento

`iluminacao_seguranca` liga o refletor somente quando todas as condições são
verdadeiras:

1. há um evento `security.arrival.v1`;
2. `sun.sun` está `below_horizon`;
3. `creta_in_use` é verdadeiro;
4. pessoas, Creta, sol e estado físico do refletor estão ready/reconciliados;
5. o refletor físico está `off` e não foi marcado como ativo por chegada;
6. não há supressão pós-desligamento ativa.

Depois de todos os gates, a ação grava no store `persistent` o lifecycle
`security_light_lifecycle_v1`: `active_by_arrival`, `on_since`,
`force_off_at`, dedupe recente e `updated_at`. Eventos barrados por claridade,
readiness ou estado do Creta não consomem o dedupe do refletor.

Também chama `switch.turn_on`, avisa os moradores e inicia o backstop de 15
minutos.

## Cinco condições independentes de desligamento

| # | Condição | Efeito |
| --- | --- | --- |
| 1 | motor desligado e porta destravada | imediato, após o filtro de 5 s do evento do veículo |
| 2 | transição confirmada de Gabriel para `home` | após completar 90 s desde o acendimento |
| 3 | transição confirmada de Valéria para `home` | após completar 90 s desde o acendimento |
| 4 | transição confirmada do Creta para `home` | após completar 90 s desde o acendimento |
| 5 | refletor ativo por 15 min | imediato ao vencer o backstop |

Uma atualização genérica da trava não ignora o filtro de 5 s. A carência grava
`pending_off_at` e revalida a condição quando vence. O backstop grava
`force_off_at`. Após desligar, `cooldown_until` bloqueia religamento por cinco
minutos. Os três prazos são absolutos e são reconstruídos no restart; nenhum
depende exclusivamente de um `delay` residente em memória.

## Refresh

- Tick base: 30 s, com snapshot de pessoas e Creta.
- iPhones: quando qualquer pessoa ou o Creta está fora, 60 s; 30 s quando a
  menor distância dos trackers de pessoas é até 2000 m.
- Creta: 15 min quando alguém está fora; se todos estão em casa, 15 min apenas
  entre 07h e 22h.
- Entrada no anel: wake pontual do Creta, ainda protegido pelo cooldown do
  coordinator Kia/Hyundai.
- Mudança de zona ou deslocamento GPS significativo: solicita refresh imediato
  e marca motor/contexto como potencialmente stale. A posição de referência é
  persistida somente para dedupe; logs registram tipo de movimento e distância
  arredondada, nunca latitude/longitude.
- O timestamp dos iPhones é otimista, preservando o comportamento anterior.
- O refresh do Creta persiste tentativa, próxima tentativa e último sucesso.
  Falhas usam backoff exponencial de 1, 2, 4, 8 e no máximo 15 min; sucesso
  limpa tentativas e aplica o intervalo normal de 15 min. Depois do quinto
  estágio, o contador satura e as novas tentativas continuam limitadas a uma a
  cada 15 min; não há rajada no restart porque `next_allowed_at` é persistido.
- A chamada legada `homeassistant.update_entity` que acompanhava o refresh do
  Creta continua sincronizando os dois trackers de iPhone, mas agora por um
  contrato explícito `contexto_creta -> localizacao_pessoas`; nenhuma entidade
  de pessoa permanece dentro do flow do veículo.

Comportamento estranho deliberadamente preservado: a distância usada para
escolher 30 s ou 60 s considera todos os trackers de pessoas, inclusive alguém
que esteja em casa. Assim, se apenas o Creta estiver fora e um morador estiver
em casa, o refresh dos iPhones pode continuar a cada 30 s. Corrigir isso seria
mudança funcional e deve ser tratado separadamente.

## Restart, persistência e readiness

`nodered/settings.js` mantém o store padrão `memoryOnly` e oferece o store
nomeado `persistent` (`localfilesystem`). Somente intenção e histórico limitado
optam por ele; entidades atuais do HA continuam sendo a verdade física. O
inventário completo está em
[`SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md`](SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md).
No container, o caminho é explicitamente `/data/context`, coberto pelo volume
`./nodered:/data`; cache e flush de 30 s são declarados no próprio settings.

```mermaid
flowchart TD
    N[Node-RED startup] --> P[Restaurar lifecycle e histórico persistido]
    N --> H[Ler entidades atuais do HA]
    H --> F[Validar freshness e timestamps]
    P --> R[Reconciliar com estado físico]
    F --> R
    R --> C{people + creta + sol + refletor ready?}
    C -->|não| B[Bloquear efeitos físicos e aguardar sinais]
    C -->|sim| D[Publicar contexts ready e retomar deadlines]
```

O grupo visual `0. Startup / Reconciliação` consulta
`switch.refletor_portao_carros` no startup e a cada 60 s, além de acompanhar
mudanças físicas:

- físico `off` + lifecycle ativo: corrige o lifecycle, sem enviar serviço;
- físico `on` + lifecycle inativo: presume origem manual/desconhecida e não
  desliga;
- físico `on` + lifecycle válido por chegada: restaura carência e backstop;
- `unknown`/`unavailable`: marca `light_reconciled: false` e bloqueia ligar ou
  desligar.

Uma leitura física precisa ter sido observada nos últimos 2 min. Se um deadline
recuperado vencer durante indisponibilidade, ele é bloqueado e fica elegível
para novo agendamento assim que uma consulta física confiável reconciliar o
estado; o deadline absoluto original não é estendido.

O tick inicial ocorre após 2 s e converge assim que o HA responde. Se HA e
Node-RED reiniciarem juntos, snapshots parciais não liberam side effects. Se
apenas um reiniciar, os eventos `outputInitially` e o ciclo periódico
reconstroem o mesmo estado. Lifecycle corrompido, futuro absurdo ou com mais de
24 h é descartado; cooldown acima de 30 min também é invalidado.

## Fail-safe

- HA, localização, motor, trava, sol ou refletor indisponível: contexto não
  ready; não liga, não desliga e não anuncia uma chegada nova.
- Bluelink indisponível: mantém contexto confirmado apenas para futura
  revalidação e limita retry por backoff.
- Snapshot incompleto/antigo: não sobrescreve snapshot mais novo e não vira
  booleano falso.
- Snapshots com o mesmo timestamp e payload divergente preservam o primeiro e
  geram aviso; um snapshot realmente posterior `ready: false` prevalece para
  derrubar readiness de forma conservadora.
- Refletor ligado manualmente: preservado; somente lifecycle comprovadamente
  criado pela automação permite desligamento automático.
- Viagem ou chegada: dedupe com TTL de 10 min evita replay após restart; dados
  de dedupe não crescem sem limite.

## Organização visual

As abas seguem `Eventos -> Normalização -> Contexto -> Decisão -> Ação`.
Grupos delimitam cada responsabilidade. `link nodes` são usados somente nas
fronteiras de domínio, no salto entre detecção e ações do Creta, no timeout e
nos testes manuais. O renderizador estático verifica a geometria:

```bash
cd nodered
FLOW_LAYOUT_DIR=/tmp/security-flow-layouts \
  node tools/render-flow-layout.mjs \
  localizacao_pessoas contexto_creta contexto_chegadas iluminacao_seguranca
```

O aceite atual é zero wires acima de 500 px e zero wires voltando da direita
para a esquerda nas quatro abas.

## Validação

```bash
cd nodered
npm run flows:validate
npm run flows:test-security
npm run flows:test-alarm-arrival
```

`flows:test-security` executa 31 cenários de regressão, incluindo
estados inválidos, restart, eventos fora de ordem, simultaneidade e falha/sucesso
de refresh, inclusive movimento dentro da mesma zona.
`flows:test-security-recovery` acrescenta 40 cenários de restart e recuperação;
`flows:test-security-adversarial`, mais 23 casos adversariais com relógio
controlado para reconciliação e deadlines. São replays offline dos
`function nodes` e uma validação estrutural;
não substitui um teste de campo com os iPhones, o veículo e a API Bluelink.
