# Alertas de saúde da rede Zigbee

[Português (principal)](ZIGBEE_HEALTH_NOTIFICATIONS.md) ·
[English](ZIGBEE_HEALTH_NOTIFICATIONS.en.md)

Este guia documenta o package
`homeassistant/packages/zigbee_health_notifications.yaml`. Ele cria alertas
para a indisponibilidade da ponte Zigbee2MQTT e de qualquer componente cuja
disponibilidade seja publicada no MQTT.

## Pré-requisitos

- integração MQTT carregada no Home Assistant;
- integração do Zigbee2MQTT com o Home Assistant habilitada;
- `mqtt.base_topic: zigbee2mqtt` no `configuration.yaml` privado;
- disponibilidade de dispositivos habilitada:

```yaml
availability:
  enabled: true
```

O Zigbee2MQTT desabilita esse recurso por padrão. Com os valores padrão, um
dispositivo ativo é considerado offline depois de 10 minutos sem comunicação;
um dispositivo passivo, normalmente alimentado por bateria, depois de 25 horas.
Esses tempos pertencem ao Zigbee2MQTT, não ao package do Home Assistant.

O package também espera a entidade
`binary_sensor.zigbee2mqtt_bridge_connection_state`, normalmente criada pela
descoberta MQTT. Adapte o `entity_id` se a instalação usar outro nome.

## Comportamento

### Falha da rede

A automação `zigbee_network_failure_notification` aguarda 30 segundos de
estado `off` ou `unavailable`. Ela também verifica o estado 30 segundos após o
Home Assistant iniciar. Quando há falha:

1. cria ou atualiza a notificação persistente `zigbee_network_failure`;
2. tenta enviar push aos `notify.*` configurados;
3. espera a ponte permanecer `on` por um minuto;
4. remove o alerta de falha e informa a recuperação.

A recuperação faz parte da mesma execução que registrou a falha. Isso evita
uma falsa mensagem de “rede recuperada” toda vez que o Home Assistant inicia
com a ponte já online.

### Falha de componente

A automação `zigbee_component_failure_notification` observa mensagens
`offline` nos tópicos `zigbee2mqtt/.../availability`. O curinga inclui
automaticamente novos dispositivos e também nomes hierárquicos como
`cozinha/lampada`.

Para cada componente offline, a automação cria um alerta, tenta enviar push e
espera uma mensagem `online` no mesmo tópico antes de registrar a recuperação.
Há até 100 esperas paralelas; este limite impede crescimento sem controle em
caso de configuração incorreta.

Os tópicos de disponibilidade são retidos pelo broker. Vincular a recuperação
à execução iniciada por `offline` é deliberado: ao recarregar automações, os
estados online retidos não geram recuperações falsas; dispositivos realmente
offline recriam o alerta.

## Notificações e portabilidade

As notificações persistentes funcionam para todos os usuários do Home
Assistant. Os pushes usam os `notify.*` listados no package; em outro clone,
substitua-os pelas entidades de notificação existentes na nova instalação.

As ações de push usam `continue_on_error: true`. Portanto um telefone ausente
não impede a criação, atualização ou remoção das notificações persistentes.
Nomes de entidade são identificadores operacionais; endereços do coordenador,
credenciais MQTT e identificadores físicos não devem ser colocados neste
arquivo público.

## Instalação e restauração

1. Restaure ou crie `zigbee2mqtt/configuration.yaml` a partir do exemplo.
2. Confirme `homeassistant.enabled`, o base topic e `availability.enabled`.
3. Adapte o sensor da ponte e os destinos `notify.*` no package.
4. Valide a configuração do Home Assistant.
5. Reinicie o Home Assistant ou recarregue as automações.
6. Confirme no Zigbee2MQTT que dispositivos publicam `online`/`offline`.

O package não mantém banco próprio. O estado persistente relevante continua
sendo o banco e a configuração privados do Zigbee2MQTT. Esperas em andamento
são recriadas após um restart a partir das mensagens MQTT retidas.

## Validação segura

```bash
docker exec homeassistant \
  python3 -m homeassistant --script check_config --config /config
docker compose logs --tail=100 homeassistant zigbee2mqtt mosquitto
```

Para um teste de ponta a ponta, use um cliente MQTT autenticado e um tópico de
dispositivo fictício sob `zigbee2mqtt/.../availability`: publique primeiro
`{"state":"offline"}`, depois `{"state":"online"}`, ambos como retained, e
apague o tópico de teste ao terminar. Não interrompa um coordenador real apenas
para testar uma notificação.

## Diagnóstico

- **Nenhum alerta de componente:** confirme `availability.enabled: true`, o
  base topic e a conexão MQTT do Home Assistant.
- **Alerta de rede sempre ativo:** confira a entidade da ponte e o estado
  `zigbee2mqtt/bridge/state`.
- **Persistente funciona, push não:** substitua os destinos `notify.*` e teste
  `notify.send_message` nas Ferramentas do desenvolvedor.
- **Muitos dispositivos offline após manutenção longa:** isso é esperado para
  mensagens retidas; aguarde os dispositivos passivos acordarem antes de
  alterar timeouts.
- **Nome truncado:** use a versão atual do package; ela preserva friendly names
  com `/`.

## Referências oficiais

- [Disponibilidade de dispositivos no Zigbee2MQTT](https://www.zigbee2mqtt.io/guide/configuration/device-availability.html)
- [Tópicos MQTT do Zigbee2MQTT](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html)
- [Triggers MQTT do Home Assistant](https://www.home-assistant.io/docs/automation/trigger/#mqtt-trigger)
- [`notify.send_message`](https://www.home-assistant.io/actions/notify.send_message/)
