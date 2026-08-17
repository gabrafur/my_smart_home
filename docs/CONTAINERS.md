# Containers, dependências e operação

[Português (principal)](CONTAINERS.md) · [English](CONTAINERS.en.md)

Este documento é a referência atual do `docker-compose.yml`. O Compose é a
fonte de verdade para digests e detalhes exatos; este guia explica os motivos,
pré-requisitos e arquivos privados que não podem ser deduzidos apenas do YAML.

## Matriz da stack

| Serviço | Origem | Rede/porta | Persistência | Arquivos privados obrigatórios |
| --- | --- | --- | --- | --- |
| `portainer` | imagem por digest | `${HOST_LAN_IP}:9000` | `./portainer:/data` | volume inteiro para restaurar usuário e estado |
| `mosquitto` | imagem por digest | `${HOST_LAN_IP}:1883` | `./mosquitto/{config,data,log}` | `config/password.txt` |
| `homeassistant` | imagem por digest | `network_mode: host`, UI 8123 | `./homeassistant:/config`, status documental somente leitura | `secrets.yaml`, `.storage/`, bancos opcionais |
| `matter_server` | imagem por digest | `network_mode: host`, WebSocket em `127.0.0.1:5580` | `./matter-server:/data` | volume inteiro da fabric |
| `appdaemon` | imagem por digest | `network_mode: host`, UI somente em `127.0.0.1:5050` | runtime em `./appdaemon`, config em `./templates/appdaemon` | `.local-secrets/appdaemon-secrets.yaml` |
| `nodered` | imagem por digest | `${HOST_LAN_IP}:1880` | `./nodered:/data` | `flows_cred.json` quando houver credenciais já configuradas |
| `zigbee2mqtt` | imagem por digest | `${HOST_LAN_IP}:8080` | `./zigbee2mqtt:/app/data` | `configuration.yaml`, banco e backup do coordenador |
| `ai-bridge` | build local | somente `127.0.0.1:8099` | volumes de autenticação e workspace | `.env` com token do bridge e, opcionalmente, OAuth |
| `docs-review-scheduler` | mesmo build local do bridge | nenhuma porta publicada | workspace, autenticação Codex e `.local-state/docs-review` | chave SSH de escopo restrito e `known_hosts` fora do Git |

As portas publicadas usam `HOST_LAN_IP`. A ausência da variável faz o bind em
loopback. Home Assistant, AppDaemon e Matter usam rede do host porque dependem
de descoberta local, D-Bus ou acesso direto ao HA.

O frontend do Zigbee2MQTT pode não ter autenticação própria, dependendo do
`configuration.yaml` privado. Binding na LAN não substitui firewall: mantenha
1880, 1883, 8080 e 9000 restritas à LAN/VPN confiável. AppDaemon, o WebSocket
do Matter e o bridge permanecem em loopback.

## Imagens e versões

Todas as imagens externas, inclusive a base do bridge, usam digest. Tags como
`stable` e `latest` aparecem somente na lista de canais consultada por
`scripts/docker-auto-update.mjs`; não são usadas para recriar containers
diretamente.

O bridge usa Node.js 22 Bookworm Slim, inclui Git/SSH para o remoto do
agendador e fixa as versões do Claude Code e Codex no Dockerfile. Pacotes
Debian continuam vindo do repositório oficial durante o build, portanto o build
é determinístico para as partes críticas, mas não é uma reprodução byte a byte
de um snapshot APT.

### Estado do Matter

O serviço atual é o Python Matter Server 8.1, mantido temporariamente para não
arriscar a fabric existente. O projeto upstream está em modo de manutenção e o
servidor novo é baseado em matter.js. Home Assistant OS é o caminho oficialmente
suportado; o container autogerenciado exige rede IPv6/mDNS correta e é usado
aqui conscientemente.

Não troque a imagem nem apague `matter-server/` como parte de uma atualização
rotineira. Antes da migração:

1. faça backup do volume e do Home Assistant;
2. confirme o procedimento de migração da versão de destino;
3. teste em uma cópia do volume;
4. valide dispositivos Wi-Fi e Thread;
5. mantenha um rollback do volume e do Compose.

## Dependências do host

- Docker Engine 23+ e plugin Compose;
- `/run/dbus` para Bluetooth;
- rede IPv6 e mDNS funcionais para Matter/Thread;
- `/etc/localtime`, `/etc/os-release`, `/proc` e `/sys` para o Home Assistant e
  as métricas do host;
- `/usr/bin/vcgencmd` em Raspberry Pi. Em outro hardware, remova esse bind e
  desabilite os sensores que dependem dele;
- `/var/run/docker.sock` para Portainer e o bridge. Esse socket equivale a
  acesso administrativo ao Docker; não exponha esses serviços publicamente.

O GID do socket varia por host. Preencha `DOCKER_GID` com:

```bash
stat -c '%g' /var/run/docker.sock
```

O Compose adiciona esse grupo ao bridge em runtime. O agendador não recebe o
socket, descarta todos os grupos suplementares após um bootstrap curto e assume
o UID/GID não-root que possui o checkout. Se necessário, cria uma identidade
local sem shell para o OpenSSH resolver esse UID. Nenhum GID fica gravado na
imagem.

## Variáveis por serviço

O Compose não usa mais `env_file` nos containers. Essa decisão impede que um
token de agente seja copiado para o ambiente do Node-RED sem necessidade.

| Variável | Consumidor | Obrigatória |
| --- | --- | --- |
| `TZ` | todos | não; padrão `America/Sao_Paulo` |
| `HOST_LAN_IP` | portas bridged | recomendada; loopback se ausente |
| `NODE_RED_ADMIN_*` | Node-RED | sim para editor protegido |
| `HOME_LAT/LON`, `GATE_LAT/LON` | fluxo de chegada | não; há degradação segura |
| `DOCKER_GID` | bridge | sim para comandos Docker |
| `AI_BRIDGE_TOKEN` | bridge e integração HA | sim para usar o endpoint |
| `CLAUDE_CODE_OAUTH_TOKEN` | CLI Claude no bridge | opcional se autenticado pelo volume |
| `HA_LONG_LIVED_TOKEN` | script no host | opcional; prefira arquivo em `.local-secrets/` |
| `WEEKLY_DOCS_REVIEW_*` | agendador documental | horário/branch têm padrão; caminhos SSH são obrigatórios |
| `REPO_UID`, `REPO_GID` | agendador documental | sim; proprietário não-root do checkout |

O `ANTHROPIC_API_KEY` é explicitamente esvaziado dentro do bridge para evitar
que a CLI escolha por acidente a cobrança por API quando a instalação usa OAuth.

O timeout das conversas é de **900 segundos** tanto no bridge quanto no custom
component do Home Assistant. O Compose fixa `BRIDGE_TIMEOUT_MS=900000` para que
um valor antigo no `.env` não reintroduza a janela anterior de cinco minutos.
Se esse limite mudar, atualize os dois lados na mesma alteração.

Requisições da mesma combinação `agent:conversation_id` são serializadas; as
demais continuam paralelas. O bridge persiste o turno como `pending` antes de
iniciar o CLI, encerra o grupo inteiro de processos no timeout e recupera um
conflito de thread do Codex com uma única tentativa em sessão nova. Os detalhes
estão no [guia do bridge](CHAT_CLAUDE_CODE_HA.md).

## Dependências entre serviços

```mermaid
flowchart TD
    MQ[mosquitto] --> Z2M[zigbee2mqtt]
    MQ --> HA[homeassistant]
    MAT[matter_server] --> HA
    MQ --> NR[nodered]
    HA --> NR
    HA --> AD[appdaemon]
    HA --> BR[ai-bridge / integração]
    SCH[docs-review-scheduler] --> GIT[remoto Git]
```

`depends_on` não é health check. Após `docker compose up -d`, Home Assistant e
Node-RED podem levar mais tempo para aceitar conexões. Observe logs e valide as
integrações antes de considerar o deploy concluído.

O Home Assistant usa dois resolvedores DNS públicos explícitos e independentes.
Isso impede que uma recriação feita enquanto o `/etc/resolv.conf` do host está
temporariamente vazio deixe todas as integrações de nuvem indisponíveis. O
health check do container valida tanto DNS quanto a porta local 8123; confira
`docker compose ps homeassistant` e investigue imediatamente qualquer estado
`unhealthy`.

## Build, pull e inicialização

```bash
docker compose config --quiet
docker compose pull
docker compose build --pull ai-bridge
docker compose up -d
docker compose ps
```

O `up -d` padrão não inclui `docs-review-scheduler`, que pertence ao profile
opcional `automation`. Ative-o somente após preparar suas credenciais conforme
o [guia da revisão semanal](REVISAO_DOCUMENTACAO_SEMANAL.md).

O Home Assistant recebe `.local-state/docs-review` como somente leitura para
expor o sensor da rotina. Esse status operacional é regenerável, ignorado pelo
Git e não precisa entrar no backup privado.

O build do bridge precisa de internet para APT e npm. O pull precisa alcançar
Docker Hub e GHCR. Em ARM64 e AMD64, o digest de manifesto resolve a variante
correta da plataforma.

## Validação por serviço

```bash
docker compose ps
docker compose logs --tail=100 mosquitto zigbee2mqtt
docker compose logs --tail=100 homeassistant matter_server
docker compose logs --tail=100 nodered appdaemon
docker compose logs --tail=100 portainer ai-bridge
```

- Home Assistant: `http://IP_DO_HOST:8123` e check de configuração dentro do
  container.
- Mosquitto: publicação e assinatura autenticadas em um tópico de teste.
- Zigbee2MQTT: `zigbee2mqtt/bridge/state` retorna `online`.
- Monitoramento de infraestrutura: disponibilidade Zigbee está habilitada e os
  ciclos Zigbee e Internet são validados no Node-RED conforme o
  [guia específico](ZIGBEE_HEALTH_NOTIFICATIONS.md).
- Node-RED: editor exige autenticação e os testes de fluxo passam.
- Matter: integração HA conecta em `ws://127.0.0.1:5580/ws`.
- AppDaemon: log não contém erro de segredo ou carregamento de app.
- Portainer: onboarding ou estado restaurado aparece somente na LAN/VPN.
- Bridge: `GET /health` em loopback e uma chamada autenticada de teste.
- Agendador: log mostra a próxima execução e `--check` confirma árvore limpa,
  branch e autenticação remota; veja a
  [revisão semanal](REVISAO_DOCUMENTACAO_SEMANAL.md).

## Backup e restauração

O Git cobre configuração, não estado. Faça backup privado e criptografado de:

- `.env` e `.local-secrets/`;
- `homeassistant/secrets.yaml`, `.storage/`, banco e backups necessários;
- `nodered/flows_cred.json` e arquivos de autenticação;
- `mosquitto/config/password.txt` e dados persistentes;
- `zigbee2mqtt/configuration.yaml`, `database.db` e
  `coordinator_backup.json`;
- `.local-secrets/appdaemon-secrets.yaml`;
- diretórios `matter-server/` e `portainer/`.
- credencial SSH exclusiva do agendador, armazenada fora do checkout.

Não coloque esse arquivo de backup no repositório, mesmo criptografado, sem uma
política explícita de chaves e retenção.

## Atualização e rollback

```bash
node scripts/docker-auto-update.mjs daily --dry-run
node scripts/docker-auto-update.mjs daily
```

O script descobre o próprio diretório, portanto não depende mais de
`/mnt/data/docker`. Ele faz backup Git, resolve digests, valida Compose e
Node-RED e só então recria os serviços. Mudanças de banco, fabric ou protocolo
ainda exigem leitura das notas upstream e backup externo.

Para rollback, restaure o Compose e os volumes compatíveis. Reverter apenas o
digest pode não funcionar depois que uma aplicação migra seu banco.

## Referências oficiais verificadas

- [Docker Engine no Debian](https://docs.docker.com/engine/install/debian/)
- [Plugin Docker Compose no Linux](https://docs.docker.com/compose/install/linux/)
- [Home Assistant Container no Raspberry Pi](https://www.home-assistant.io/installation/raspberrypi-other/)
- [Integração Matter do Home Assistant](https://www.home-assistant.io/integrations/matter/)
- [Python Matter Server em Docker](https://github.com/matter-js/python-matter-server/blob/main/docs/docker.md)
- [Configuração Zigbee2MQTT](https://www.zigbee2mqtt.io/guide/configuration/)
- [Disponibilidade de dispositivos Zigbee2MQTT](https://www.zigbee2mqtt.io/guide/configuration/device-availability.html)
- [Scheduled tasks do Codex](https://learn.chatgpt.com/docs/automations)
