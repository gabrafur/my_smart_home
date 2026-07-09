# Bluetooth e Matter no Home Assistant

## Requisitos no host (Raspberry Pi / DietPi)

O adaptador Bluetooth onboard (Broadcom BCM4345C0/BCM43438-BT) precisa do
BlueZ rodando no host e do firmware carregado antes que o container do Home
Assistant consiga usa-lo via D-Bus (`/run/dbus`, ja montado no container).

Pacotes necessarios:

```bash
sudo apt-get install -y bluez pi-bluetooth firmware-brcm80211
```

Depois de instalar o `firmware-brcm80211` pela primeira vez, o kernel ja fez
o probe do `hci0` sem o arquivo de firmware disponivel (fica com o MAC
placeholder `AA:AA:AA:AA:AA:AA`). Para forcar o recarregamento sem reiniciar
o Raspberry:

```bash
echo serial0-0 | sudo tee /sys/bus/serial/drivers/hci_uart_bcm/unbind
sleep 1
echo serial0-0 | sudo tee /sys/bus/serial/drivers/hci_uart_bcm/bind
```

Verifique se pegou o MAC real (nao mais `AA:AA:AA:AA:AA:AA`):

```bash
hciconfig -a
```

## Requisitos no docker-compose.yml

- `homeassistant`: precisa de `cap_add: [NET_ADMIN, NET_RAW]` e do mount
  `/run/dbus:/run/dbus:ro`. Se o container ja existia antes dessas linhas
  serem adicionadas ao compose, ele continua rodando com as permissoes
  antigas ate ser recriado — `docker compose up -d homeassistant` (nao basta
  `restart`).
- `matter_server`: roda em `network_mode: host` com `/run/dbus` montado. Ele
  so aparece em `docker ps` depois de `docker compose up -d matter_server` —
  o `depends_on` nao sobe o container sozinho na primeira vez.

## Finalizando a configuracao dentro do Home Assistant

O adaptador Bluetooth local nao aparece sozinho como "descoberto" na UI —
ele so recebe uma config entry quando o fluxo de configuracao do dominio
`bluetooth` e iniciado (automaticamente no boot, se tudo estiver certo, ou
manualmente). Se a entrada Bluetooth antiga ficou "ignorada" com o MAC
placeholder, ela precisa ser removida (Configuracoes > Dispositivos e
Servicos > Ignorados) antes que a nova apareca.

Via API (com um Long-Lived Access Token, guardado em
`.local-secrets/ha-long-lived-token.txt`, nunca commitado):

```bash
TOKEN=$(cat /mnt/data/docker/.local-secrets/ha-long-lived-token.txt)

# Bluetooth
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"handler":"bluetooth"}' \
  http://localhost:8123/api/config/config_entries/flow
# pega o flow_id da resposta e confirma:
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:8123/api/config/config_entries/flow/<flow_id>

# Matter (aponta para o matter_server, que roda em host network na porta 5580)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"handler":"matter"}' \
  http://localhost:8123/api/config/config_entries/flow
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"ws://localhost:5580/ws"}' \
  http://localhost:8123/api/config/config_entries/flow/<flow_id>
```

Depois disso, dispositivos Matter/BLE que ficavam presos em "descoberto"
completam a configuracao normalmente pela UI.
