# Instalação e restauração da casa inteligente

[Português (principal)](INSTALACAO_RESTAURACAO_SMART_HOME.md) · [English](INSTALLATION_RESTORE.en.md)

Este runbook reconstrói a stack em um host Linux usando o conteúdo versionado
e, quando disponível, um backup privado. Ele não pressupõe nome de usuário, IP
ou caminho absoluto específico.

## Fluxo determinístico canônico

O inventário de estado privado, formato de bundle, checksums, ordem e rollback
estão em [RESTORE_CONTRACT.md](RESTORE_CONTRACT.md). Para clone novo, módulos e
demo, consulte [BOOTSTRAP_DEMO.md](BOOTSTRAP_DEMO.md).

```bash
make backup-plan
make restore-test
make bootstrap-test
make demo-test
```

Com bundle externo, execute `restore-plan` e `restore-verify` antes de solicitar
autorização para qualquer apply. Esses comandos não iniciam containers.

## 1. O que um clone consegue restaurar

Há dois resultados possíveis:

- **Instalação nova:** os containers iniciam e a configuração declarativa é
  carregada, mas usuários, dispositivos, credenciais e redes precisam ser
  cadastrados novamente.
- **Restauração:** além do clone, os volumes e arquivos privados retornam de um
  backup seguro, preservando identidades e estado compatíveis.

O Git nunca é um backup completo da casa. Em especial, uma rede Zigbee
existente depende da chave, PAN IDs, banco e backup do coordenador originais;
uma fabric Matter depende de `matter-server/`; e o Home Assistant depende de
`.storage/` para usuários, registros e integrações configuradas pela UI.

## 2. Requisitos

- Linux Debian/DietPi/Raspberry Pi OS recente;
- Docker Engine 23 ou superior e plugin Docker Compose;
- Git, Node.js, npm, OpenSSL e, para diagnóstico, `jq`, `ripgrep` e clientes
  Mosquitto;
- acesso à internet para baixar imagens e construir o bridge;
- no Raspberry Pi, `/usr/bin/vcgencmd` para as métricas do host;
- D-Bus e rede IPv6/mDNS funcionais para Bluetooth/Matter.

Home Assistant Container não inclui Supervisor nem apps/add-ons. Cada serviço
que seria um add-on em Home Assistant OS é administrado explicitamente pelo
Compose deste repositório.

Instale pacotes básicos em Debian:

```bash
sudo apt-get update
sudo apt-get install -y git nodejs npm openssl jq ripgrep mosquitto-clients
```

Instale Docker pelo repositório oficial da sua distribuição e confirme:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Adicione o usuário operacional ao grupo Docker e abra uma nova sessão:

```bash
sudo usermod -aG docker "$USER"
```

> O socket Docker concede privilégios administrativos no host. Restrinja o
> grupo `docker`, Portainer e o bridge a usuários confiáveis.

## 3. Clone

Escolha um caminho persistente com espaço para bancos e backups:

```bash
git clone URL_DO_REPOSITORIO smart-home
cd smart-home
export REPO_DIR="$PWD"
```

Os mounts do Compose e os scripts operacionais são relativos ao repositório;
`/mnt/data/docker` não é mais obrigatório.

Em hardware que não seja Raspberry Pi, remova ou comente o bind de
`/usr/bin/vcgencmd` no serviço `homeassistant` e desabilite os sensores que
dependem desse comando.

## 4. Arquivos privados

| Caminho | Instalação nova | Restauração |
| --- | --- | --- |
| `.env` | copiar do exemplo e gerar valores | restaurar ou revisar o backup |
| `homeassistant/secrets.yaml` | copiar do exemplo e preencher | restaurar |
| `homeassistant/.storage/` | criado no onboarding | restaurar inteiro, com HA parado |
| `.local-secrets/appdaemon-secrets.yaml` | copiar do exemplo | restaurar |
| `mosquitto/config/password.txt` | criar com `mosquitto_passwd` | restaurar ou rotacionar |
| `zigbee2mqtt/configuration.yaml` | copiar do exemplo | restaurar junto da rede existente |
| `zigbee2mqtt/database.db` e `coordinator_backup.json` | criados pelo serviço | restaurar |
| `nodered/flows_cred.json` | criado ao configurar credenciais | restaurar com o mesmo `credentialSecret` |
| `matter-server/` | criado pelo serviço | restaurar inteiro |
| `portainer/` | onboarding novo | restaurar inteiro |

Todos esses caminhos são ignorados pelo Git. Confirme antes de continuar:

```bash
git check-ignore .env homeassistant/secrets.yaml .local-secrets/appdaemon-secrets.yaml
git check-ignore nodered/flows_cred.json zigbee2mqtt/configuration.yaml
```

## 5. Preparar `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Edite o arquivo e ajuste:

- `HOST_LAN_IP`: IP estável do host na LAN. Deixe vazio ou use `127.0.0.1`
  durante uma preparação que não deve ser acessível pela rede;
- `DOCKER_GID`: resultado de `stat -c '%g' /var/run/docker.sock`;
- `TZ`: fuso IANA;
- coordenadas do fluxo Node-RED somente se a automação de chegada for usada;
- tokens do bridge somente se esse recurso for habilitado;
- para a revisão semanal, `REPO_UID`/`REPO_GID` do proprietário do checkout e
  os caminhos absolutos de uma chave SSH exclusiva com push restrito ao
  repositório e de seu `known_hosts`.

Gere o token compartilhado do bridge sem imprimir o `.env` depois:

```bash
openssl rand -hex 32
```

Cole o resultado em `AI_BRIDGE_TOKEN`. Para Claude Code por assinatura,
gere o token OAuth conforme o guia [CHAT_CLAUDE_CODE_HA.md](CHAT_CLAUDE_CODE_HA.md).
Não é necessário manter `ANTHROPIC_API_KEY` no `.env`.

Prepare a autenticação do Node-RED:

```bash
node scripts/setup-node-red-security.mjs
```

O script aceita clone novo: gera `credentialSecret`, hash bcrypt e senha de
admin se não houver runtime anterior. A senha legível fica somente em
`.local-secrets/node-red-admin-password.txt`.

Quando os arquivos SSH padrão existem, o mesmo script preenche seus caminhos e
o UID/GID do checkout sem copiar credenciais para o repositório. Antes de
ativar o agendador, autentique também o Codex no volume do bridge. O procedimento
completo está em [Revisão semanal da documentação](REVISAO_DOCUMENTACAO_SEMANAL.md).

## 6. Home Assistant e AppDaemon

```bash
cp homeassistant/secrets.yaml.example homeassistant/secrets.yaml
cp templates/appdaemon/secrets.yaml.example .local-secrets/appdaemon-secrets.yaml
chmod 600 homeassistant/secrets.yaml .local-secrets/appdaemon-secrets.yaml
```

Preencha coordenadas e integrações realmente usadas. Se não usar Moni Mobile,
remova ou desabilite `homeassistant/packages/moni_mobile_alarm.yaml`; valores
`CHANGE_ME` servem apenas para deixar explícito o que falta, não para produção.

As coordenadas do AppDaemon ficam em
`.local-secrets/appdaemon-secrets.yaml`. O Compose monta a configuração de
`templates/appdaemon/appdaemon.yaml` e o segredo como somente leitura sobre o
volume de runtime, evitando tanto o vazamento quanto problemas de ownership.

Em uma restauração, copie `.storage/` e o banco somente com o Home Assistant
parado. Preserve proprietário e permissões do backup.

## 7. Mosquitto

O broker rejeita conexões anônimas e não inicia corretamente sem seu arquivo de
senha. Para uma instalação nova, escolha o mesmo usuário de `MQTT_USER` e rode:

```bash
mkdir -p mosquitto/data mosquitto/log
docker run --rm -it --user root \
  -v "$PWD/mosquitto/config:/mosquitto/config" \
  eclipse-mosquitto@sha256:6f8d8a947c506f8a2290ec65cd4bd2bc7cb4d43fb5f6271f861cb013e2ef9797 \
  mosquitto_passwd -c /mosquitto/config/password.txt smart_home
chmod 600 mosquitto/config/password.txt
```

Se alterar `MQTT_USER`, substitua `smart_home` no comando. A mesma combinação
de usuário/senha deve ser configurada no Zigbee2MQTT, no Home Assistant e nos
nodes MQTT do Node-RED.

Em uma restauração, prefira copiar `password.txt`. Use
`scripts/rotate-mqtt-password.mjs` somente depois de restaurar todos os
consumidores que ele atualiza; esse script não é um bootstrap de clone vazio.

## 8. Zigbee2MQTT

```bash
cp zigbee2mqtt/configuration.example.yaml zigbee2mqtt/configuration.yaml
chmod 600 zigbee2mqtt/configuration.yaml
```

Edite:

- `mqtt.user` e `mqtt.password`;
- `serial.port` e `serial.adapter`;
- canal e potência compatíveis com o coordenador.

Para uma rede **nova**, mantenha `network_key`, `pan_id` e `ext_pan_id` como
`GENERATE`; o Zigbee2MQTT grava valores aleatórios no primeiro start. Para uma
rede **existente**, restaure os valores originais e o backup do coordenador.
Alterá-los pode exigir novo pareamento de todos os dispositivos.

O endereço `192.0.2.10` do exemplo é reservado para documentação e não deve ser
usado literalmente. Adaptadores de rede precisam de IP/hostname estável;
adaptadores USB devem preferir `/dev/serial/by-id/...` e um mapping `devices:`
no Compose.

O flow `monitoramento_zigbee` assume o base topic `zigbee2mqtt` e requer a
disponibilidade habilitada no arquivo privado:

```yaml
availability:
  enabled: true
```

Confirme também os destinos do subflow `Notificar todos os dispositivos móveis`
e execute `npm --prefix nodered run flows:test-infrastructure`. As entidades
`binary_sensor.internet_connection` e `binary_sensor.zigbee_network` são
descobertas por MQTT depois do Node-RED iniciar. Veja o guia de
[monitoramento de infraestrutura](ZIGBEE_HEALTH_NOTIFICATIONS.md).

## 9. Dependências Node

```bash
npm --prefix nodered ci
npm --prefix nodered run flows:validate
npm --prefix nodered run test:all
npm --prefix ia-bridge test
```

O volume `./nodered:/data` inclui o projeto. `node_modules/` não é versionado e
é reconstruído por `npm ci`.

## 10. Validar e construir

Não use `docker compose config` sem cuidado em logs públicos: a saída expandida
pode incluir valores do `.env`. Prefira o modo silencioso:

```bash
docker compose config --quiet
scripts/security-scan.sh
node scripts/docs-check.mjs
docker compose pull
docker compose build --pull ai-bridge
```

O primeiro build do bridge baixa pacotes APT e npm. A imagem-base e os CLIs são
fixados; o GID do socket é aplicado em runtime por `group_add`.

## 11. Subir e verificar

```bash
docker compose up -d
docker compose ps
```

`depends_on` não espera prontidão. Acompanhe os primeiros logs:

```bash
docker compose logs --tail=100 mosquitto zigbee2mqtt
docker compose logs --tail=100 homeassistant matter_server
docker compose logs --tail=100 nodered appdaemon
docker compose logs --tail=100 portainer ai-bridge
```

Endpoints locais:

| Serviço | URL |
| --- | --- |
| Home Assistant | `http://IP_DO_HOST:8123` |
| Node-RED | `http://IP_DO_HOST:1880` |
| Zigbee2MQTT | `http://IP_DO_HOST:8080` |
| Portainer | `http://IP_DO_HOST:9000` |
| Bridge | `http://127.0.0.1:8099` |

Não encaminhe essas portas no roteador. Para acesso remoto, use VPN com ACLs e
MFA. O bridge permanece em loopback mesmo quando os demais serviços estão na
LAN.

## 12. Onboarding de uma instalação nova

1. Crie o primeiro usuário do Home Assistant.
2. Configure a integração MQTT com o usuário e senha do Mosquitto.
3. Configure no Node-RED o servidor Home Assistant e as credenciais MQTT; isso
   cria `flows_cred.json`.
4. Confirme que Zigbee2MQTT publica `zigbee2mqtt/bridge/state = online`.
5. Configure Matter em `ws://127.0.0.1:5580/ws`, entendendo as limitações do
   container autogerenciado.
6. Crie o usuário do Portainer ou restaure seu volume.
7. Configure o bridge apenas se necessário; ele possui acesso ao workspace e
   ao socket Docker e deve ser tratado como serviço administrativo.
8. Se habilitar a revisão semanal, confirme no log a próxima data e rode o
   preflight `--check` descrito no guia do agendador.

Algumas entidades referenciadas pelos YAML/flows não existirão em uma casa
diferente. Desabilite packages e abas não utilizados ou adapte os entity IDs.

## 13. Validação funcional

```bash
docker exec homeassistant python3 -m homeassistant --script check_config --config /config
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' nodered
```

Teste MQTT sem colocar a senha no histórico do shell: prefira o prompt
interativo do cliente ou um arquivo protegido. Confirme:

- autenticação anônima recusada;
- publicação e assinatura autenticadas;
- `zigbee2mqtt/bridge/state` online;
- alertas Zigbee carregados, sem falsas recuperações no startup;
- editor Node-RED exige login;
- Home Assistant recebe entidades MQTT;
- AppDaemon carrega sem erro de segredo;
- bridge responde a `/health` somente em loopback;
- agendador documental mostra a próxima execução e passa no preflight.

Automação que movimenta portão, desarma alarme, liga veículo ou corta energia
exige teste controlado presencial. Não use um smoke test genérico para atuadores
físicos.

## 14. Backup privado

Com os serviços parados ou usando snapshots consistentes, preserve:

- `.env`, `.local-secrets/` e todos os `secrets.yaml`;
- `homeassistant/.storage/`, banco e backups necessários;
- `nodered/flows_cred.json` e arquivos de autenticação;
- `mosquitto/config/password.txt` e, se necessário, seu banco persistente;
- `zigbee2mqtt/configuration.yaml`, `database.db` e
  `coordinator_backup.json`;
- `matter-server/` e `portainer/`.
- credencial SSH exclusiva do agendador, armazenada fora do checkout.

Criptografe antes de enviar para armazenamento externo, teste a restauração e
guarde a chave fora do Raspberry Pi. Git, mesmo privado, não é local adequado
para esses arquivos.

## 15. Atualização

Faça um dry-run:

```bash
node scripts/docker-auto-update.mjs daily --dry-run
```

Depois de revisar o resultado e garantir backup:

```bash
node scripts/docker-auto-update.mjs daily
scripts/install-storage-maintenance-cron.sh
```

O script resolve tags de canal para digests, atualiza o Compose, valida e
recria. Leia notas de versão antes de migrações de banco ou protocolo. O Matter
Server legado não deve ser trocado pelo sucessor matter.js sem plano específico
de migração da fabric.

## 16. Diagnóstico

```bash
docker compose ps
docker compose logs --tail=200 SERVICO
docker compose config --quiet
git status --short
```

Problemas comuns:

- **porta indisponível:** confira `HOST_LAN_IP` e se o endereço pertence ao
  host;
- **bridge sem Docker:** corrija `DOCKER_GID` e recrie apenas o bridge;
- **Mosquitto recusando:** confirme `password.txt`, usuário nos três
  consumidores e permissões;
- **Zigbee2MQTT mismatch:** restaure chave/PAN IDs e backup do mesmo
  coordenador; não apague o backup se quiser preservar a rede;
- **Node-RED sem credenciais:** restaure `flows_cred.json` com o mesmo
  `NODE_RED_CREDENTIAL_SECRET` ou reconfigure pela UI;
- **Home Assistant pede novo login:** `.storage/auth*` não foi restaurado;
- **Matter não descobre:** verifique IPv6, mDNS, D-Bus e rede do host;
- **`vcgencmd` ausente:** adapte o Compose para hardware não Raspberry Pi.
- **agendador recusou execução:** confirme árvore limpa, branch, autenticação
  Codex, chave Git com push e UID/GID do checkout.

## 17. Checklist final

- `docker compose config --quiet` passa;
- testes Node-RED e bridge passam;
- scanner de segurança e verificador de docs passam;
- todos os containers esperados estão `running`;
- UI administrativa não está exposta à internet;
- MQTT anônimo está bloqueado;
- segredos e volumes privados continuam ignorados;
- backup criptografado foi testado;
- ações físicas críticas foram validadas presencialmente.
- agendador documental está parado ou tem credenciais restritas e preflight
  aprovado.
