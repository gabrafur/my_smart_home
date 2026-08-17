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
- Resfriamento de emergencia: aba `resfriamento_raspberry_pi` em `nodered/flows.json`

O mesmo dashboard também apresenta
`sensor.revisao_semanal_da_documentacao`, alimentado pelo status local e não
sensível do `docs-review-scheduler`. Os detalhes da entidade estão no guia de
[revisão semanal da documentação](REVISAO_DOCUMENTACAO_SEMANAL.md).

O coletor roda a cada 60 segundos via `command_line` e entrega um JSON unico. Os sensores derivados usam `template`, evitando varias chamadas shell separadas.

## Storage Health e manutencao preventiva

### Diagnostico de 2026-08-13

O salto observado no grafico de aproximadamente 36% para 51% foi correlacionado
com artefatos de desenvolvimento criados entre 8 e 13 de agosto. A medicao antes
da correcao foi:

| Componente | Espaco atual/inicial | Evidencia de crescimento | Diagnostico | Acao |
| --- | ---: | --- | --- | --- |
| Docker build cache | 5,033 GB; 2,159 GB recuperaveis | camadas de 1,11 GB criadas ha 5 dias e varias camadas de 1,1 GB/287 MB criadas ha 2-3 dias | causa raiz principal: builds repetidos das imagens locais sem limite de cache | `docker builder prune` controlado; rotina preventiva com idade minima de 24 h |
| Imagens Docker | 11,53 GB; 1,384 GB inicialmente recuperaveis | imagens intermediarias sem tag, incluindo uma camada unica de 1,115 GB criada ha 2 dias | fator da causa raiz: imagens intermediarias deixadas pelos builds | `docker image prune` somente para dangling; imagens tagged preservadas |
| Ferramentas remotas de IDE em `/home/resident_primary` | 9,32 GB; VS Code Server 5,85 GB e Cursor Server 1,37 GB | novas copias de servidores/extensoes em 7, 11 e 13 de agosto | fator contribuinte fora da stack; versoes antigas podem acumular | somente diagnostico; revisao manual para nao interromper sessoes da IDE |
| Home Assistant | 319 MB | DB 111 MB + WAL ~4 MB; 3 backups diarios totalizando 141 MB | crescimento compativel com Recorder/backups, nao explica o salto | nenhuma exclusao; manter Recorder em 30 dias e acompanhar |
| Node-RED persistente | 151 MB | 91,6 MB de cache npm, 53,4 MB de modulos, 3,9 MB de backups | normal; flows/contexto nao apresentaram crescimento anormal | housekeeping allowlisted para backups antigos e logs npm antigos |
| Zigbee2MQTT / Mosquitto | 573 KB / 418 KB persistentes | Zigbee2MQTT emitiu ~6,4 MB de stdout em 7 dias; demais logs abaixo de 50 KB | nao causaram o salto | rotacao Docker preventiva; manter `info` |
| Journald | volatil; `/var/log` e tmpfs de 50 MB | usuario operacional nao tem permissao para ler o journal global | nao ha evidencia de consumo persistente; cobertura incompleta | revisao manual com `sudo journalctl --disk-usage`; nenhum vacuum automatico |

O `docker system df -v` mostrou volumes locais com apenas 44,73 MB e nenhum
byte recuperavel. Por isso nenhum volume foi removido. Containers escreviam
apenas 125,4 MB em suas camadas gravaveis e nenhum apresentava restart loop.
Os logs JSON estavam sem rotacao, mas a contagem de bytes emitidos demonstrou
que eles nao eram a causa imediata.

Tambem foi encontrado um fator operacional: `scripts/docker-auto-update.mjs`
falhava ao analisar o servico `matter_server` quando havia comentarios antes da
propriedade `image`. Como a limpeza ficava depois dessa etapa, uma falha impedia
o housekeeping. O parser agora delimita os servicos por linhas, e a manutencao
segura roda em `finally` mesmo quando pull, validacao ou recreate falham.

### Remediacao imediata

Foram executados apenas mecanismos oficiais que nao removem volumes nem recursos
em uso:

```text
ANTES
Filesystem: /dev/root em /
Uso: 29.419.827.200 bytes (50%)
Livre: 30.486.360.064 bytes

DEPOIS
Filesystem: /dev/root em /
Uso: 26.145.202.176 bytes (44%)
Livre: 33.760.985.088 bytes

ESPACO RECUPERADO: 3.274.625.024 bytes (3,05 GiB)
```

O total foi 2,159 GB de cache de build e 1,115 GB de imagens dangling. Bancos,
backups, containers, imagens tagged, volumes e caches da IDE foram preservados.

### Flow Storage Health

A aba `Storage Health` em `nodered/flows.json` reutiliza
`sensor.raspberry_pi_storage_usage`, `sensor.raspberry_pi_storage_used` e
`sensor.raspberry_pi_storage_free`. Nao cria copias dessas entidades. Via MQTT
discovery publica somente dados novos:

- `sensor.raspberry_pi_raspberry_storage_status`;
- `sensor.raspberry_pi_raspberry_storage_growth_24h`;
- `sensor.raspberry_pi_raspberry_storage_growth_7d`;
- `sensor.raspberry_pi_raspberry_storage_last_maintenance`;
- `sensor.raspberry_pi_raspberry_storage_last_reclaimed`.

O prefixo inicial `raspberry_pi_` e acrescentado pelo Home Assistant ao nome
das entidades MQTT porque elas pertencem ao dispositivo `Raspberry Pi`. O
dashboard usa os IDs efetivamente registrados, evitando cartões de entidade
não encontrada.

Os limites ficam em um unico function node (`Configurar thresholds`): normal
abaixo de 70%, warning de 70% a 79,9%, high de 80% a 89,9% e critical a partir
de 90%. A histerese e de 3 pontos percentuais. Alertas repetidos usam cooldown
de 12 horas, falhas de coleta/manutencao usam 6 horas, escaladas alertam
imediatamente e a volta a normal gera notificacao de recuperacao.

Uma amostra compacta e persistida a cada 15 minutos por no maximo oito dias.
Ela permite calcular 24 h e 7 dias sem gravacao por minuto. O alerta de tendencia
dispara a partir de +5 pontos percentuais/24 h ou +10 pontos/7 dias, tambem com
cooldown. Sao aceitas apenas amostras dentro de duas horas da janela desejada;
uma amostra velha nao e usada como se fosse de 24 horas.

Enquanto ainda nao houver amostras suficientes, cada sensor de tendencia fica
**indisponivel** por seu topico MQTT de disponibilidade. O fluxo nao publica
`unknown` no topico de estado: esses sensores sao medidas numericas e o Home
Assistant rejeita texto como valor de uma medicao. Quando a janela passa a ter
uma amostra valida, o fluxo publica o numero e marca o sensor como disponivel.

### Frequencias e observabilidade

- health check leve: 15 minutos, usando estados ja coletados pelo Home Assistant;
- housekeeping Node-RED: diariamente as 04:17;
- inspecao profunda restrita a `/data`: domingo as 03:43;
- manutencao host: ao fim da atualizacao diaria de containers, inclusive quando
  uma etapa anterior falha.

Cada manutencao registra inicio, termino, modo, bytes antes/depois, bytes
recuperados e candidatos. Falhas registram a etapa e o codigo, interrompem o
script e geram alerta com cooldown. O dashboard existente ganhou status,
inodes, tendencias, ultima manutencao e espaco recuperado.

O botão **Executar Storage Health** do dashboard pede confirmação e aciona o
helper nativo `input_button.storage_health_manual_run`. O Node-RED reage à
mudança desse helper e executa `/opt/storage-health-maintenance.sh --apply`;
em paralelo, atualiza a leitura dos sensores existentes e a avaliação de
limites/tendência. A manutenção manual segue a mesma allowlist da execução
diária; não executa a inspeção profunda.

O painel usa o layout nativo responsivo `sections`, com três colunas no desktop
e uma no celular. Os históricos ficam no fim da página, redistribuídos com os
demais grupos de saúde do sistema.

### SAFE AUTO-MAINTENANCE

O Node-RED executa `/opt/storage-health-maintenance.sh --apply`, montado em
somente leitura a partir de `scripts/storage-health-maintenance.sh`, que usa
lock atômico, falha quando não consegue inspecionar os diretórios permitidos e so pode
remover arquivos regulares nestes caminhos allowlisted:

- backups de flows em `/data/backups/codex-flows` com mais de 30 dias;
- logs npm em `/data/.npm/_logs` com mais de 14 dias.

Flows, credenciais, context storage, `node_modules` e outros temporarios nao
entram no escopo. O container continua sem Docker socket, mount do host ou
`sudo`.

No host, `scripts/storage-maintenance.sh` remove somente build cache sem uso
(`builder prune --all`) e imagens dangling com mais de 24 horas. O script valida argumentos, e idempotente,
registra metricas antes/depois e usa dry-run por padrao:

```bash
scripts/storage-maintenance.sh --dry-run
scripts/storage-maintenance.sh --apply --min-age 24
```

### MANUAL / REQUIRES REVIEW

Continuam deliberadamente manuais:

- remocao de qualquer volume ou container;
- `docker system prune -a`, `docker image prune -a` e qualquer prune com volumes;
- remocao de imagens tagged mantidas para rollback;
- limpeza de servidores/extensoes VS Code/Cursor em `/home/resident_primary`;
- purge/repack do Recorder e exclusao de backups do Home Assistant;
- vacuum ou mudanca de retencao do journald;
- qualquer `du` completo em `/`.

Para troubleshooting, comece por `df -h`, `df -i`, `docker system df -v`,
`docker ps -a`, tamanho dos logs retornados por `docker inspect .LogPath`, banco
e backups do Home Assistant. Com privilegio administrativo, complemente com
`journalctl --disk-usage` e `du -x -d2 /var/lib/docker`. Nunca use a manutencao
manual para mascarar crescimento sem primeiro identificar quando e por que ele
ocorreu.

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
- Armazenamento: warning `>= 70% por 5 min`; high `>= 80%` no Node-RED; critical `>= 90% por 2 min`
- Hardware: warning se houve evento de undervoltage/throttling desde o boot; critical se a condicao estiver ativa

Os alertas disparam em transicao para problema e as recuperacoes disparam quando voltam ao normal. Isso evita spam enquanto a condicao permanece ativa.

## Resfriamento de emergencia

O Node-RED liga `climate.ar_condicionado_escritorio` em modo frio, 16 °C e
ventilacao alta quando `sensor.raspberry_pi_cpu_temperature` permanece acima
de 81,9 °C por 2 minutos. No startup, temperatura e ownership sao reconciliados
nos dois sentidos: uma CPU ainda quente garante o controle de emergencia; se o
helper estiver ligado e a CPU ja estiver abaixo de 70 °C, uma nova janela de
normalizacao de 10 minutos e iniciada. A faixa entre 70 °C e 81,9 °C nao provoca
comandos destrutivos.

Antes de controlar o equipamento, o fluxo valida que o climate esta disponivel
e salva seu modo, temperatura e ventilacao em
`input_text.raspberry_pi_emergency_cooling_previous_climate`. O helper
`input_boolean.raspberry_pi_emergency_cooling` so e ligado depois que os tres
comandos de emergencia concluem com sucesso. Assim, ele representa ownership
efetivo e nunca e usado para desligar um ar que o fluxo nao controlou.

Depois de 10 minutos abaixo de 70 °C, o estado anterior e restaurado: se o ar
estava desligado, volta a desligado; se estava em uso, modo HVAC, temperatura e
fan mode sao reaplicados. O fluxo confirma o estado restaurado antes de liberar
o ownership. O snapshot fica no Home Assistant para sobreviver a restart do
Node-RED. Falhas de inicio ou restauracao usam no maximo tres
tentativas, separadas por 60 segundos e precedidas por nova validacao da
temperatura. Depois disso, o fluxo falha de forma segura e cria uma notificacao
persistente de ID estavel; nao ha loop de retry sem limite.

Se uma instalacao atualizar enquanto o helper antigo ja estiver ligado, mas o
novo snapshot ainda nao existir, o encerramento usa `climate.turn_off` como
fallback compativel com o comportamento anterior e registra essa condicao na
notificacao de recuperacao.

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
