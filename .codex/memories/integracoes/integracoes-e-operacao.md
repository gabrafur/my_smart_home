# Integrações e operação

## Creta / Kia UVO

A integração local, o intervalo de wake/refresh e as entidades de viagens são
intencionais. Confirme os IDs de entidade atuais antes de conectá-los a uma
automação e consulte `docs/CRETA_KIA_UVO_INTEGRATION.md`.

Desde 2026-08-16, a base e `kia_uvo` 3.10.1 com API 4.26.5. O CCS2, wake e
timestamp UTC do Creta BR vem do upstream; localmente permanecem viagens de
dois dias, estimativa conservadora de consumo, compatibilidade de autonomia e
o piso de 15 minutos entre wakes solicitados pelo botao/Node-RED. Movimento
significativo solicita refresh, mas nunca serve sozinho como evidencia para
acoes fisicas.

O estado de refresh continua centralizado em `security_creta_refresh_v1` e e
espelhado em `contexto_creta.refresh`/`sensor.creta_refresh_coordinator`. O
botao manual entra no mesmo ciclo com `reason=manual_force`. Buzina+luzes usa
somente o comando oficial, lock global, confirmacao visual e hold no dashboard.

Atualizacoes futuras usam `scripts/kia-uvo-safe-update.mjs`: `check` monta a
nova versao em staging e bloqueia conflitos; `apply` e explicito, faz backup,
usa o instalador HACS, reaplica o delta versionado e possui rollback. O cron
detecta e analisa, mas nunca instala esse componente cegamente.

## MQTT

Não altere credenciais manualmente em consumidores individuais. Use
`scripts/rotate-mqtt-password.mjs` e siga
`docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` para sincronizar os serviços sem
expor segredos.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.
