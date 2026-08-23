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

## Moni Mobile / security_panel

O código da integração Moni Mobile tem fonte canônica no repositório público
[`gabrafur/moni_mobile_home_assistant`](https://github.com/gabrafur/moni_mobile_home_assistant),
sob licença MIT, com cabeçalhos SPDX nos fontes Python. Este monorepo mantém o
package YAML e o helper operacional, mas o diretório de runtime da integração é
instalado pelo HACS e ignorado pelo Git; não reintroduza uma cópia rastreada que
possa divergir. O guia vigente é
[`docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md`](../../../docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md).

A extração preservou o schema YAML e o `unique_id` baseado no endpoint para não
duplicar a entidade existente. O código de comando deve permanecer texto para
preservar zeros à esquerda. No protocolo legado observado, a autenticação do
comando usa esse código; usuário e senha continuam no contrato de configuração,
mas não são transmitidos pelo estágio atualmente implementado. Confirme o
código vigente antes de ampliar ou remover esses campos.

O cliente TCP é síncrono por intenção e deve continuar em jobs do executor. O
wire protocol exige AES-ECB com chave fixa e token novo de dois bytes por
conexão; nunca registre credenciais, tokens ou payloads descriptografados, pois
eles podem conter eventos e zonas privadas. A leitura de estado reconhece os
bytes de partição observados e possui fallback textual; uma resposta válida que
não corresponda a esses formatos resulta em `unknown`. Depois de um comando
aceito, a entidade publica estado otimista e o polling posterior o reconcilia.

Distribuições devem passar testes unitários, hassfest e HACS Action sem checks
ignorados antes de uma release. Desde Home Assistant 2026.3, custom integrations
novas distribuem ícones em `custom_components/<domain>/brand/`; não abra PR em
`home-assistant/brands/custom_integrations`, que se tornou legado. Smoke tests
de atualização não incluem armar ou desarmar o `security_panel` sem autorização
explícita para a ação física.

## MQTT

Não altere credenciais manualmente em consumidores individuais. Use
`scripts/rotate-mqtt-password.mjs` e siga
`docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` para sincronizar os serviços sem
expor segredos.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.
