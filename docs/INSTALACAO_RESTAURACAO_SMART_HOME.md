# Instalacao e restauracao completa da casa inteligente

Este documento descreve como reconstruir a stack da casa inteligente a partir de um Linux zerado usando Docker, Git e os arquivos versionados em:

```bash
git@github.com:gabrafur/my_smart_home.git
```

Ele foi escrito para Raspberry Pi/Debian/DietPi, mas os comandos tambem servem para qualquer Linux Debian-like recente.

## 0. Visao geral

### Hardware/base usada

- Raspberry Pi 5 ou equivalente.
- Linux Debian/DietPi.
- Diretorio principal da stack: `/mnt/data/docker`.
- Usuario operacional: `gabriel`.
- Timezone: `America/Sao_Paulo`.
- IP local atual esperado da casa: `192.168.0.205`.
- Coordenador Zigbee via rede: `tcp://192.168.0.197:7638`.

### Containers da stack

| Servico | Container | Imagem | Porta/rede | Volume |
|---|---|---|---|---|
| Portainer | `portainer` | `portainer/portainer-ce@sha256:...` | `${HOST_LAN_IP}:9000` | `./portainer:/data` |
| Mosquitto | `mosquitto` | `eclipse-mosquitto@sha256:...` | `${HOST_LAN_IP}:1883` | `./mosquitto/...` |
| Home Assistant | `homeassistant` | `ghcr.io/home-assistant/home-assistant@sha256:...` | `network_mode: host` | `./homeassistant:/config` |
| AppDaemon | `appdaemon` | `acockburn/appdaemon@sha256:...` | `network_mode: host` | `./appdaemon:/conf` |
| Node-RED | `nodered` | `nodered/node-red@sha256:...` | `${HOST_LAN_IP}:1880` | `./nodered:/data` |
| Zigbee2MQTT | `zigbee2mqtt` | `koenkk/zigbee2mqtt@sha256:...` | `${HOST_LAN_IP}:8080` | `./zigbee2mqtt:/app/data` |

As imagens estao fixadas por digest no `docker-compose.yml`. Isso evita mudancas silenciosas em restauracoes ou recriacoes de container.

### Acessos locais

```text
Home Assistant : http://192.168.0.205:8123
Node-RED       : http://192.168.0.205:1880
Zigbee2MQTT    : http://192.168.0.205:8080
Portainer      : http://192.168.0.205:9000
MQTT           : 192.168.0.205:1883
```

As portas publicadas de Portainer, Mosquitto, Node-RED e Zigbee2MQTT ficam presas ao IP definido em `.env` por `HOST_LAN_IP`. Se `.env` nao existir, o Compose cai para `127.0.0.1`, evitando exposicao acidental em todas as interfaces.

### Acessos remotos

Tailscale esta instalado no host atual e habilitado. O host atual aparece como:

```text
Hostname Tailscale: raspbery-gabriel.tailbe3cf5.ts.net
IP Tailscale IPv4 : 100.69.100.59
Subnet route      : 192.168.0.0/24
```

ZeroTier foi citado como item de projeto, mas nao esta instalado no host atual. Este manual inclui a instalacao opcional.

## 1. O que entra no Git e o que nao entra

O Git salva configuracoes reaproveitaveis, fluxos, scripts e manifests. Segredos e estado runtime ficam fora.

### Versionado

- `docker-compose.yml`
- `homeassistant/configuration.yaml`
- `homeassistant/automations.yaml`
- `homeassistant/scenes.yaml`
- `homeassistant/scripts.yaml`
- registries selecionados de `.storage`:
  - `core.area_registry`
  - `core.device_registry`
  - `core.entity_registry`
  - `core.floor_registry`
  - `lovelace.map`
  - `lovelace_dashboards`
  - `homeassistant.exposed_entities`
  - `person`
- `homeassistant/custom_components/` sem caches e sem frontend gerado do HACS.
- `nodered/flows.json`
- `nodered/package.json`
- `nodered/package-lock.json`
- `nodered/settings.js`
- `nodered/tools/*.mjs`
- `mosquitto/config/mosquitto.conf`
- `zigbee2mqtt/configuration.example.yaml`
- `scripts/git-backup.sh`
- `scripts/setup-node-red-security.mjs`
- `scripts/rotate-mqtt-password.mjs`
- `.env.example`
- `.gitignore`
- `.vscode/settings.json`

### Nao versionado

Arquivos abaixo precisam de backup seguro separado:

- `homeassistant/secrets.yaml`
- `homeassistant/.storage/auth`
- `homeassistant/.storage/auth_provider.homeassistant`
- `homeassistant/.storage/http.auth`
- `homeassistant/.storage/cloud`
- `homeassistant/.cloud/`
- `homeassistant/backups/*.tar`
- `homeassistant/home-assistant_v2.db*`
- `.env`
- `.local-secrets/`
- `nodered/flows_cred.json`
- `nodered/.sessions.json`
- `nodered/.config.users.json`
- `mosquitto/config/password.txt`
- `mosquitto/data/mosquitto.db`
- `zigbee2mqtt/configuration.yaml`
- `zigbee2mqtt/coordinator_backup.json`
- `zigbee2mqtt/database.db`
- `portainer/`

Motivo: esses arquivos contem senha, token, cookie, chave Zigbee, banco runtime ou credenciais.

## 2. Instalacao do Linux base

### 2.1. DietPi ou Debian

Para Raspberry Pi, grave DietPi ou Debian em SSD/microSD. No primeiro boot, acesse:

```bash
ssh root@IP_DO_PI
```

No DietPi, a senha inicial costuma ser:

```text
dietpi
```

### 2.2. Configuracao inicial recomendada

No DietPi:

```bash
dietpi-config
```

Configure:

- hostname: `DietPi` ou `raspbery-gabriel`;
- timezone: `America/Sao_Paulo`;
- IP fixo no Ethernet, preferencialmente `192.168.0.205`;
- senha forte para `root`;
- usuario `gabriel`;
- log2ram habilitado;
- CPU governor `performance`, se fizer sentido para o hardware.

Em Debian puro:

```bash
sudo timedatectl set-timezone America/Sao_Paulo
hostnamectl hostname DietPi
```

Atualize o sistema:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo reboot
```

## 3. Preparar usuario, SSH e pastas

Se o usuario `gabriel` ainda nao existir:

```bash
sudo adduser gabriel
sudo usermod -aG sudo gabriel
```

Reabra SSH com o usuario:

```bash
ssh gabriel@IP_DO_PI
```

Crie a estrutura base:

```bash
sudo mkdir -p /mnt/data/docker
sudo chown -R gabriel:gabriel /mnt/data/docker
```

Crie as pastas da stack:

```bash
mkdir -p /mnt/data/docker/{portainer,homeassistant,nodered,appdaemon,zigbee2mqtt}
mkdir -p /mnt/data/docker/mosquitto/{config,data,log}
```

## 4. Instalar pacotes do host

Instale ferramentas operacionais:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  jq \
  sqlite3 \
  ripgrep \
  mosquitto-clients \
  cron \
  openssh-client \
  nano \
  htop
```

Ferramentas usadas neste projeto:

- `git`: versionamento e backup automatico.
- `jq`: leitura de JSON.
- `sqlite3`: consulta ao historico do Home Assistant.
- `ripgrep`/`rg`: busca rapida.
- `mosquitto_pub` e `mosquitto_sub`: testes MQTT.
- `cron`: agendamento do backup Git.
- `node`/`npm`: usados para validar fluxos Node-RED a partir do host.

Node.js e npm podem vir por pacotes do sistema ou por NodeSource. Em Debian:

```bash
sudo apt-get install -y nodejs npm
node --version
npm --version
```

No host atual, as versoes observadas foram:

```text
Node.js host: v20.19.2
npm host    : 9.2.0
Docker      : 29.2.1
Compose     : v5.1.0
```

## 5. Instalar Docker e Docker Compose

### 5.1. Metodo oficial simples

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Habilite no boot:

```bash
sudo systemctl enable docker
sudo systemctl start docker
```

Adicione o usuario ao grupo Docker:

```bash
sudo usermod -aG docker gabriel
```

Saia e entre novamente na sessao SSH:

```bash
exit
ssh gabriel@IP_DO_PI
```

Teste:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

## 6. Configurar chave SSH do GitHub

Se a chave ja existir em `/home/gabriel/.ssh/id_ed25519`, apenas teste:

```bash
ssh -T git@github.com
```

Se nao existir:

```bash
ssh-keygen -t ed25519 -C "gabrafur@users.noreply.github.com" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Adicione a chave publica no GitHub:

```text
GitHub -> Settings -> SSH and GPG keys -> New SSH key
```

Teste novamente:

```bash
ssh -T git@github.com
```

## 7. Clonar o repositorio da casa inteligente

Se `/mnt/data/docker` estiver vazio:

```bash
cd /mnt/data
git clone git@github.com:gabrafur/my_smart_home.git docker
```

Se a pasta ja existir, clone em temporario e copie com cuidado:

```bash
cd /mnt/data
git clone git@github.com:gabrafur/my_smart_home.git docker-new
```

Verifique:

```bash
cd /mnt/data/docker
git status --short --branch
git remote -v
```

Esperado:

```text
## main...origin/main
origin git@github.com:gabrafur/my_smart_home.git
```

## 8. Seguranca local e restauracao de segredos

Esta stack separa configuracao versionavel de segredo operacional.

Controles aplicados:

- `Node-RED` usa `credentialSecret` fixo via `.env`, preservando a capacidade de descriptografar `flows_cred.json` em outro Raspberry Pi.
- O editor/admin API do `Node-RED` exige login. A senha fica em `.local-secrets/node-red-admin-password.txt`.
- `Node-RED` desabilita `/diagnostics` e telemetria no `settings.js`.
- `Mosquitto` usa `allow_anonymous false`.
- A senha MQTT do usuario `gabriel` e forte, rotacionavel e guardada em `.local-secrets/mqtt-gabriel-password.txt`.
- Portas publicadas usam `${HOST_LAN_IP}` em vez de `0.0.0.0`.
- Imagens Docker ficam fixadas por digest.

Em uma instalacao nova, depois de restaurar o repo e antes de subir os containers, crie ou restaure `.env`:

```bash
cd /mnt/data/docker
cp .env.example .env
```

Se voce restaurou `nodered/.config.runtime.json`, rode:

```bash
node scripts/setup-node-red-security.mjs
```

Esse comando:

- reaproveita o segredo de credenciais atual do Node-RED;
- gera hash bcrypt para o login do editor;
- grava `.env`;
- grava a senha do admin em `.local-secrets/node-red-admin-password.txt`.

Se voce nao restaurou `nodered/.config.runtime.json`, suba o Node-RED uma vez para ele criar o runtime, depois rode o comando acima e recrie o container.

### 8.1. Restaurar arquivos secretos fora do Git

Antes de subir os containers, restaure os arquivos sensiveis a partir de backup seguro.

#### 8.1.1. Home Assistant

Arquivos recomendados para restaurar:

```bash
/mnt/data/docker/homeassistant/secrets.yaml
/mnt/data/docker/homeassistant/.storage/auth
/mnt/data/docker/homeassistant/.storage/auth_provider.homeassistant
/mnt/data/docker/homeassistant/.storage/http.auth
/mnt/data/docker/homeassistant/.storage/cloud
/mnt/data/docker/homeassistant/.cloud/
```

Se quiser preservar historico:

```bash
/mnt/data/docker/homeassistant/home-assistant_v2.db
/mnt/data/docker/homeassistant/home-assistant_v2.db-shm
/mnt/data/docker/homeassistant/home-assistant_v2.db-wal
```

Se voce tiver backup nativo do Home Assistant (`.tar`), mantenha em:

```bash
/mnt/data/docker/homeassistant/backups/
```

#### 8.1.2. Node-RED

Restaure:

```bash
/mnt/data/docker/nodered/flows_cred.json
/mnt/data/docker/nodered/.config.users.json
/mnt/data/docker/.env
/mnt/data/docker/.local-secrets/
```

Sem `flows_cred.json`, os fluxos podem existir, mas credenciais de nodes podem precisar ser reconfiguradas. Sem `.env`, o Node-RED ainda tenta ler o segredo antigo de `.config.runtime.json`, mas o login do editor pode nao ficar ativo ate voce rodar:

```bash
cd /mnt/data/docker
node scripts/setup-node-red-security.mjs
docker compose up -d nodered
```

#### 8.1.3. Mosquitto

Restaure:

```bash
/mnt/data/docker/mosquitto/config/password.txt
```

Se nao tiver backup, recrie:

```bash
cd /mnt/data/docker
node scripts/rotate-mqtt-password.mjs
```

Esse script gera uma senha forte e atualiza, de forma coordenada:

- `mosquitto/config/password.txt`;
- `zigbee2mqtt/configuration.yaml`;
- `homeassistant/.storage/core.config_entries`;
- credenciais criptografadas do broker MQTT no `nodered/flows_cred.json`.

Depois reinicie:

```bash
docker compose restart mosquitto zigbee2mqtt nodered homeassistant
```

#### 8.1.4. Zigbee2MQTT

Restaure principalmente:

```bash
/mnt/data/docker/zigbee2mqtt/configuration.yaml
/mnt/data/docker/zigbee2mqtt/coordinator_backup.json
/mnt/data/docker/zigbee2mqtt/database.db
```

`configuration.yaml` contem:

- usuario/senha MQTT;
- `network_key`;
- `pan_id`;
- `ext_pan_id`;
- porta do coordenador Zigbee.

Sem esse arquivo restaurado, os dispositivos Zigbee podem precisar ser pareados novamente.

Se nao tiver o arquivo real, crie a partir do exemplo:

```bash
cp /mnt/data/docker/zigbee2mqtt/configuration.example.yaml \
   /mnt/data/docker/zigbee2mqtt/configuration.yaml

nano /mnt/data/docker/zigbee2mqtt/configuration.yaml
```

Substitua:

```yaml
user: CHANGE_ME
password: CHANGE_ME
network_key: GENERATE_OR_RESTORE_SECURELY
pan_id: RESTORE_FROM_SECURE_BACKUP
ext_pan_id: RESTORE_FROM_SECURE_BACKUP
```

Depois de criar/restaurar `configuration.yaml`, rode a rotacao MQTT se quiser gerar uma senha nova e sincronizar todos os consumidores:

```bash
cd /mnt/data/docker
node scripts/rotate-mqtt-password.mjs
docker compose restart mosquitto zigbee2mqtt nodered homeassistant
```

#### 8.1.5. Portainer

Portainer foi ignorado no Git porque contem banco, chaves e estado. Para restaurar:

```bash
/mnt/data/docker/portainer/
```

Se nao restaurar, o Portainer sobe zerado e voce cria o usuario novamente.

## 9. Validar arquivos principais

Confira o compose:

```bash
cd /mnt/data/docker
docker compose config
```

Confira o Mosquitto:

```bash
sed -n '1,120p' mosquitto/config/mosquitto.conf
```

Esperado:

```conf
listener 1883
allow_anonymous false
password_file /mosquitto/config/password.txt
persistence true
persistence_location /mosquitto/data/
log_dest stdout
```

Confira Zigbee2MQTT:

```bash
sed -n '1,180p' zigbee2mqtt/configuration.yaml
```

Configuracao real esperada, com segredos preenchidos:

```yaml
version: 5
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://mosquitto:1883
  user: gabriel
  password: SENHA_FORTE_GERADA_PELO_SCRIPT
serial:
  port: tcp://192.168.0.197:7638
  baudrate: 115200
  adapter: zstack
  disable_led: false
advanced:
  log_level: info
  channel: 26
  transmit_power: 20
  network_key: [...]
  pan_id: ...
  ext_pan_id: [...]
frontend:
  enabled: true
  port: 8080
homeassistant:
  enabled: true
onboarding: false
permit_join: false
```

## 10. Permissoes recomendadas

Alguns containers usam usuarios internos diferentes. Ajuste permissao dos volumes:

```bash
sudo chown -R gabriel:gabriel /mnt/data/docker
```

Mosquitto costuma rodar com usuario interno proprio. Se houver erro de escrita no volume:

```bash
sudo chown -R 1883:1883 /mnt/data/docker/mosquitto
sudo chmod -R u+rwX,g+rwX /mnt/data/docker/mosquitto
```

Node-RED no container costuma usar UID/GID `1000:1000`. Para manter o container e o host conseguindo editar:

```bash
sudo chown -R 1000:gabriel /mnt/data/docker/nodered
sudo chmod -R g+rwX /mnt/data/docker/nodered
```

Se depois voce editar pelo host e o Node-RED reclamar de permissao:

```bash
docker exec -u root nodered chown -R 1000:1000 /data
docker restart nodered
```

## 11. Subir a stack

```bash
cd /mnt/data/docker
docker compose pull
docker compose up -d
```

Verifique:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

Espere algo parecido com:

```text
zigbee2mqtt     koenkk/zigbee2mqtt@sha256:...                    Up
homeassistant   ghcr.io/home-assistant/home-assistant@sha256:...  Up
portainer       portainer/portainer-ce@sha256:...                Up
nodered         nodered/node-red@sha256:...                      Up (healthy)
appdaemon       acockburn/appdaemon@sha256:...                   Up
mosquitto       eclipse-mosquitto@sha256:...                     Up
```

Logs iniciais:

```bash
docker logs --tail 100 mosquitto
docker logs --tail 100 zigbee2mqtt
docker logs --tail 100 homeassistant
docker logs --tail 100 nodered
docker logs --tail 100 appdaemon
docker logs --tail 100 portainer
```

## 12. Testes MQTT

Abra um terminal escutando:

```bash
MQTT_PASSWORD="$(tr -d '\n' < /mnt/data/docker/.local-secrets/mqtt-gabriel-password.txt)"
mosquitto_sub -h 192.168.0.205 -p 1883 -u gabriel -P "$MQTT_PASSWORD" -t 'zigbee2mqtt/#' -v
```

Em outro terminal publique teste:

```bash
MQTT_PASSWORD="$(tr -d '\n' < /mnt/data/docker/.local-secrets/mqtt-gabriel-password.txt)"
mosquitto_pub -h 192.168.0.205 -p 1883 -u gabriel -P "$MQTT_PASSWORD" -t 'teste/casa' -m 'ok'
```

Se o Mosquitto estiver correto, o subscriber recebe:

```text
teste/casa ok
```

## 13. Home Assistant

Acesse:

```text
http://IP_DO_PI:8123
```

Arquivos importantes:

```bash
/mnt/data/docker/homeassistant/configuration.yaml
/mnt/data/docker/homeassistant/automations.yaml
/mnt/data/docker/homeassistant/scripts.yaml
/mnt/data/docker/homeassistant/scenes.yaml
```

Validacao basica:

```bash
docker exec homeassistant python3 -m homeassistant --script check_config --config /config
```

Logs:

```bash
docker logs --tail 200 homeassistant
```

### Integracoes observadas no ambiente

- MQTT
- Tuya/LocalTuya
- Alexa Media Player
- Kia UVO/Hyundai Bluelink
- LG ThinQ
- Samsung TV
- HACS
- go2rtc
- Mobile App iPhones
- SLZB-MRW10U
- Google Translate TTS

Algumas integracoes dependem de arquivos `.storage` ignorados no Git. Se elas nao voltarem logadas, reautentique pela UI do Home Assistant.

### 13.1. Inbox Codex na interface

Foi criado um painel lateral chamado `Codex`.

URL local:

```text
http://192.168.0.205:8123/codex-inbox/inbox
```

Entidades criadas por package:

- `input_text.codex_prompt`
- `input_select.codex_prompt_priority`
- `input_boolean.codex_prompt_ready`
- `input_text.codex_prompt_status`
- `script.codex_enviar_prompt`
- `script.codex_limpar_prompt`

Arquivos:

```bash
homeassistant/packages/codex_prompt_inbox.yaml
homeassistant/dashboards/codex.yaml
```

Uso:

1. Abra o painel `Codex`.
2. Escreva um prompt curto em `Prompt para Codex`.
3. Escolha a prioridade.
4. Clique em `Marcar para Codex`.
5. Depois chame o Codex e peça para ler `input_text.codex_prompt`.

Limite atual: `input_text` do Home Assistant aceita ate 255 caracteres. Para pedidos maiores, escreva um resumo no painel e coloque detalhes no chat do Codex.

Sobre a integracao OpenAI:

- A integracao OpenAI Conversation do Home Assistant e util para conversa, assistente e controle de entidades permitidas.
- Ela nao executa alteracoes no Docker, Node-RED ou arquivos do host como o Codex.
- Mudancas estruturais continuam passando pelo Codex no host, com validacao, backup Git e revisao.

## 14. Zigbee2MQTT

Acesse:

```text
http://IP_DO_PI:8080
```

Teste o container:

```bash
docker logs --tail 200 zigbee2mqtt
```

Veja dispositivos:

```bash
MQTT_PASSWORD="$(tr -d '\n' < /mnt/data/docker/.local-secrets/mqtt-gabriel-password.txt)"
mosquitto_sub -h 192.168.0.205 -p 1883 -u gabriel -P "$MQTT_PASSWORD" -t 'zigbee2mqtt/bridge/devices' -C 1
```

Coordenador atual:

```yaml
serial:
  port: tcp://192.168.0.197:7638
  baudrate: 115200
  adapter: zstack
```

Dispositivos conhecidos no exemplo real:

- `refletores_jardim`
- `lampadas_garagem`
- `controlador_ir`
- `abajour_sala_de_estar`
- `lampada_varanda`
- `botao_portao_garagem`
- `refletor_portao_carros`

## 15. Node-RED

Acesse:

```text
http://IP_DO_PI:1880
```

Pacotes instalados no projeto:

```json
{
  "node-red-contrib-dulonode": "~1.0.11",
  "node-red-contrib-home-assistant-websocket": "~0.80.3"
}
```

Se precisar reinstalar dependencias:

```bash
cd /mnt/data/docker/nodered
npm ci
docker restart nodered
```

Validar fluxos:

```bash
cd /mnt/data/docker/nodered
npm run flows:validate
npm run flows:summary
```

Criar backup manual dos fluxos:

```bash
cd /mnt/data/docker/nodered
npm run flows:backup
```

Fluxos atuais:

- `garagem`
  - Botao Zigbee `botao_portao_garagem`.
  - Aciona `scene.acionar_portao`.
- `iluminacao_externa`
  - Liga luzes externas por comando manual ou por do sol.
  - Usa `lampada_varanda`, `lampadas_garagem`, `refletores_jardim`.
- `iluminacao_seguranca`
  - Acende `switch.refletor_portao_carros` quando esta escuro e alguem esta chegando.
  - Usa geolocalizacao de Gabriel, Valeria e Creta.
  - Desliga ao travar o Creta ou apos timeout de seguranca.

Depois de editar `flows.json` por arquivo:

```bash
cd /mnt/data/docker/nodered
npm run flows:validate
docker restart nodered
docker logs --tail 100 nodered
```

## 16. AppDaemon

Volume:

```bash
/mnt/data/docker/appdaemon:/conf
```

Arquivos:

```bash
appdaemon/appdaemon.yaml
appdaemon/apps/apps.yaml
appdaemon/apps/hello.py
```

Logs:

```bash
docker logs --tail 200 appdaemon
```

Se o AppDaemon precisar de token do Home Assistant, coloque em arquivo seguro fora do Git ou em `secrets.yaml`, conforme a configuracao usada.

## 17. Portainer

Acesse:

```text
http://IP_DO_PI:9000
```

Se o volume `portainer/` nao foi restaurado, o Portainer abre como instalacao nova.

O Portainer foi ignorado no Git porque contem:

- banco interno;
- chaves;
- certificados;
- estado de containers/stacks.

## 18. Tailscale

Tailscale permite acessar a casa de fora sem abrir portas no roteador.

### 18.1. Instalar

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

Habilite:

```bash
sudo systemctl enable --now tailscaled
```

Suba o node:

```bash
sudo tailscale up \
  --hostname=raspbery-gabriel \
  --ssh \
  --advertise-routes=192.168.0.0/24
```

Depois aprove a subnet route no painel do Tailscale:

```text
Tailscale Admin Console -> Machines -> raspbery-gabriel -> Edit route settings
```

### 18.2. Verificar

```bash
tailscale status
tailscale ip -4
tailscale netcheck
```

Estado atual observado:

```text
BackendState : Running
Tailscale IP : 100.69.100.59
MagicDNS     : raspbery-gabriel.tailbe3cf5.ts.net
Routes       : 192.168.0.0/24
```

Teste de outro dispositivo do tailnet:

```bash
ping 100.69.100.59
curl -I http://100.69.100.59:8123
curl -I http://raspbery-gabriel.tailbe3cf5.ts.net:8123
```

### 18.3. Renovacao/validade

Confira expiracao da chave no painel Tailscale. Para servidor fixo, considere desabilitar key expiry para a maquina.

## 19. ZeroTier opcional

ZeroTier nao esta instalado no host atual, mas se quiser redundancia de acesso remoto:

```bash
curl -s https://install.zerotier.com | sudo bash
sudo systemctl enable --now zerotier-one
```

Entre na rede:

```bash
sudo zerotier-cli join NETWORK_ID
```

No painel ZeroTier:

```text
https://my.zerotier.com/
```

Autorize o novo membro.

Verifique:

```bash
sudo zerotier-cli status
sudo zerotier-cli listnetworks
ip addr | grep -A3 zt
```

Opcionalmente, se for rotear a LAN via ZeroTier, habilite forwarding:

```bash
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-smart-home-forward.conf
sudo sysctl --system
```

Adicione rotas gerenciadas no painel ZeroTier conforme necessidade. Use apenas se souber exatamente o plano de rede, para nao conflitar com Tailscale.

## 20. Backup automatico no Git

Script:

```bash
/mnt/data/docker/scripts/git-backup.sh
```

Cron atual:

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Smart home Git backup - created by Codex
30 3 * * * /mnt/data/docker/scripts/git-backup.sh
```

Instalar manualmente:

```bash
crontab -l > /tmp/current-cron 2>/dev/null || true
cat >> /tmp/current-cron <<'EOF'

# Smart home Git backup
30 3 * * * /mnt/data/docker/scripts/git-backup.sh
EOF
crontab /tmp/current-cron
```

Rodar manualmente:

```bash
cd /mnt/data/docker
scripts/git-backup.sh
```

Ver log:

```bash
tail -100 /mnt/data/docker/.git-backup.log
```

O script:

- usa `flock` para evitar execucao simultanea;
- usa SSH key `/home/gabriel/.ssh/id_ed25519`;
- roda `git fetch`;
- aborta se o branch local estiver atras de `origin/main`;
- roda `git add -A`;
- aborta se detectar arquivos suspeitos staged;
- aborta se detectar padroes de segredo no conteudo staged;
- cria commit apenas se houver mudancas;
- faz `git push origin main`.

## 21. Source Control no VS Code/Cursor

## 22. Atualizacao automatica de Docker e integracoes

Script:

```bash
/mnt/data/docker/scripts/docker-auto-update.mjs
```

Modos:

```bash
# Atualizacao diaria de imagens Docker
node /mnt/data/docker/scripts/docker-auto-update.mjs daily

# Checagem de entidades update.* do Home Assistant
node /mnt/data/docker/scripts/docker-auto-update.mjs ha-updates

# Teste sem aplicar mudancas
node /mnt/data/docker/scripts/docker-auto-update.mjs daily --dry-run
node /mnt/data/docker/scripts/docker-auto-update.mjs ha-updates --dry-run
```

O modo `daily`:

- roda `scripts/git-backup.sh` antes de mexer;
- puxa os canais configurados (`latest`/`stable`) das imagens Docker;
- resolve os novos digests;
- atualiza o `docker-compose.yml` se houver digest novo;
- valida `docker compose config --quiet`;
- valida os fluxos do Node-RED com `npm run flows:validate`;
- recria os containers com `docker compose up -d`;
- roda backup Git novamente se houve mudanca;
- limpa imagens antigas com `docker image prune -f`.

O modo `ha-updates`:

- usa `HA_LONG_LIVED_TOKEN` do `.env`;
- consulta a API local do Home Assistant;
- instala atualizacoes seguras de entidades `update.*`;
- ignora firmware/SLZB automaticamente;
- reinicia o Home Assistant quando alguma integracao foi atualizada.

Para habilitar o modo `ha-updates`, crie um token de longa duracao no Home Assistant em:

```text
Perfil do usuario -> Tokens de acesso de longa duracao
```

Depois adicione ao `.env`:

```bash
HA_LONG_LIVED_TOKEN=COLE_O_TOKEN_AQUI
```

Cron recomendado:

```cron
# Smart home Docker auto update - created by Codex
15 4 * * * /usr/bin/node /mnt/data/docker/scripts/docker-auto-update.mjs daily >> /mnt/data/docker/.docker-auto-update.cron.log 2>&1

# Smart home Home Assistant integration update watcher - created by Codex
*/30 * * * * /usr/bin/node /mnt/data/docker/scripts/docker-auto-update.mjs ha-updates >> /mnt/data/docker/.docker-auto-update.cron.log 2>&1
```

Ver logs:

```bash
tail -100 /mnt/data/docker/.docker-auto-update.log
tail -100 /mnt/data/docker/.docker-auto-update.cron.log
```

Instalar manualmente:

```bash
crontab -l > /tmp/current-cron 2>/dev/null || true
cat >> /tmp/current-cron <<'EOF'

# Smart home Docker auto update - created by Codex
15 4 * * * /usr/bin/node /mnt/data/docker/scripts/docker-auto-update.mjs daily >> /mnt/data/docker/.docker-auto-update.cron.log 2>&1

# Smart home Home Assistant integration update watcher - created by Codex
*/30 * * * * /usr/bin/node /mnt/data/docker/scripts/docker-auto-update.mjs ha-updates >> /mnt/data/docker/.docker-auto-update.cron.log 2>&1
EOF
crontab /tmp/current-cron
```

O projeto inclui:

```json
{
  "git.enabled": true,
  "git.path": "/usr/bin/git",
  "git.autoRepositoryDetection": true,
  "git.openRepositoryInParentFolders": "always"
}
```

Arquivo:

```bash
/mnt/data/docker/.vscode/settings.json
```

Se o Source Control nao aparecer:

1. Abra a pasta `/mnt/data/docker`, nao uma subpasta.
2. Rode `Developer: Reload Window`.
3. Confirme:

```bash
cd /mnt/data/docker
git status --short --branch
```

## 23. Atualizacao manual da stack

Nao foi configurado Watchtower. Atualizacao e manual.

```bash
cd /mnt/data/docker
docker compose pull
docker compose up -d
docker image prune -f
```

Verifique logs:

```bash
docker ps
docker logs --tail 100 homeassistant
docker logs --tail 100 nodered
docker logs --tail 100 zigbee2mqtt
```

Antes de grandes atualizacoes:

```bash
cd /mnt/data/docker
scripts/git-backup.sh
docker compose ps
```

## 24. Backup seguro fora do Git

O Git nao substitui backup completo porque segredos e bancos foram ignorados.

Crie um backup criptografado dos segredos:

```bash
mkdir -p /mnt/data/secure-backups
tar \
  --exclude='homeassistant/home-assistant.log*' \
  -czf /mnt/data/secure-backups/smart-home-secrets-$(date +%F).tar.gz \
  .env \
  .local-secrets \
  homeassistant/secrets.yaml \
  homeassistant/.storage/auth \
  homeassistant/.storage/auth_provider.homeassistant \
  homeassistant/.storage/http.auth \
  homeassistant/.storage/cloud \
  homeassistant/.cloud \
  nodered/flows_cred.json \
  nodered/.config.users.json \
  nodered/.config.runtime.json \
  mosquitto/config/password.txt \
  zigbee2mqtt/configuration.yaml \
  zigbee2mqtt/coordinator_backup.json \
  zigbee2mqtt/database.db \
  portainer
```

Criptografe antes de enviar para nuvem:

```bash
gpg -c /mnt/data/secure-backups/smart-home-secrets-$(date +%F).tar.gz
```

Guarde a senha fora do Raspberry Pi.

## 25. Restauracao completa em outro Raspberry Pi

Resumo pratico:

```bash
# 1. Instalar pacotes
sudo apt-get update
sudo apt-get install -y git curl jq sqlite3 ripgrep mosquitto-clients cron

# 2. Instalar Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker gabriel

# 3. Reentrar na sessao SSH
exit
ssh gabriel@IP_DO_PI

# 4. Clonar repo
sudo mkdir -p /mnt/data
sudo chown gabriel:gabriel /mnt/data
cd /mnt/data
git clone git@github.com:gabrafur/my_smart_home.git docker

# 5. Restaurar segredos de backup seguro
cd /mnt/data/docker
# copiar .env, .local-secrets, secrets.yaml, flows_cred.json,
# password.txt, zigbee2mqtt/configuration.yaml etc.

# se .env/.local-secrets nao foram restaurados, gere novamente:
node scripts/setup-node-red-security.mjs

# opcional/recomendado se voce quiser senha MQTT nova:
node scripts/rotate-mqtt-password.mjs

# 6. Subir containers
docker compose pull
docker compose up -d

# 7. Verificar
docker ps
docker logs --tail 100 homeassistant
docker logs --tail 100 nodered
docker logs --tail 100 zigbee2mqtt
```

### 25.1. Prompt de IA para restauracao guiada

Use este prompt em uma IA com acesso ao terminal do novo host. Cole junto deste documento e, se possivel, informe o IP novo do Raspberry Pi e onde esta o backup seguro dos segredos.

```text
Voce e um agente de restauracao da minha casa inteligente. Trabalhe no Linux local com cuidado, sem apagar dados existentes sem confirmar comigo.

Objetivo: restaurar completamente minha stack de casa inteligente a partir do repositorio git@github.com:gabrafur/my_smart_home.git usando Docker Compose.

Contexto fixo:
- Diretorio alvo: /mnt/data/docker
- Usuario operacional: gabriel
- Timezone: America/Sao_Paulo
- Stack: Home Assistant, Node-RED, Mosquitto, Zigbee2MQTT, AppDaemon e Portainer
- Coordenador Zigbee de rede: tcp://192.168.0.197:7638
- O repositorio versiona configuracoes e scripts, mas nao versiona segredos/runtime.

Tarefas:
1. Verificar Linux, usuario, Docker, Docker Compose, git, curl, jq, sqlite3, ripgrep, mosquitto-clients e cron.
2. Criar /mnt/data se necessario e clonar ou atualizar /mnt/data/docker a partir do GitHub.
3. Ler docs/INSTALACAO_RESTAURACAO_SMART_HOME.md antes de alterar arquivos.
4. Conferir .gitignore e garantir que segredos nao serao enviados ao Git.
5. Restaurar de backup seguro, se disponivel:
   - .env
   - .local-secrets/
   - homeassistant/secrets.yaml
   - homeassistant/.storage/auth
   - homeassistant/.storage/auth_provider.homeassistant
   - homeassistant/.storage/http.auth
   - nodered/flows_cred.json
   - nodered/.config.runtime.json
   - nodered/.config.users.json
   - mosquitto/config/password.txt
   - zigbee2mqtt/configuration.yaml
   - zigbee2mqtt/coordinator_backup.json
   - zigbee2mqtt/database.db
   - portainer/
6. Se .env ou .local-secrets nao existirem, executar node scripts/setup-node-red-security.mjs.
7. Se for necessario trocar ou recriar senha MQTT, executar node scripts/rotate-mqtt-password.mjs e reiniciar mosquitto, zigbee2mqtt, nodered e homeassistant.
8. Validar:
   - docker compose config --quiet
   - npm run flows:validate em /mnt/data/docker/nodered
   - docker compose up -d
   - docker compose ps
   - logs de homeassistant, nodered, zigbee2mqtt e mosquitto
9. Testar MQTT com a senha em .local-secrets/mqtt-gabriel-password.txt:
   - mosquitto_sub em zigbee2mqtt/bridge/state deve retornar online.
10. Confirmar que Node-RED pede login e que /settings sem autenticacao retorna 401.
11. Confirmar que o backup Git automatico existe no crontab e que scripts/git-backup.sh roda sem erro.
12. No final, relatar:
   - containers ativos
   - URLs locais
   - usuario do Node-RED
   - caminho local da senha do Node-RED, sem imprimir a senha
   - estado do backup Git
   - pendencias ou alertas restantes.
```

## 26. Comandos de diagnostico rapido

### Docker

```bash
docker ps
docker compose ps
docker compose logs --tail=100
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' nodered
```

### Home Assistant

```bash
docker logs --tail 200 homeassistant
docker exec homeassistant python3 -m homeassistant --script check_config --config /config
```

### Node-RED

```bash
cd /mnt/data/docker/nodered
npm run flows:validate
npm run flows:summary
docker logs --tail 200 nodered
```

Login do editor:

```bash
cat /mnt/data/docker/.env | grep '^NODE_RED_ADMIN_USER='
cat /mnt/data/docker/.local-secrets/node-red-admin-password.txt
```

No ambiente atual, o usuario configurado e `gabriel`. A senha fica apenas no arquivo local acima e nao entra no Git.

### MQTT

```bash
MQTT_PASSWORD="$(tr -d '\n' < /mnt/data/docker/.local-secrets/mqtt-gabriel-password.txt)"
mosquitto_sub -h 192.168.0.205 -p 1883 -u gabriel -P "$MQTT_PASSWORD" -t '#' -v
```

### Zigbee2MQTT

```bash
docker logs --tail 200 zigbee2mqtt
MQTT_PASSWORD="$(tr -d '\n' < /mnt/data/docker/.local-secrets/mqtt-gabriel-password.txt)"
mosquitto_sub -h 192.168.0.205 -p 1883 -u gabriel -P "$MQTT_PASSWORD" -t 'zigbee2mqtt/bridge/state' -C 1
```

### Tailscale

```bash
tailscale status
tailscale ip -4
tailscale netcheck
systemctl status tailscaled
```

### Git backup

```bash
cd /mnt/data/docker
git status --short --branch
scripts/git-backup.sh
tail -50 .git-backup.log
crontab -l
```

Backup saudavel deve mostrar:

- `scripts/git-backup.sh` terminando sem erro;
- `.git-backup.log` com `backup finished: pushed ...` ou `backup finished: no changes`;
- `git status --short` vazio depois de um backup com push;
- `crontab -l` contendo `/mnt/data/docker/scripts/git-backup.sh`.

## 27. Troubleshooting

### Container nao sobe

```bash
cd /mnt/data/docker
docker compose config
docker compose up -d
docker compose logs --tail=200 SERVICO
```

### Node-RED mostra nodes faltando

```bash
cd /mnt/data/docker/nodered
npm ci
docker restart nodered
docker logs --tail 100 nodered
```

### Node-RED perdeu credenciais

Verifique:

```bash
ls -l /mnt/data/docker/nodered/flows_cred.json
```

Se nao existir, restaure do backup seguro. Sem ele, edite as credenciais pela UI.

Confirme tambem se `.env` existe e se o segredo do Node-RED foi gerado:

```bash
cd /mnt/data/docker
ls -l .env .local-secrets/node-red-admin-password.txt
node scripts/setup-node-red-security.mjs
docker compose up -d nodered
```

### Zigbee2MQTT nao conecta no coordenador

Verifique conectividade:

```bash
nc -vz 192.168.0.197 7638
```

Verifique `configuration.yaml`:

```bash
grep -nA8 '^serial:' /mnt/data/docker/zigbee2mqtt/configuration.yaml
```

Veja logs:

```bash
docker logs --tail 200 zigbee2mqtt
```

### MQTT recusando conexao

Verifique senha:

```bash
ls -l /mnt/data/docker/mosquitto/config/password.txt
docker logs --tail 100 mosquitto
```

Recrie se necessario:

```bash
cd /mnt/data/docker
node scripts/rotate-mqtt-password.mjs
docker compose restart mosquitto zigbee2mqtt nodered homeassistant
```

### Home Assistant pede login novo

Provavel falta dos arquivos:

```bash
homeassistant/.storage/auth
homeassistant/.storage/auth_provider.homeassistant
homeassistant/.storage/http.auth
```

Restaure de backup seguro ou recrie usuarios pela UI.

### Tailscale nao anuncia rota LAN

```bash
sudo tailscale up --advertise-routes=192.168.0.0/24 --ssh --hostname=raspbery-gabriel
tailscale status
```

Depois aprove a rota no painel Tailscale.

### Git backup aborta por arquivo suspeito

Veja o log:

```bash
tail -100 /mnt/data/docker/.git-backup.log
```

Se um arquivo sensivel apareceu staged por engano:

```bash
cd /mnt/data/docker
git reset
```

Adicione o padrao ao `.gitignore`, depois rode:

```bash
scripts/git-backup.sh
```

## 28. Checklist final

Depois de restaurar tudo:

```bash
cd /mnt/data/docker
git status --short --branch
docker compose ps
docker ps
docker logs --tail 50 homeassistant
docker logs --tail 50 nodered
docker logs --tail 50 zigbee2mqtt
tailscale status
crontab -l
```

Checklist visual:

- Home Assistant abre em `http://IP_DO_PI:8123`.
- Node-RED abre em `http://IP_DO_PI:1880`.
- Zigbee2MQTT abre em `http://IP_DO_PI:8080`.
- Portainer abre em `http://IP_DO_PI:9000`.
- MQTT aceita usuario/senha.
- Dispositivos Zigbee aparecem no Zigbee2MQTT.
- Home Assistant recebe entidades MQTT.
- Fluxos Node-RED estao ativos.
- Tailscale acessa o host remotamente.
- Backup Git diario existe no `crontab`.
- Segredos estao guardados fora do Git.
