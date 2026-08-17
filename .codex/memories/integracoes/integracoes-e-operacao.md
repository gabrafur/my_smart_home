# Integrações e operação

## Veículo principal / Kia UVO

A integração local de `vehicle_primary`, o intervalo de wake/refresh e as
entidades de viagens são intencionais. Confirme os IDs atuais na configuração
antes de conectá-los a uma automação e consulte
`docs/VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md` para versões e detalhes de implementação
vigentes.

Wakes manuais e automáticos compartilham o mesmo coordenador e o piso definido
no código; não crie timers paralelos. Movimento significativo pode solicitar
refresh, mas nunca serve sozinho como evidência para ações físicas.

Atualizações usam `scripts/kia-uvo-safe-update.mjs`: `check` prepara e verifica
a nova versão em staging; `apply` é explícito, faz backup, usa o instalador
HACS, reaplica o delta versionado e possui rollback. A rotina automática pode
detectar e analisar, mas nunca instala esse componente cegamente.

## MQTT

Não altere credenciais manualmente em consumidores individuais. Use
`scripts/rotate-mqtt-password.mjs` e siga
`docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` para sincronizar os serviços sem
expor segredos.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.
