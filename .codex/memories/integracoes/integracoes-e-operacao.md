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

O Node-RED é o único agendador de wakes reais do `vehicle_primary`. O
coordinator `kia_uvo` do Home Assistant continua consultando o cache a cada 15
minutos para publicar as entidades, mas não executa force refresh periódico.
O backend brasileiro aplica backoff progressivo de 15 minutos a 6 horas quando
retorna rate limit; durante esse prazo, polling, wakes e releituras tardias não
fazem novas chamadas. O estado é compartilhado entre recriações do coordinator
durante retry de setup, para que uma nova instância não burle o prazo. O
dashboard e as automações continuam tratando a idade da telemetria como
evidência obrigatória, sem promover cache antigo a estado atual.
Na biblioteca 4.27.2, o refresh token genérico não conhece os atributos e o
formato de bearer do cliente BR. A camada local adapta esse contrato e impede
que um `5091` no refresh dispare login completo na mesma tentativa.
Agendamento, manual, recovery, chegada e movimento convergem no estado
persistente do Node-RED; retorno do serviço é apenas aceite e sucesso exige
timestamp novo de localização, motor ou trava. A integração e o fluxo mantêm
locks/lease para uma única chamada em andamento e backoff 1, 2, 4, 8, 15 min.
Depois da primeira tentativa sem evidência, o ciclo envia um único alerta ao
papel `resident_primary`; novas tentativas do mesmo incidente não repetem o
push, e uma atualização confirmada libera o alerta do próximo incidente.

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

## Armazenamento do host

- O crescimento rápido observado vem principalmente de camadas de build
  grandes criadas entre execuções, não de volumes Docker ou logs de
  contêineres. Confirme novamente com métricas antes de atribuir uma regressão
  futura à mesma causa.
- `scripts/storage-maintenance.sh` só pode limitar cache BuildKit sem uso e
  imagens dangling antigas; volumes, contêineres, imagens tagged, backups e
  bancos permanecem fora do escopo automático.
- A política preventiva roda a cada seis horas com prioridade reduzida, limite
  de 2 GB e idade mínima de 24 h. `--apply` também falha fechado sob pressão de
  memória ou filesystem; o caminho manual coalescente continua disponível.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.
