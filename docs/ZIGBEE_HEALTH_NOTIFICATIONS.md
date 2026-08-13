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

Os calls usam fila `all` do conector do Home Assistant. Assim, uma reinicialização
curta do Home Assistant não faz o Node-RED manter listas alternativas de
celulares nem mover a decisão de notificar para uma automação.

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
repeti-la.

## Dashboard

O dashboard `Raspberry Pi - System Health` mostra os quatro estados e os
atributos de última queda/recuperação. A interface é somente leitura.

## Validação

Validação estática e simulação das máquinas de estado:

```bash
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:test-infrastructure
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
```

O teste automatizado cobre internet normal, um destino falho, três falhas,
queda única, offline prolongado, recuperação inicial, oscilação, recuperação
confirmada, duração, segunda queda, restart com incidente, startup Zigbee,
falha momentânea, 30 segundos offline, dedupe, 60 segundos online e ciclo de
componente.

Para validar MQTT ponta a ponta sem desligar a rede real, publique `offline` e
depois `online`, ambos retained, em um tópico fictício como
`zigbee2mqtt/teste_monitor/availability`; apague o retained ao terminar. A
validação física de corte da internet, reinício do roteador e entrega do push
nos dois celulares exige janela controlada no local.

## Limitações

- ICMP pode ser filtrado por uma operadora ou pelos três destinos, embora a
  diversidade e o quórum reduzam esse risco.
- Push de queda da própria internet pode ser entregue somente quando o canal
  externo voltar; a notificação persistente é criada localmente no HA.
- Os testes automatizados simulam estados e não desligam roteador, coordenador
  ou acesso WAN reais.
