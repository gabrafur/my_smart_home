# Integrações e operação

## Creta / Kia UVO

A integração local, o intervalo de wake/refresh e as entidades de viagens são
intencionais. Confirme os IDs de entidade atuais antes de conectá-los a uma
automação e consulte `docs/CRETA_KIA_UVO_INTEGRATION.md`.

## MQTT

Não altere credenciais manualmente em consumidores individuais. Use
`scripts/rotate-mqtt-password.mjs` e siga
`docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` para sincronizar os serviços sem
expor segredos.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.
