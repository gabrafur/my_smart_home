# Monitoramento de infraestrutura no Node-RED

[Português (principal)](ZIGBEE_HEALTH_NOTIFICATIONS.md) ·
[English](ZIGBEE_HEALTH_NOTIFICATIONS.en.md)

Os flows `monitoramento_zigbee` e `monitoramento_internet`, em
`nodered/flows.json`, são a fonte da lógica de disponibilidade da casa. O Home
Assistant recebe estados por MQTT discovery e executa os serviços de
notificação, mas não detecta, confirma nem encerra incidentes.

O antigo package
`homeassistant/packages/zigbee_health_notifications.yaml` foi removido. Não
deve existir uma segunda automação de disponibilidade no Home Assistant.

## Arquitetura comum

As abas são separadas por domínio e organizadas da esquerda para a direita:

```text
gatilho -> coleta -> avaliação/estado -> queda ou retorno -> notificação
                              `-> MQTT retained -> Home Assistant
```

O subflow `Notificar todos os dispositivos móveis` é reutilizado pelos dois
monitores. Para cada evento ele:

1. cria ou atualiza uma notificação persistente no Home Assistant;
2. envia push para `notify.iphone_de_gabriel_furlan` e
   `notify.iphone_de_valeria`;
3. em uma recuperação, remove o alerta persistente da falha anterior.

O contrato de entrada, também documentado visualmente no subflow, é:

```javascript
msg.notification = {
  id: "identificador obrigatório",
  title: "título obrigatório",
  message: "mensagem obrigatória",
  dismiss_id: "alerta anterior opcional"
}
```

O subflow apenas valida e distribui essa mensagem. Estado, retry e deduplicação
continuam pertencendo ao monitor que o chamou.

Os calls usam fila `all` do conector do Home Assistant. Essa fila só protege a
chamada enquanto a conexão do Node-RED com o Home Assistant está indisponível;
ela não é uma fila de entrega de push durante uma queda da WAN.

### Push quando a WAN está indisponível

Node-RED e Home Assistant continuam se comunicando pela rede local. Portanto, a
chamada de serviço é aceita e a ramificação independente de
`persistent_notification.create` cria o alerta local mesmo sem internet.

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

Os critérios anteriores foram preservados:

- `offline`, broker desconectado ou estado ainda desconhecido por 30 segundos
  confirma a queda;
- `online` contínuo por 60 segundos confirma a recuperação;
- `online` retained no startup estabelece apenas o estado inicial e não gera
  falsa recuperação;
- um incidente aberto não gera outra notificação de queda.

O estado é exposto como:

- `binary_sensor.zigbee_network`;
- `sensor.zigbee_network_state`.

Os atributos registram estado bruto, tempo estável, confirmação configurada,
última queda, recuperação e duração.

### Componentes

Mensagens retained em `zigbee2mqtt/.../availability` continuam cobrindo
automaticamente dispositivos novos e friendly names com `/`. Para cada
componente, o Node-RED persiste se há incidente aberto:

- primeiro `offline`: uma notificação;
- `offline` repetido: ignorado;
- primeiro `online` após o incidente: uma recuperação;
- `online` no startup sem incidente: ignorado.

O identificador da notificação combina um slug legível com um hash estável do
friendly name completo. Assim, caminhos como `andar1/cozinha/sensor` são
preservados na mensagem e não colidem com nomes diferentes que gerariam o mesmo
slug, como `andar1-cozinha/sensor`.

O comportamento legado notificava componente imediatamente após o `offline` do
próprio Zigbee2MQTT. Ele foi preservado para não mudar o critério funcional. A
fragilidade conhecida é não haver uma segunda carência além dos timeouts de
availability do Zigbee2MQTT (normalmente 10 minutos para ativos e 25 horas para
passivos). Uma melhoria futura possível é adicionar uma confirmação curta por
componente, mas deve ser avaliada separadamente porque aumenta o tempo de
alerta.

Requer no arquivo privado do Zigbee2MQTT:

```yaml
availability:
  enabled: true
```

## Restart e persistência

`nodered/settings.js` define dois armazenamentos de contexto:

- `default`: `localfilesystem`, com flush a cada 15 segundos, para incidentes,
  horários, contadores e deduplicação;
- `memoryOnly`: memória volátil, exclusivamente para locks de execução e a
  observação bruta recebida novamente por MQTT retained.

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
- roteador reinicia: pings continuam na cadência normal.

Uma interrupção abrupta nos até 15 segundos entre gravações pode perder a
última transição de contexto. Esse é o risco residual do cache em arquivo; não
há banco externo. MQTT retained e os limiares reduzem falsos positivos no
startup, mas um crash exatamente após uma notificação e antes do flush pode
repeti-la. Um crash logo depois de abrir um incidente também pode fazer o
runtime voltar ao último estado persistido e confirmar/notificar novamente; um
crash logo depois da recuperação pode recompor o incidente anterior até a nova
observação. Reduzir o flush diminuiria, mas não eliminaria, essa janela.

## Dashboard

O dashboard `Raspberry Pi - System Health` mostra os quatro estados e os
atributos de última queda/recuperação. A interface é somente leitura.

## Validação

Validação estática e simulação das máquinas de estado:

```bash
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:test-infrastructure
npm --prefix nodered run flows:test-infrastructure-runtime
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
```

O teste automatizado estático cobre internet normal, um destino falho, três
falhas, queda única, offline prolongado, recuperação inicial, oscilação,
recuperação confirmada, duração, segunda queda, restart com incidente, startup
Zigbee, falha momentânea, 30 segundos offline, dedupe, 60 segundos online e
ciclo de componente. O teste de runtime carrega os corpos exatos das Functions
em containers Node-RED isolados, força flapping e concorrência, verifica erro
síncrono ao criar `ping` e faz restarts reais do container com o contexto
`localfilesystem`. Ele não se conecta ao MQTT ou Home Assistant de produção.

Para validar MQTT ponta a ponta sem desligar a rede real, publique `offline` e
depois `online`, ambos retained, em um tópico fictício como
`zigbee2mqtt/teste_monitor/availability`; apague o retained ao terminar. A
validação física de corte da internet, reinício do roteador, restart real do
Zigbee2MQTT e entrega do push nos dois celulares exige janela controlada no
local.

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
