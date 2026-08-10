# Raspberry Pi - System Health

## Ambiente identificado

- Hardware: Raspberry Pi 5 Model B Rev 1.1
- Sistema operacional do host: Debian GNU/Linux 13 (trixie)
- Instalacao do Home Assistant: Home Assistant Core em Docker, imagem `ghcr.io/home-assistant/home-assistant`, com `network_mode: host`
- Configuracao: `homeassistant/` no checkout, carregada por `/config` no container
- Supervisor: nao identificado; a instalacao atual nao e Home Assistant OS/Supervised
- MQTT: configurado via Mosquitto e integracao MQTT ja registrada
- System Monitor/Glances: nao encontrados em `configuration.yaml`, pacotes ou `core.config_entries`
- Sensores de saude existentes antes desta mudanca: nao havia sensores do host Raspberry Pi; havia apenas scripts de reiniciar/desligar o Raspberry Pi

## Solucao implementada

- Coletor: `homeassistant/tools/raspberry_pi_health.py`
- Pacote Home Assistant: `homeassistant/packages/raspberry_pi_system_health.yaml`
- Dashboard: `homeassistant/dashboards/raspberry_pi_health.yaml`
- Registro do dashboard: `homeassistant/configuration.yaml`
- Mounts de host no container: `docker-compose.yml`

O coletor roda a cada 60 segundos via `command_line` e entrega um JSON unico. Os sensores derivados usam `template`, evitando varias chamadas shell separadas.

## Metricas monitoradas

- Temperatura da CPU por `/sys`
- Uso de CPU por `/proc/stat`
- Load average 1m/5m/15m por `/proc/loadavg`
- Frequencia de CPU por `/sys`, quando disponivel
- RAM total/usada/disponivel por `/proc/meminfo`
- Swap total/usada, quando existir
- Armazenamento usado/livre no volume `/config`
- Uptime e ultimo boot por `/proc/uptime`
- Interface de rede padrao, estado do link, IP e trafego RX/TX
- `vcgencmd get_throttled`, quando o runtime e o device de firmware estiverem disponiveis no container

## Severidade

Os limites foram ajustados para Raspberry Pi 5:

- Temperatura: warning `>= 75 °C por 5 min`; critical `>= 82 °C por 2 min`
- CPU: warning `>= 85% por 10 min`; critical `>= 95% por 15 min`
- Load 5m: warning `>= 1.2x cores por 10 min`; critical `>= 2x cores por 10 min`
- Memoria: warning `>= 80% por 10 min`; critical `>= 90% por 5 min`
- Swap: warning `>= 25% por 10 min`; critical `>= 50% por 5 min`
- Armazenamento: warning `>= 80% por 5 min`; critical `>= 90% por 2 min`
- Hardware: warning se houve evento de undervoltage/throttling desde o boot; critical se a condicao estiver ativa

Os alertas disparam em transicao para problema e as recuperacoes disparam quando voltam ao normal. Isso evita spam enquanto a condicao permanece ativa.

## Limitacoes conhecidas

### `vcgencmd get_throttled`

O host tem o binario `/usr/bin/vcgencmd`, mas o container do Home Assistant e baseado em Alpine/musl, enquanto o binario do host depende do runtime glibc. Alem disso, o device node `/dev/vcio_gencmd` nao aparece como arquivo comum em `/dev` neste ambiente, embora o sysfs exponha `vcio_gencmd`.

Por isso, o dashboard mostra `vcgencmd_available: false` por enquanto. O coletor ja esta preparado para interpretar os bits quando `vcgencmd get_throttled` estiver disponivel.

Formas seguras de habilitar:

- publicar `vcgencmd get_throttled` a partir de um pequeno exporter no host via MQTT; ou
- criar uma imagem customizada do Home Assistant com runtime/binario compativeis e expor o device de firmware correto ao container.

Nao foi adicionado um `devices:` no `docker-compose.yml` porque um device inexistente pode impedir o container de subir.

### Raspberry Pi offline

O proprio Home Assistant nao consegue enviar alerta se o Raspberry Pi inteiro cair, porque ele esta executando no mesmo host. Esta solucao detecta reinicio quando o Home Assistant volta e monitora conectividade enquanto esta em execucao.

Para alerta real de indisponibilidade do Raspberry Pi, use um monitor externo,
por exemplo roteador, Uptime Kuma, outro Home Assistant ou outro host pingando
`IP_DO_HOST`.
