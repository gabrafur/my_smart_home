# Integrações e operação

## Creta / Kia UVO

A integração local, o intervalo de wake/refresh e as entidades de viagens são
intencionais. Confirme os IDs de entidade atuais antes de conectá-los a uma
automação e consulte `docs/CRETA_KIA_UVO_INTEGRATION.md`.

Desde 2026-08-16, a base e `kia_uvo` 3.10.0 com API 4.26.1. O CCS2, wake e
timestamp UTC do Creta BR vem do upstream; localmente permanecem viagens de
dois dias, estimativa conservadora de consumo, compatibilidade de autonomia e
o piso de 15 minutos entre wakes solicitados pelo botao/Node-RED. Movimento
significativo solicita refresh, mas nunca serve sozinho como evidencia para
acoes fisicas.

## MQTT

Não altere credenciais manualmente em consumidores individuais. Use
`scripts/rotate-mqtt-password.mjs` e siga
`docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` para sincronizar os serviços sem
expor segredos.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.
