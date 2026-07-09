# Controle de energia pelo Home Assistant

## Entidades criadas

- `script.raspberry_reiniciar`
- `script.raspberry_desligar`
- `script.pc_reiniciar`
- `script.pc_desligar`

## Raspberry

O Raspberry usa o D-Bus do host, via `org.freedesktop.login1`, para chamar:

- `Reboot(false)`
- `PowerOff(false)`

Esse caminho depende do Home Assistant Container com acesso a `/run/dbus` do
host. O mesmo acesso tambem e necessario para Bluetooth local no Home Assistant
Container.

Teste sem desligar nada:

```bash
docker exec homeassistant python3 /config/tools/power_control.py raspberry reboot --dry-run
```

## PC Windows

O Home Assistant usa SSH para mandar os comandos:

- reiniciar: `shutdown /r /t 0`
- desligar: `shutdown /s /t 0`

Segredos usados em `homeassistant/secrets.yaml`:

- `pc_power_host`
- `pc_power_user`
- `pc_power_port`
- `pc_power_os`
- `pc_power_ssh_key`

A chave publica que deve ser autorizada no Windows fica em:

```text
homeassistant/.ssh/ha_power_ed25519.pub
```

No Windows, habilite o OpenSSH Server e autorize essa chave para o usuario
configurado em `pc_power_user`. Nesta instalacao, o PC esta configurado como
`gabra@192.168.0.153:22`. Depois valide a partir do Raspberry:

```bash
docker exec homeassistant ssh -i /config/.ssh/ha_power_ed25519 -p 22 -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new gabra@192.168.0.153 hostname
```

Quando esse teste responder, os scripts `script.pc_reiniciar` e
`script.pc_desligar` estarao prontos para uso.
