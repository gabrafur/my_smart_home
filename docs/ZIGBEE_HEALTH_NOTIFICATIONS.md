# Monitoramento de infraestrutura no Node-RED

[Português (principal)](ZIGBEE_HEALTH_NOTIFICATIONS.md) ·
[English](ZIGBEE_HEALTH_NOTIFICATIONS.en.md)

Os flows `monitoramento_zigbee`, `monitoramento_tuya` e
`monitoramento_internet`, em `nodered/flows.json`, são a fonte da lógica de
disponibilidade da casa. O Home Assistant recebe estados por MQTT discovery e
executa os serviços de notificação, mas não detecta, confirma nem encerra
incidentes.

O antigo package
`homeassistant/packages/zigbee_health_notifications.yaml` foi removido. Não
deve existir uma segunda automação de disponibilidade no Home Assistant.

## Arquitetura comum

As abas são separadas por domínio e organizadas da esquerda para a direita:

```text
gatilho -> coleta -> avaliação/estado -> queda ou retorno -> notificação
                              `-> MQTT retained -> Home Assistant
```

Cada monitor separa visualmente a mesma decisão em chamadas independentes aos
três [hubs canônicos de notificação](NODERED_NOTIFICATION_HUBS.md). Para cada
evento ele:

1. cria ou atualiza uma notificação persistente no Home Assistant;
2. faz duas chamadas independentes ao hub móvel, uma para
   `resident_primary` e outra para `resident_secondary`, sem fallback;
3. anuncia o título e a mensagem na Echo Dot pelo binding lógico
   `mobile_primary/notify`, já usado pelos avisos Alexa do repositório;
4. em uma recuperação, remove o alerta persistente da falha anterior.

Nenhum entity ID da Echo é gravado no flow. O destino real continua na
configuração privada de bindings.

O envelope do monitor é adaptado, em cada ramo, ao contrato do respectivo hub:

```javascript
msg.notification = {
  id: "identificador obrigatório",
  title: "título obrigatório",
  message: "mensagem obrigatória",
  dismiss_id: "alerta anterior opcional"
}
```

Os hubs apenas validam, roteiam e entregam. Estado, retry e deduplicação
continuam pertencendo ao monitor que os chamou.

Os calls usam fila `all` do conector do Home Assistant. Essa fila só protege a
chamada enquanto a conexão do Node-RED com o Home Assistant está indisponível;
ela não é uma fila de entrega de push durante uma queda da WAN.

### Push quando a WAN está indisponível

Node-RED e Home Assistant continuam se comunicando pela rede local. Portanto, a
chamada de serviço é aceita e a ramificação independente de
o hub persistente chama `persistent_notification.create` e cria o alerta local
mesmo sem internet.

O comportamento do push do Home Assistant Mobile App depende do canal ativo:

- se o aplicativo estiver conectado ao Home Assistant pela mesma LAN e com
  Local Push/WebSocket disponível, a entrega local pode ocorrer sem WAN;
- fora desse caso, a entrega passa pelo serviço remoto do Mobile App e exige
  acesso à internet. O Home Assistant espera por confirmação do canal local por
  cerca de 10 segundos antes do fallback remoto, e o request remoto também tem
  timeout curto. Erros são registrados, mas a notificação não fica em uma fila
  durável do Home Assistant para novo envio quando a WAN voltar.

Assim, durante uma indisponibilidade total, cada serviço mobile recebe uma
tentativa, mas não se deve prometer push imediato nem posterior. Na recuperação,
Node-RED envia uma nova notificação de restabelecimento. Uma tentativa de queda
que falhou dentro do Home Assistant não é automaticamente reenviada depois e,
normalmente, somente a recuperação chegará pelo canal remoto. Ainda assim, se o
provedor externo já tiver aceitado a primeira mensagem ou o sistema operacional
atrasar sua exibição, a ordem percebida no telefone não pode ser garantida. Não
há confirmação de apresentação nem controle de ordenação no contrato do Mobile
App; essa limitação é documentada em vez de adicionar lógica de retry ambígua.

## Internet

### Coleta e critérios

A cada 30 segundos, um único ciclo executa simultaneamente um ping ICMP para:

- `1.1.1.1` (Cloudflare);
- `8.8.8.8` (Google);
- `9.9.9.9` (Quad9).

São IPs de três operadores diferentes. Nenhum hostname ou consulta DNS
participa da decisão. Um ciclo é positivo quando pelo menos **2 de 3** destinos
respondem. A falha de apenas um host não derruba o estado. Um lock no contexto
`memoryOnly`, timeout de 3 segundos por processo e limpeza do lock no fim do
ciclo impedem sobreposição, timers acumulados e mais de três processos `ping`
simultâneos.

Esses valores agora aparecem no grupo de política do canvas. O JSON visual
contém os três alvos, quorum 2, três ciclos para queda, dois para retorno,
timeout ICMP de 2 s e limite de execução de 3 s. Quorum aceita 1–3,
confirmações aceitam 1–10 ciclos, ping aceita 1–10 s e execução aceita
1–15 s, sempre maior que o timeout do ping. O validador rejeita candidatos
inválidos sem substituir a última política persistente válida.

Os endereços foram conferidos nas páginas oficiais do
[Cloudflare 1.1.1.1](https://developers.cloudflare.com/1.1.1.1/),
[Google Public DNS](https://developers.google.com/speed/public-dns/) e
[Quad9](https://docs.quad9.net/services/).

A máquina possui os estados `online`, `checking`, `offline` e `recovering`:

- `online -> checking`: primeiro ciclo com menos de duas respostas;
- `checking -> offline`: terceiro ciclo negativo consecutivo;
- `offline -> recovering`: primeiro ciclo positivo;
- `recovering -> online`: segundo ciclo positivo consecutivo;
- uma nova falha durante `recovering` volta a `offline` sem gerar outro alerta.

Quorum, incidente aberto, contadores exatos e abertura/recuperação são
`switch` nomeados. O JavaScript restante apenas executa o adaptador assíncrono
de ICMP, normaliza resultados, aplica mutações já escolhidas visualmente,
persiste o estado e monta os contratos MQTT/notificação.

Com a cadência atual, uma queda é confirmada em aproximadamente 60–90 segundos
e uma recuperação em 30–60 segundos. Enquanto offline, o mesmo ciclo de 30
segundos continua; não existe loop de retry adicional.

Cada incidente produz uma notificação de queda e, somente depois de uma queda
confirmada, uma notificação de retorno. O horário salvo é o primeiro ciclo
falho, e a recuperação inclui a duração aproximada da indisponibilidade.

### Entidades publicadas

O flow publica configuração e estado retained no Mosquitto:

- `binary_sensor.internet_connection`;
- `sensor.internet_connection_state`.

Os atributos incluem destinos respondendo, falhas/sucessos consecutivos,
último ping válido, última queda, última recuperação e duração da última queda.
O dashboard de saúde apenas apresenta essas entidades; ele não contém lógica.

## Zigbee

### Ponte Zigbee2MQTT

O flow usa diretamente `zigbee2mqtt/bridge/state` e o status da conexão MQTT.
Isso elimina a dependência operacional da antiga entidade intermediária
`binary_sensor.zigbee2mqtt_bridge_connection_state`.

Os critérios são complementados pela [política de retomada](NODERED_STARTUP_RECOVERY.md):

- depois da carência inicial de 180 s, `offline`, broker desconectado ou
  estado ainda desconhecido por 30 segundos confirma a queda;
- `online` contínuo por 60 segundos confirma a recuperação;
- `online` retained no startup estabelece apenas o estado inicial e não gera
  falsa recuperação;
- um incidente aberto não duplica a queda dentro da janela e, se continuar
  aberto, atualiza o mesmo alerta e repete push/voz a cada 24 horas.

Os três valores aparecem no grupo `CONFIG` do canvas: queda 30 s (limite
1–300 s), retorno 60 s (1–600 s) e lembrete 24 h (1–168 h). Um candidato
inválido é rejeitado sem substituir a última política persistente válida. Os
`switch` nomeados mostram estado bruto, incidente aberto, limites exatos,
lembrete vencido e tipo de evento; a agenda nativa de 10 s também fica visível.

O estado é exposto como:

- `binary_sensor.zigbee_network`;
- `sensor.zigbee_network_state`.

Os atributos registram estado bruto, tempo estável, confirmação configurada,
última queda, recuperação e duração.

### Componentes

Mensagens retained em `zigbee2mqtt/.../availability` continuam cobrindo
automaticamente dispositivos novos e friendly names com `/`. Para cada
componente, o Node-RED persiste se há incidente aberto:

- `offline` confirmado por 30 s, com ponte estável: uma notificação;
- `offline` repetido: ignorado;
- `online` contínuo por 60 s após o incidente: uma recuperação;
- `online` no startup sem incidente: ignorado.

Enquanto o componente permanecer offline, o tick periódico da aba repete o
mesmo alerta a cada intervalo configurado. A enumeração do mapa persistente é
um adaptador estrutural pequeno; os blocos visuais decidem se o componente
continua offline, se o prazo venceu e se deve abrir, tocar, recuperar ou
lembrar o incidente. Todas as notificações convergem em uma única instância do
subflow compartilhado.

O JavaScript remanescente nesta aba só adapta MQTT, gera uma chave estável a
partir do tópico, lê/aplica a mutação já escolhida, enumera o mapa de
componentes e monta MQTT/discovery/notificação. Exceto os dois adaptadores atômicos documentados na política de retomada, as
funções têm menos de 2.000 caracteres e não contém thresholds nem roteamento de efeito. O lembrete não
depende de nova mensagem MQTT; a recuperação encerra o agendamento.

O identificador da notificação combina um slug legível com um hash estável do
friendly name completo. Assim, caminhos como `andar1/cozinha/sensor` são
preservados na mensagem e não colidem com nomes diferentes que gerariam o mesmo
slug, como `andar1-cozinha/sensor`.

A carência inicial é de 180 s e a ponte deve estar online por 60 s antes de
avaliar componentes. O tick reavalia os estados observados; uma oscilação reinicia
a confirmação sem encerrar o incidente. A recuperação de `NWK_NO_ROUTE` exige
comunicação nova após 300 s de estabilidade; o aceite isolado de configure não
é suficiente. Veja o
[contrato de retomada e recuperação de rotas](NODERED_STARTUP_RECOVERY.md).

Requer no arquivo privado do Zigbee2MQTT:

```yaml
availability:
  enabled: true
```

## Tuya e LocalTuya

O flow `monitoramento_tuya` não contém uma lista privada de entidades. A cada
30 segundos ele consulta, pela conexão WebSocket já configurada entre Node-RED
e Home Assistant:

- o registro de entidades;
- o registro de dispositivos;
- os estados atuais.

Entidades habilitadas das plataformas `tuya` e `localtuya` são agrupadas por
dispositivo. Entidades `button` e `event` não são usadas como prova de saúde,
pois normalmente permanecem `unknown` mesmo quando o dispositivo está online.
Um dispositivo sem nenhuma outra entidade observável não entra no monitor.

O dispositivo é considerado disponível quando ao menos uma entidade observável
tem estado diferente de `unknown` e `unavailable`. Quando todas estão
indisponíveis, a queda precisa permanecer por 30 segundos para abrir o
incidente. O retorno precisa permanecer estável por 60 segundos. Cada
dispositivo tem deduplicação e contexto persistente próprios; o identificador
da notificação usa um hash estável do ID do registro, enquanto a mensagem usa o
nome atual do dispositivo no Home Assistant. Assim, o comedouro e novos
dispositivos Tuya passam a ser descobertos sem gravar seus IDs no repositório.
Um incidente que continuar aberto atualiza o mesmo alerta e repete push e voz a
cada 24 horas; a recuperação confirmada encerra os lembretes.

Queda 30 s (limite 1–300), retorno 60 s (1–600) e lembrete 24 h (1–168)
ficam no grupo de configuração visual. O canvas mostra validação, presença de
fonte, existência de dispositivo, split/join do ciclo, estado bruto, incidente,
limites exatos, lembrete, resumo agregado, produção/teste e efeito único. Uma
configuração inválida não substitui a última versão persistente válida.

O único JavaScript acima de 2.000 caracteres é o adaptador estrutural de 2.052
caracteres que correlaciona três respostas heterogêneas do Home Assistant,
agrupa entidades por `device_id`, exclui domínios não confiáveis e cria a chave
estável. Dividi-lo entre nós nativos perderia atomicidade e legibilidade. Ele
não decide tempo, incidente, dedupe, recuperação, resumo nem efeito; todas as
demais funções da aba têm menos de 2.000 caracteres.

Uma falha na própria consulta ao Home Assistant publica `checking`, mas não
abre nem encerra incidentes de dispositivos. Isso evita interpretar uma queda
do canal de observação como falha simultânea de todos os equipamentos.

MQTT discovery expõe:

- `binary_sensor.tuya_devices`;
- `sensor.tuya_devices_state`.

Os atributos incluem quantidades monitoradas e indisponíveis, nomes dos
dispositivos atualmente offline, plataformas, limiares e horários da última
queda e recuperação confirmadas.

## Restart e persistência

`nodered/settings.js` define dois armazenamentos de contexto:

- `default`/`memoryOnly`: memória volátil para o estado derivado comum, locks de
  execução e observações brutas recebidas novamente por MQTT retained;
- `persistent`: `localfilesystem`, com flush a cada 30 segundos. Os monitores
  optam explicitamente por esse store para incidentes, horários, contadores e
  deduplicação.

O estado `nodered/status` também usa birth, close e last will retained. Assim,
as entidades ficam indisponíveis quando o Node-RED sai do broker.

Comportamentos esperados:

- Node-RED inicia com internet online: estabelece baseline, sem recuperação;
- inicia offline: três ciclos confirmam a queda;
- reinicia durante incidente persistido: não duplica a queda e confirma a
  recuperação quando houver dois ciclos positivos;
- Home Assistant reinicia: MQTT discovery/estado retained recompõem as
  entidades; serviços são enfileirados durante indisponibilidade curta;
- Zigbee2MQTT reinicia: a ponte precisa ficar offline por 30 segundos para
  alertar e online por 60 segundos para recuperar;
- Node-RED reinicia durante uma queda Tuya confirmada: não duplica a queda e
  reinicia apenas a janela volátil de 60 segundos que confirma o retorno;
- roteador reinicia: pings continuam na cadência normal.

O payload MQTT retained de atributos também funciona como cópia de segurança
da última queda confirmada, recuperação e duração. No startup, o monitor
restaura esses campos históricos antes de publicar dados novos, evitando que a
ausência do arquivo de contexto substitua timestamps conhecidos por valores
nulos. Se nunca houve incidente confirmado, o Home Assistant mostra uma
mensagem explícita de ausência de evento em vez de `Unknown`.

Uma interrupção abrupta nos até 30 segundos entre gravações pode perder a
última transição de contexto. Esse é o risco residual do cache em arquivo; não
há banco externo. MQTT retained e os limiares reduzem falsos positivos no
startup, mas um crash exatamente após uma notificação e antes do flush pode
repeti-la. Um crash logo depois de abrir um incidente também pode fazer o
runtime voltar ao último estado persistido e confirmar/notificar novamente; um
crash logo depois da recuperação pode recompor o incidente anterior até a nova
observação. Reduzir o flush diminuiria, mas não eliminaria, essa janela.

## Dashboard

O dashboard `Raspberry Pi - System Health` continua mostrando os quatro estados
de internet e Zigbee. As duas novas entidades Tuya ficam disponíveis para cards
diagnósticos sem colocar lógica de incidente no dashboard.

## Validação

Validação estática e simulação das máquinas de estado:

```bash
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:test-internet-monitor
npm --prefix nodered run flows:test-zigbee-monitor
npm --prefix nodered run flows:test-tuya-monitor
npm --prefix nodered run flows:test-infrastructure
npm --prefix nodered run flows:test-infrastructure-runtime
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
```

O replay manual de internet usa reset, três falhas e dois sucessos, atravessa o
mesmo quorum, estado, limiares e gates, e termina com MQTT e notificações em
dry-run. O teste automatizado estático cobre internet normal, um destino falho, três
falhas, queda única, offline prolongado, recuperação inicial, oscilação,
recuperação confirmada, duração, segunda queda, restart com incidente, startup
Zigbee, falha momentânea, 30 segundos offline, dedupe, 60 segundos online,
ciclo e lembrete de 24 horas de componente, lembrete de 24 horas da rede,
descoberta/queda/recuperação/lembrete de dispositivos Tuya e LocalTuya e a
ramificação de voz da Echo Dot. O replay de runtime executa os corpos exatos
das funções versionadas com stores `memoryOnly` e `persistent` isolados. Ele
força flapping, duplicidade, limites exatos e recria o contexto volátil para
provar recovery após restart sem abrir containers nem se conectar ao MQTT ou
Home Assistant de produção.

Para validar MQTT ponta a ponta sem desligar a rede real, publique `offline` e
depois `online`, ambos retained, em um tópico fictício como
`zigbee2mqtt/teste_monitor/availability`; apague o retained ao terminar. A
validação física de corte da internet, reinício do roteador, restart real do
Zigbee2MQTT e entrega do push nos dois celulares exige janela controlada no
local.

## Registro parcial da validação física (2026-08-13)

| Cenário | Tipo de teste | Resultado observado | Evidência resumida | Status |
| --- | --- | --- | --- | --- |
| Corte físico da WAN | Físico | Não executado até o fim | Uma tentativa foi invalidada por um restart do host e perda do observador temporário; a repetição foi cancelada pelo usuário para preservar a conectividade da sessão do Codex. | PENDENTE |
| Retorno real da WAN | Físico | Não executado | Não existe queda física válida correspondente. | PENDENTE |
| Restart real do roteador | Físico | Não executado | Exige nova janela que permita perder a conectividade externa. | PENDENTE |
| Restart real do Zigbee2MQTT | Físico | Startup transitório abaixo do threshold, sem incidente | `bridge/state` ficou offline às 19:52:24 UTC e voltou online às 19:52:37 UTC (cerca de 13 s); o monitor passou por `checking`, recompôs o estado retained e permaneceu online por mais de 90 s, sem alerta ou falsa recuperação. | PASS |
| Entrega no iPhone de resident_primary | Físico/manual | Não observada | Nenhum incidente físico confirmado ultrapassou o threshold. | PENDENTE |
| Entrega no iPhone de resident_secondary | Físico/manual | Não observada | Nenhum incidente físico confirmado ultrapassou o threshold. | PENDENTE |
| Ordem das notificações | Físico/manual | Não observada | Depende de uma queda WAN válida e da anotação manual dos dois aparelhos. | PENDENTE |

O deploy físico também mostrou que o Home Assistant 2026.x prefixava o nome do
dispositivo nos IDs sugeridos apesar de `object_id`. Os quatro payloads de
discovery agora declaram `default_entity_id`; após republicação, as entidades
reais foram registradas exatamente como `binary_sensor.internet_connection`,
`sensor.internet_connection_state`, `binary_sensor.zigbee_network` e
`sensor.zigbee_network_state`. Um teste automatizado protege esses IDs.

Este registro é parcial. Os itens `PENDENTE` acima não são `PASS`, e a pull
request deve continuar Draft até uma janela física com observabilidade
persistente concluir WAN, roteador e entrega móvel.

## Checklist operacional dos testes físicos pendentes

Execute um teste por vez, com acesso local ao equipamento e um limite de cinco
minutos para restauração manual.

### Corte físico da WAN

1. **Preparação:** confirme os dois monitores online, abra o editor/log do
   Node-RED e o dashboard do HA; preserve acesso local ao roteador.
2. **Ação:** desconecte somente o cabo WAN, sem desligar LAN, HA ou Node-RED.
3. **Esperado:** após três ciclos negativos, `checking -> offline`, um único
   incidente; após reconectar, `recovering -> online` em dois ciclos positivos.
4. **Node-RED:** observe os status dos nodes de ping/estado e ausência de eventos
   duplicados.
5. **Home Assistant:** observe `binary_sensor.internet_connection`, a duração e
   a notificação persistente local.
6. **Notificação:** registre separadamente o recebimento em cada iPhone e se foi
   Local Push; push remoto durante a queda não é requisito de aprovação.
7. **Restauração:** reconecte o cabo imediatamente se LAN/automação for afetada
   ou ao atingir cinco minutos.
8. **Aprovação:** thresholds, dedupe, alerta local e recuperação corretos; anote
   a ordem real dos pushes sem tratá-la como garantia.

### Restart do roteador

1. **Preparação:** confirme acesso físico, configuração salva e uma forma de
   religar o equipamento sem depender da internet.
2. **Ação:** faça um único restart normal do roteador.
3. **Esperado:** a perda será confirmada somente se exceder três ciclos; a volta,
   somente após dois ciclos positivos.
4. **Node-RED:** observe continuidade do timer, liberação do lock e no máximo
   três processos de ping por ciclo.
5. **Home Assistant:** observe indisponibilidade/recomposição das entidades sem
   automação Zigbee paralela.
6. **Notificação:** no máximo um par queda/recuperação por iPhone se os thresholds
   forem cruzados; caso contrário, nenhuma.
7. **Restauração:** aguarde o boot normal; se não voltar em cinco minutos, ligue
   novamente ou restaure alimentação conforme o procedimento do equipamento.
8. **Aprovação:** automações retornam, não há duplicação e o estado final é
   online.

### Restart real do Zigbee2MQTT

1. **Preparação:** confirme bridge online, dispositivos disponíveis e acesso ao
   comando normal de restart; não desligue o coordenador.
2. **Ação:** reinicie somente o serviço/container Zigbee2MQTT.
3. **Esperado:** LWT/broker/`bridge/state` representam a transição; queda abaixo
   de 30 segundos é silenciosa, e uma queda confirmada recupera após 60 segundos
   online contínuos.
4. **Node-RED:** observe os nodes de entrada MQTT, avaliação da ponte e retained
   recebidos no startup.
5. **Home Assistant:** observe `binary_sensor.zigbee_network` e
   `sensor.zigbee_network_state` sem falso retorno no startup.
6. **Notificação:** nenhuma para restart curto; para restart longo, exatamente
   uma queda e uma recuperação por iPhone, além do alerta persistente.
7. **Restauração:** inicie o serviço pelo compose; se não ficar saudável em cinco
   minutos, reverta ao comando/configuração anterior e preserve o coordenador.
8. **Aprovação:** birth/LWT e retained recompõem o estado sem falso incidente ou
   duplicação.

### Entrega nos dois iPhones

1. **Preparação:** identifique os dois aparelhos, habilite notificações do app e
   registre se cada um está em Local Push ou push remoto.
2. **Ação:** aproveite um incidente físico controlado acima, sem criar outro
   mecanismo de alerta.
3. **Esperado:** cada evento gera uma tentativa para cada serviço mobile; entrega
   efetiva depende do canal e da conectividade descritos anteriormente.
4. **Node-RED:** observe uma única passagem pelo subflow por queda e recuperação.
5. **Home Assistant:** confira os service calls e logs de `mobile_app`, além da
   notificação persistente.
6. **Notificação:** anote aparelho, horário, título, canal e ordem de chegada;
   confirme ausência de duplicatas.
7. **Restauração:** restabeleça WAN/celular e confirme que ambos os apps voltaram
   a conectar ao HA.
8. **Aprovação:** os dois serviços são chamados uma vez por evento, a entrega
   observada está registrada e qualquer atraso/ordem inversa é classificado como
   limitação do canal, não como entrega garantida.

## Limitações

- ICMP pode ser filtrado por uma operadora ou pelos três destinos, embora a
  diversidade e o quórum reduzam esse risco.
- Sem Local Push ativo, o push de queda depende da WAN e pode ser descartado;
  não há fila durável para entregá-lo depois. A notificação persistente é criada
  localmente no HA.
- Os testes automatizados simulam estados e não desligam roteador, coordenador
  ou acesso WAN reais.
