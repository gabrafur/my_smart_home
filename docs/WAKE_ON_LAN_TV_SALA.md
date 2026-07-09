# Wake-On-LAN explícito — TV Sala (Samsung QN90BA)

## Contexto

A integração `samsungtv` do Home Assistant enviava magic packets de
Wake-On-LAN automaticamente ("implicit Wake-On-LAN") sempre que
`media_player.turn_on` era chamado para uma Samsung TV cujo endereço MAC
era conhecido. Esse comportamento implícito foi descontinuado a partir da
versão 2026.2 e será removido na versão **2026.8.0** (repair issue
`implicit_wake_on_lan` no core do Home Assistant).

Sem uma automação explícita, a TV Sala (`media_player.samsung_qn90ba_50_qn50qn90bagxzd`)
deixaria de ligar sozinha via comandos que usam `media_player.turn_on`
(dashboards, Alexa/Google Home, automações) a partir de 2026.8.0.

## Solução aplicada

1. **`homeassistant/configuration.yaml`** — adicionado `wake_on_lan:` para
   habilitar o serviço `wake_on_lan.send_magic_packet` (não fazia parte do
   `default_config:`).
2. **`homeassistant/automations.yaml`** — nova automação
   `Wake TV Sala via Wake-On-LAN`, usando o trigger nativo
   `samsungtv.turn_on` (fornecido pela própria integração samsungtv para
   substituir o comportamento implícito) no entity_id
   `media_player.samsung_qn90ba_50_qn50qn90bagxzd`. A ação envia o magic
   packet para o MAC `a0:d7:f3:30:d7:0e`.

```yaml
- id: "1783799940000"
  alias: Wake TV Sala via Wake-On-LAN
  triggers:
    - trigger: samsungtv.turn_on
      entity_id: media_player.samsung_qn90ba_50_qn50qn90bagxzd
  actions:
    - action: wake_on_lan.send_magic_packet
      data:
        mac: a0:d7:f3:30:d7:0e
  mode: single
```

## Por que este trigger

O fórum da comunidade Home Assistant confirma que a própria integração
`samsungtv` expõe um trigger dedicado `samsungtv.turn_on`, disparado
sempre que algo pede para ligar a entidade `media_player` — é o
substituto direto e suportado do comportamento implícito antigo (ao
contrário de um trigger de `state`, que não dispararia porque a TV
desligada não muda de estado sozinha).

## Aplicar a mudança

`wake_on_lan:` é uma integração nova, carregada só na inicialização —
**requer restart do container `homeassistant`** para entrar em vigor
(um simples "reload automations" não basta). A automação em si recarrega
via Developer Tools, mas o serviço `wake_on_lan.send_magic_packet` só
fica disponível após o restart.

`docker exec homeassistant python3 -m homeassistant --script check_config -c /config`
foi rodado após a edição e não reportou erros.

## Referências

- Device MAC confirmado em `.storage/core.config_entries` (entry da
  integração `samsungtv`, host `192.168.0.203`).
- https://www.home-assistant.io/integrations/wake_on_lan/
- https://community.home-assistant.io/t/samsung-implicit-wake-on-lan-deprecation/985971
