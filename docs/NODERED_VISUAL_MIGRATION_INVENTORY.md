# Inventário da migração visual do Node-RED

Este documento registra o baseline observado antes da refatoração visual. Ele
é deliberadamente um mapa de migração, não uma segunda fonte de políticas. Os
valores operacionais canônicos devem aparecer no canvas e nos contratos
executáveis; este inventário referencia esses locais e deve ser atualizado
quando uma etapa for concluída.

## Baseline e rollback

- Commit de referência: `f2e1de79684243bb02746be214cc05ed94417575`.
- SHA-256 inicial de `nodered/flows.json`:
  `7f5b1f47fabbd38256ddf7eddcdba93791ef6da9027b79c2590ef126e9e2a50f`.
- Estado inicial: árvore limpa; Home Assistant, Node-RED e MQTT em execução;
  Home Assistant e Node-RED reportando saúde.
- Escala inicial: 24 tabs, 1.085 nós, 244 nós `function`; 87 funções possuíam
  pelo menos 1.000 caracteres.
- Rollback de cada etapa: restaurar somente os arquivos da etapa para o commit
  acima, regenerar o tab pela fonte versionada, validar o artefato e fazer
  deploy apenas do Node-RED. Watchdogs nativos do Home Assistant não devem ser
  removidos antes de o caminho substituto ter paridade comprovada.

## Matriz atual e destino canônico

| Domínio / tab | Produção dos dados | Decisão e estado atuais | Efeitos e consumidores | Duplicação ou risco observado | Fluxo canônico de destino |
| --- | --- | --- | --- | --- | --- |
| `recorder_retention` | Eventos de sensores HA e agendamento diário | Funções configuram baseline, outlier, retenção, fila e lifecycle em contexto persistente | `recorder.purge_entities` e `recorder.purge`; Recorder e painel de storage consomem o resultado | Limites, elegibilidade e liberação do repack estão embutidos em funções | Parâmetros visuais; normalização pura; decisões `switch`; fila e gate final visíveis; terminal dry-run comum |
| `revisao_documental_semanal` | Cron do Node-RED, botão HA e status sanitizado do worker | Funções classificam origem, lifecycle e falhas | Ponte `exec` para worker isolado; dashboard consome helpers HA | Orquestração e classificação ainda aparecem em funções; gerador é a fonte versionada | Agenda, seleção produção/teste, sucesso/falha e lifecycle em blocos visuais; parser estrutural pequeno |
| `backup_git` | Cron, pedido manual e resultado sanitizado do host | Funções classificam sucesso, falha, adiamento e retry | Ponte `exec`, notificação móvel e persistente; `atualizacoes_diarias` recebe sucesso | Política de retry e notificação distribuída no tab | Política visual, rotas nomeadas, gate final, confirmação e retry explícitos |
| `garagem` | MQTT do botão Zigbee e evento do dashboard | Uma função combina envelope, dedupe e cooldown; contexto guarda o último pulso | MQTT `ON/OFF`, Logbook e alerta; relé físico consome | Dedupe de 900 ms, cooldown de 1 s e pulso de 700 ms aparecem em função/info/delay | Três parâmetros visuais validados; normalização pequena; dedupe/cooldown/produção-teste e pulso em blocos separados |
| `integracoes_compartilhadas` | Hub DuloNode | Sem política; apenas integração compartilhada e links | `alarme_casa` e `iluminacao_externa` | Nenhuma duplicação funcional; falta explicitação de contrato de saída | Manter como infraestrutura compartilhada, com comentário de contrato e observabilidade |
| `iluminacao_externa` | DuloNode, pôr do sol, MQTT de disponibilidade e confirmação mobile | Funções guardam disponibilidade, confirmação mais recente e recovery de startup | Quatro tópicos MQTT, Alexa e confirmação mobile | Gate, fan-out e recovery misturam política com adaptação de payload | Parâmetros visuais de confirmação/recovery; caminhos manual/pôr do sol; disponibilidade; fan-out; confirmação; falha e dry-run visíveis |
| `alarme_casa` | DuloNode e link de desarme confirmado | Funções mantêm intenção e retry de armar/desarmar | `public_bindings.call` para painel e Alexa | Retry e “ainda deseja?” ficam em funções; não há trilha manual full dry-run | Intenção em `change`, decisão em `switch`, retry limitado visual, gate final e replay completo sem efeito |
| `resfriamento_raspberry_pi` | Sensores de CPU/climate/ownership do HA | Muitas funções controlam snapshot, locks, retry, restauração e recovery; helpers HA persistem ownership/snapshot | Serviços `climate.*`, helpers HA e notificações | Thresholds também são decididos em templates/automação HA; tab não possui teste manual full dry-run | Métricas HA como entrada; política única visual; decisões/gates/retries visíveis; adaptadores pequenos; alertas de saúde consolidados no domínio de infraestrutura |
| `storage_health` | Sensores de storage HA, cron e botão manual | Switches classificam thresholds, histerese, recovery, cooldown, tendência e autocuidado; histórico/categorias ficam em cálculo isolado | MQTT discovery/state, workers allowlisted e três destinatários atrás de uma entrada de efeito | Monólito de 11,6 KiB removido; onze parâmetros têm uma única definição visual | Migrado: configuração validada, decisões explícitas, chamadas privilegiadas unificadas por links e replay integral dry-run |
| `monitoramento_internet` | Agenda visual, política validada, adaptador ICMP e relatório sanitizado de SSH/Codex produzido pelo host | Switches decidem quorum, incidente, 3 falhas/2 sucessos e elegibilidade/cooldown da recuperação remota; mutadores curtos persistem estados separados | MQTT retained, fanout visual e pedido estreito ao worker do host atrás de gates finais | Máquina monolítica removida; alvos e thresholds têm uma única definição visual; Tailscale permanece exclusivamente em `monitoramento_vpn` | Migrado: nove parâmetros, decisões explícitas, recovery persistente do acesso remoto e replay integral dry-run |
| `monitoramento_zigbee` | Estado/availability MQTT, status do broker e agenda nativa | Switches confirmam queda/retorno, dedupe e lembretes; estado de rede/componentes permanece persistente | MQTT retained e fanout visual para os três hubs canônicos atrás dos gates finais | Monólitos de rede/componentes removidos; 30 s, 60 s e 24 h têm uma única definição visual | Migrado: três parâmetros validados, 19 decisões visuais, recovery/dedupe persistentes e replay integral dry-run |
| `localizacao_pessoas` | Trackers Mobile App/iCloud e snapshots coordenados | Seleção, classificação geográfica, lifecycle de chegada e refresh usam funções extensas e contexto persistente; política de localização já é visual | MQTT canônico, refresh dos iPhones, links para chegada/iluminação/notificações | O tab é o padrão parcial, mas seleção, lifecycle e refresh ainda concentram decisões em JS; dashboards ainda classificam apresentação por thresholds próprios | Preservar política única; separar adaptação, seleção, geografia e lifecycle; razões e rotas em `switch`; publicar status canônico de apresentação |
| `contexto_vehicle_primary` | Entidades Kia UVO, política de localização, presença e comandos manuais | Normalização, chegada, refresh, backoff, cache probe, viagens e comandos remotos usam várias funções e contexto persistente | `kia_uvo.update`, bindings de wake/viagens, MQTT e notificações; dashboards/localização/iluminação consomem | Maior concentração de lógica: funções de 34 mil e 19 mil caracteres; política visual de refresh ainda termina em coordenador monolítico | Subtrilhas independentes para localização, refresh, backoff, comandos e viagens; políticas visuais; máquinas de estado pequenas; uma fronteira de efeito por responsabilidade |
| `contexto_chegadas` | Contextos canônicos de pessoas/veículo, agenda de 30 s e recovery | Switches nomeados decidem coalescência, monotonicidade, completude, saída de morador, precedência e recovery; estado transitório fica isolado por produção/teste | Links preservados de snapshot e política de refresh para os dois domínios | Monólito de 13 mil caracteres removido; 10 s e 60 s têm uma única definição na política visual | Migrado: dois parâmetros validados, decisões visuais, dedupe persistente de saída e replay coordenado até os dry-runs dos consumidores |
| `iluminacao_seguranca` | Contextos e chegada canônicos, luminosidade, estado físico e bypass | Várias funções extensas controlam decisão, motor, disponibilidade, lifecycle e recovery | Refletor, notificações, MQTT do bypass e observabilidade | Decisões críticas e lifecycle ficam em funções de 4–10 mil caracteres | Política visual; cada condição em bloco nomeado; gates independentes; lifecycle e timer explícitos; fronteira única produção/dry-run |
| `alarme_desarme_chegada` | Chegada canônica, estado do alarme e resposta mobile | Gates visuais validam contrato, direção, ciclo, pendência, cooldown, tokens, timeout, cancelamento e confirmação | Duas notificações acionáveis atrás do aceite HA e intenção de desarme para `alarme_casa` | Validadores de 5,7 e 4 KiB removidos; quatro tempos têm uma única definição visual | Migrado: quatro parâmetros validados, decisões nomeadas, token em adapter pequeno e replay integral dry-run |
| `monitoramento_tuya` | Registros/estados HA e agenda nativa de 30 s | Split/join nativo e switches decidem falha, recovery, lembrete e resumo; estado por dispositivo é persistente | MQTT retained e fanout visual para os três hubs canônicos atrás dos gates finais | Monólito de 9,5 mil caracteres removido; adaptador estrutural de 2.052 caracteres não contém política | Migrado: três parâmetros validados, 18 decisões visuais, dedupe/recovery persistentes e replay integral dry-run |
| `monitoramento_vpn` | Relatório sanitizado do host e estado canônico da internet | Switches decidem supressão, saúde, confirmação, incidente, lembrete e recovery; estado mínimo é persistente | MQTT discovery/state e fanout visual para os três hubs canônicos atrás dos gates finais | Avaliador monolítico removido; 120 s, 60 s, 180 s e 86.400 s têm uma única definição visual | Migrado: quatro parâmetros validados, oito decisões visuais, adapters pequenos e replay integral dry-run |
| `atualizacoes_diarias` | Sucesso do backup, inventários HA `update.*`, versão oficial do Codex CLI e npm audit, comandos manuais e resultados sanitizados | Switches classificam DietPi, Core, outros containers, Codex CLI, dependências npm gerenciadas, Bluelink, HACS versionado, firmware físico e desconhecidos; funções pequenas só adaptam contratos/estado | Pontes coalescentes por etapa; Codex CLI instala versão exata, verifica o binário e tenta rollback; atualização npm mantém a major e possui rollback; `update.install` existe apenas na fronteira final de firmware, com auto=false e dry-run | Instalador genérico `ha-updates` e agenda Bluelink paralela removidos; Core deixou de compartilhar o mesmo efeito dos demais containers | Migrado: quinze trilhas nomeadas, parâmetros validados, inventários canônicos, Core e Codex CLI isolados, HACS fail-closed e replay integral dry-run |
| `alertas_codex` | Sensores/helpers de uso do Codex no HA | Função extensa decide nível, cooldown e resumo; HA também calcula `sensor.codex_nivel_de_alerta` | Push, notificação persistente e helpers de último alerta | Decisão duplicada entre Jinja HA e Node-RED; estratégia manual legada | Node-RED calcula e publica nível canônico; painel consome; parâmetros visuais; full dry-run; HA mantém só telemetria/helpers |
| `guardiao_memoria_host` | Agendas visuais e resultado sanitizado do worker | Switches decidem contrato, presença, duplicidade, status e produção/teste; função curta guarda só a assinatura persistente | Duas pontes `exec`; worker do host executa a política privilegiada de segurança | Duplicação removida do Node-RED; política de processo permanece no único worker seguro | Migrado: parâmetros ativos nomeados, decisões e efeitos explícitos, parser de schema pequeno e replay com duplicata |
| `recuperacao_rtx` | Health HTTP passivo e comando manual explícito | Switches separam disponibilidade, estado do host, confirmação, cooldown e lifecycle | Health passivo, recovery MCP manual e alerta central | Parser HTTP permanece isolado; alerta recuperado antes não era encerrado | Migrado: parâmetros visuais, host `online`/`offline`/`unknown`, recovery somente manual, dedupe por incidente, encerramento persistente na recuperação e full dry-run |
| `notificacoes_chegadas_residentes` | Contrato `security.arrival.v1` já decidido por `localizacao_pessoas` e eventos sintéticos | Switches validam contrato, direção, ciclo externo, estágio, destinatário, frescor, reserva e dedupe da entrega; recibos mínimos persistem | Duas notificações móveis isoladas atrás do gate final, com retry limitado | Lifecycle de `near_home`/`home` deixou de ser recalculado neste tab; chegada direta em `home` agora usa a mesma decisão canônica | Migrado: quatro parâmetros de entrega/tempo, adapters pequenos, confirmação do serviço e replay integral sempre dry-run |
| `observabilidade_global` | `catch`/`status` de todos os tabs e alertas centrais explícitos | Funções extensas classificam, corroboram HA/MQTT, deduplicam e controlam recovery/recursão | Push para `mobile_primary` e notificação persistente | Parâmetros 30 s/60 s/90 s/6 h e classificação ficam em JS | Política visual de severidade/temporização; classificação estrutural pequena; decisões, dedupe, recovery e guard antirrecursão visíveis |

## Fronteiras fora do Node-RED

| Superfície | Papel atual | Decisão | Destino |
| --- | --- | --- | --- |
| `homeassistant/packages/nodered_flow_health.yaml` | Watchdog independente pelo LWT MQTT | Offline por 90 s, recuperação e notificação | Permanecer nativo: o monitor não pode depender do runtime observado. |
| `homeassistant/packages/portao_garagem.yaml` | Watchdog independente do relé | Força somente `OFF` após 5 s | Permanecer nativo como defesa em profundidade; nunca emite `ON`. |
| `homeassistant/automations.yaml` | Lifecycle/API interna da TV | Wake-on-LAN solicitado pelo HA | Permanecer nativo por depender do trigger interno `samsungtv.turn_on`. |
| `homeassistant/packages/raspberry_pi_system_health.yaml` | Produção de métricas, classificação e notificações | Thresholds de temperatura, CPU, load, memória, swap, storage e hardware | Manter métricas como produtor; migrar classificação operacional e notificações para política visual Node-RED; preservar startup nativo do HA. |
| `homeassistant/packages/codex_usage.yaml` | Produção/derivação de telemetria e helpers | Também calcula nível normal/atenção/crítico | Manter dados brutos; publicar nível canônico pelo Node-RED e fazer sensores/painéis apenas consumirem. |
| `homeassistant/dashboards/vehicle_primary.yaml` | Apresentação | Reclassifica idade de telemetria/cache com limites próprios | Substituir limites Jinja por status/razões canônicos publicados pelo Node-RED. |
| `homeassistant/dashboards/location.yaml` | Mapa e diagnóstico | Usa atributos canônicos de raio/seleção | Manter como consumidor; remover somente fallback decisório duplicado encontrado pelos testes de auditoria. |
| `homeassistant/dashboards/raspberry_pi_health.yaml` | Apresentação e comandos explícitos | Exibe sensores binários classificados no HA | Passar a exibir estados/atributos canônicos do Node-RED; comandos continuam ações explícitas do usuário. |

## Auditoria dos painéis e produtores

Os painéis não são produtores canônicos de automação e, portanto, nem todo dado
exibido nasce no Node-RED. Integrações do Home Assistant, MQTT, sensores
`command_line` passivos e workers sanitizados continuam produzindo fatos brutos;
o Node-RED centraliza as políticas e decisões operacionais; os dashboards apenas
leem entidades e atributos já publicados. Os templates Jinja restantes calculam
somente apresentação, como idade legível, percentual, cor, rótulo e barras, sem
selecionar tracker, autorizar serviço, aplicar cooldown ou acionar efeito.

| Painel | Fonte consumida | Lógica local permitida | Decisão operacional |
| --- | --- | --- | --- |
| `chat.yaml` | Sensores canônicos de uso Codex/RTX e resultados sanitizados | Formatação, percentuais, tabelas e gráficos textuais | Nenhuma |
| `codex.yaml` | Integração de conversa e scripts explícitos | Interface do chat | Nenhuma |
| `location.yaml` | Trackers, fonte escolhida, frescor e raios publicados pelo Node-RED | Rótulos, datas e formatação | Nenhuma; não recalcula distância nem escolhe fonte |
| `raspberry_pi_health.yaml` | Sensores e estados canônicos de infraestrutura | Cards nativos e botões explícitos | Nenhuma |
| `vehicle_primary.yaml` | Estado, localização, refresh, comandos e viagens já classificados | Idades e rótulos de apresentação | Nenhuma; wake, backoff, cooldown e efeitos pertencem ao Node-RED |

Os arquivos `homeassistant/www/codex-chat-card*.js` são componentes de interface:
mantêm rascunho/histórico visual e enviam ações explícitas do usuário. Eles não
produzem dados residenciais nem implementam política de automação.

## JavaScript e fontes geradoras no baseline

Os 244 nós `function` somavam responsabilidades de adaptação, normalização,
decisão, configuração, estado e efeito. As maiores concentrações eram:

| Tab | Função | Linhas aproximadas | Classificação de migração |
| --- | --- | ---: | --- |
| `contexto_vehicle_primary` | Normalizar veículo e detectar transições | 848 | Separar normalização, geografia, mudança semântica e lifecycle. |
| `localizacao_pessoas` | Normalizar pessoas e detectar transições | 1.181 | Separar envelope, fonte, seleção, geografia, transição e chegada. |
| `contexto_vehicle_primary` | Coordenar refresh | 530 | Manter apenas máquina de estado mínima; externalizar política e rotas. |
| `contexto_chegadas` | Coordenar snapshot e refresh | 415 | Converter coordenação em blocos e deixar apenas merge estrutural. |
| `iluminacao_seguranca` | Decisão e merge de contexto | 325/340 | Separar estado derivado de cada gate e roteá-lo visualmente. |
| `storage_health` | Diagnóstico, tendência e autocuidado | 188 | Separar cálculo de tendência das políticas de ação. |
| `monitoramento_tuya` | Falha/retorno por dispositivo | 207 | Externalizar timers e rotas; manter mapa de dispositivos. |
| `observabilidade_global` | Classificar erro/status | 244 | Externalizar severidade, confirmação, dedupe e efeitos. |

Há 50 arquivos em `nodered/tools/functions/*.js`. Eles são carregados pelos
geradores de observabilidade, veículo, iluminação de segurança, VPN, guardião
de memória e recovery RTX, e pelos respectivos testes. Os demais corpos estão
embutidos nos geradores/migradores ou diretamente no artefato legado.

As fontes de reconstrução são atualmente incrementais e sobrepostas:

- geradores `install-*-flow.mjs` para retenção, revisão semanal, backup,
  storage, infraestrutura, veículo, VPN, atualizações, alertas Codex, guardião,
  RTX e observabilidade;
- migradores `update-*.mjs` para localização, notificações de residentes,
  veículo e iluminação de segurança;
- organizadores/correções `configure-*`, `split-*`, `organize-*`, `fix-*` e
  `refactor-*` para tabs legados.

Cada tab migrado deve ganhar uma fonte idempotente inequívoca. Correções antigas
podem continuar disponíveis para histórico/compatibilidade, mas não podem
sobrescrever a representação canônica na próxima regeneração.

## Valores operacionais encontrados

O baseline contém valores visíveis somente em quatro políticas (localização e
refresh do veículo) e muitos valores ainda embutidos. A migração deve cobrir,
entre outros:

- localização: raios `home`/`near_home`/refresh, precisão, frescor, empate de
  recência, movimento e retenção de chegada;
- veículo: intervalos por presença, pausa noturna, janela causal, rechecks,
  leases, cooldowns de comandos e backoff do provedor;
- segurança: escuridão, disponibilidade, carência e backstop do refletor,
  pendência da confirmação do alarme e retries;
- infraestrutura: cadências de coleta, quantidade de falhas/sucessos,
  confirmação de queda/recuperação, lembretes e cooldowns;
- host: thresholds térmicos, CPU/load/memória/swap/storage, hysteresis, retries
  e ownership;
- manutenção: agendamentos, intervalos de polling, cooldowns, filas, retenção,
  tendência e autocuidado;
- notificações: destinatários, severidade, confirmação, dedupe, resumo e
  recovery;
- portão: dedupe, cooldown e duração do pulso.

Valores inválidos devem ser rejeitados antes de substituir a última política
persistente válida. O canvas, e não este documento, é a fonte do valor padrão.

## Contrato comum da migração

Cada domínio alterado deve mostrar, da esquerda para a direita: entradas,
normalização, política visual, decisões, gates de segurança, estado/dedupe,
efeitos, confirmação, observabilidade e testes. Funções remanescentes não podem
chamar efeitos; recebem a política em `msg.policy`, produzem decisão estruturada
e possuem teste. Produção e `test_mode` compartilham o caminho até o gate final;
o teste termina com `simulated: true` e `dispatched: false`.

## Progresso verificado desta migração

| Domínio | Situação | Evidência principal |
| --- | --- | --- |
| `garagem` | Migrado e implantado | Política visual de dedupe/cooldown/pulso/coalescência, gates produção/teste, replay e render estrito |
| `alarme_casa` | Migrado e implantado | Intenção, retry, cadência de aviso e gates visuais; scripts HA passaram a emitir intenção canônica |
| `alertas_codex` | Migrado e implantado | Thresholds/cooldowns visuais; nível canônico publicado pelo Node-RED e dashboard somente consumidor |
| `recorder_retention` | Migrado e implantado | Sete parâmetros validados, rotas de compactação e efeitos visíveis; cálculo MAD isolado |
| `recuperacao_rtx` | Migrado e implantado | Leitura passiva, pedido explícito, cooldown e gate MCP visíveis; computador desligado silencia, computador ligado com endpoint indisponível alerta uma vez e a recuperação encerra o alerta persistente; nenhum recovery automático |
| `revisao_documental_semanal` | Migrado e implantado | Origem, teste, resposta e código da ponte em switches; worker preservado |
| `backup_git` | Migrado e implantado | Pedido, resultado, retry, updates e notificações em trilhas visuais e full dry-run |
| `guardiao_memoria_host` | Migrado e implantado | Agendas/timeout explícitos, 12 switches de decisão, dedupe persistente isolado e replay completo com duplicata; maior função abaixo de 2.000 caracteres |
| `notificacoes_chegadas_residentes` | Migrado e implantado | Quatro parâmetros visuais, 14 decisões nomeadas, lifecycle persistente, serviços por destinatário e todos os testes em dry-run |
| `monitoramento_internet` | Migrado e implantado | Alvos/quorum/timeouts/contagens visuais, estado persistente, ICMP isolado, recuperação automática e idempotente do App Server do Codex e replay dry-run; Tailscale continua isolado no tab de VPN |
| `monitoramento_zigbee` | Migrado e implantado | Queda/retorno/lembrete visuais, dedupe por componente, estado persistente, efeito único e replay integral dry-run; runtime recompôs retained sem alerta falso |
| `monitoramento_tuya` | Migrado e implantado | Coleta HA, split/join, timers, dedupe, resumo e fronteiras visíveis; runtime saudável após dois ciclos e somente o correlacionador estrutural excede 2.000 caracteres |
| `contexto_chegadas` | Migrado e implantado | Agenda, coalescência, validação monotônica, precedência e recovery em blocos visuais; contratos de link preservados, replay completo e maior função residual abaixo de 2.000 caracteres |
| `monitoramento_vpn` | Migrado e implantado | Quatro tempos validados, supressão causal, confirmação, dedupe e recovery visuais; maior função de política removida e replay integral dry-run |
| `alarme_desarme_chegada` | Migrado e implantado | Contrato, armado, pendência, cooldown, entrega, token, expiração, cancelamento e confirmação visíveis; duas notificações só promovem a pendência após aceite HA e o TESTE termina sem desarme |
| `storage_health` | Migrado e implantado | Onze parâmetros validados, thresholds/histerese/tendência/recovery/autocuidado visuais, zero fios longos ou de retorno e workers privilegiados atrás do gate dry-run |
| `localizacao_pessoas` | Migrado e implantado | Lifecycle, direção, fonte, stale/futuro, dedupe e recovery separados em fatos e switches; política única compartilhada e replay sem efeitos |
| `contexto_vehicle_primary` | Migrado e implantado | Localização, chegada, evidência, refresh e comandos remotos divididos em trilhas visuais; intents do dashboard passam por disponibilidade, concorrência, produção/teste, efeito e falha; o coordenador legado de 19 KiB foi removido |
| `iluminacao_seguranca` | Migrado e implantado | Política de nove parâmetros, contexto/replay, chegada, disponibilidade, lifecycle, recovery e bypass com posse explícita em gates visuais |
| `iluminacao_externa` | Migrado e implantado | Disponibilidade Zigbee, produção/teste e confirmação visíveis; settle e TTL validados; MQTT, push e Alexa bloqueados no replay manual |
| `observabilidade_global` | Migrado e implantado | Cinco parâmetros validados; erro/status, carência, corroboração, confirmação e lembrete em switches; guard antirrecursão preservado |
| `atualizacoes_diarias` | Migrado e implantado | DietPi → Core → demais containers → Codex CLI → dependências npm serializados; `update.*` classificado visualmente entre Bluelink, HACS versionado, firmware e desconhecido; parsers remanescentes apenas adaptam estruturas e contratos sanitizados |
| `resfriamento_raspberry_pi` | Auditado e preservado | Thresholds, janelas, delays, leituras, ownership, serviços, confirmação e rollback são nós nomeados; funções pequenas mantêm somente a transação de recovery |

## Auditoria final do JavaScript remanescente

Após a regeneração há 562 nós `function`; somente seis excedem 5.000
caracteres. Nenhum deles chama um efeito residencial nem contém uma segunda
definição de parâmetro ajustável:

| Função | Motivo técnico para permanecer em JavaScript |
| --- | --- |
| Erro da API do `vehicle_primary` | Adapta exceções heterogêneas do provedor, extrai endpoint/estágio e atualiza evidência estrutural para os gates visuais. |
| Coordenador dos testes de localização | Mantém exclusivamente o cenário sintético cumulativo; nunca é executado na trilha de produção. |
| Classificação geográfica de pessoas | Cálculo geográfico, precisão e normalização de múltiplos trackers; os raios vêm da política visual. |
| Telemetria do refresh do veículo | Serialização MQTT/Home Assistant do estado já decidido; não escolhe intervalo nem autoriza chamadas. |
| Fatos do refresh do veículo | Consolida estado persistente e produz flags; cada decisão correspondente aparece nos switches subsequentes. |
| Ingestão do observador global | Normaliza envelopes heterogêneos de `catch`, `status` e alertas de domínio; severidade, confirmação, dedupe e efeitos permanecem em blocos visuais externos. |

Também foram removidos os arquivos legados que continham os coordenadores
monolíticos de refresh do veículo, merge/chegada da iluminação, bypass do motor
e ingestão/avaliação do observador global. Os geradores novos são idempotentes,
os contratos e IDs externos foram preservados e o canvas é a representação
canônica das políticas operacionais.

## Validação e implantação final

- O artefato final contém 2.457 nós, 24 tabs cobertos pelo manifesto de testes
  e 23 tabs funcionais observados pelo monitor global.
- A suíte pública do Node-RED passou em 37 arquivos. Os replays materiais
  incluem 50 cenários normais, 48 de recovery e 23 adversariais para segurança,
  além de 57 cenários do scheduler de refresh do veículo.
- Os 25 canvases versionados foram renderizados em modo estrito, todos sem
  fios acima de 500 px nem fios de retorno. A inspeção visual também confirmou
  grupos contidos, ausência de sobreposição e direção de leitura consistente.
- A configuração do Home Assistant e seus 129 testes passaram. A matriz pública
  restante passou nos validadores de segurança, privacidade, memória, bridge,
  scripts, scheduler, restore, bootstrap, demo, módulos e Git.
- Node-RED e Home Assistant foram reiniciados separadamente e de modo incremental
  para carregar, respectivamente, os fluxos e os produtores/correções do HA.
  MQTT e Zigbee2MQTT permaneceram disponíveis; as interfaces HTTP do Home
  Assistant e do Node-RED responderam `200` após o deploy.
- A primeira verificação de startup revelou uma janela em que o observador
  chamava `node.error` antes de carregar sua política visual e emitia alertas
  internos. O gate passou a aguardar a política em modo fail-closed, ganhou
  regressão dedicada e dois restarts posteriores ficaram sem a rajada.
- Os replays sintéticos permaneceram em dry-run. O teste real autorizado do
  intent de travamento percorreu dashboard/HA, decisões e efeito Node-RED até
  confirmação física `locked`; nenhum outro dispositivo foi acionado pelos
  testes. Não houve remoção de entidades, históricos, identificadores, tópicos
  ou dados persistentes.
