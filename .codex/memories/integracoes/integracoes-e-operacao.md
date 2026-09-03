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
Uma recusa HTTP 403 também entra nesse mesmo backoff em todos os endpoints. O
histórico opcional de viagens deve propagar a recusa mesmo que a biblioteca de
upstream a registre e retorne normalmente; republicações internas nunca podem
reabrir a mesma etapa de chegada nem formar um ciclo de chamadas.
O Node-RED sincroniza o deadline publicado pelo Home Assistant inclusive após
restart e liga automaticamente o bypass restrito do motor durante a queda da
API. A recuperação desliga somente uma ativação pertencente à automação; uma
escolha manual já ligada permanece ligada.
Na biblioteca 4.27.2, o refresh token genérico não conhece os atributos e o
formato de bearer do cliente BR. A camada local adapta esse contrato e impede
que um `5091` no refresh dispare login completo na mesma tentativa.
Agendamento, manual, recovery, chegada e movimento convergem no estado
persistente do Node-RED. O ciclo saudável usa 30 minutos quando ambos os
residentes estão em casa e 15 minutos quando algum deles está fora ou chegando.
Uma falha confirmada também usa recuperação a cada 15 minutos, mesmo com ambos
em casa; isso é exceção de recovery, não política normal de presença. Com ambos
em casa, wakes automáticos ficam suspensos entre 00:00 e 05:59. O comando manual
pode antecipar cooldown e pausa noturna, mas nunca atravessa uma chamada em voo.

O retorno de `public_bindings.call` prova somente que o Home Assistant aceitou
a chamada. Um wake só é confirmado quando o timestamp semântico do veículo
avança depois da solicitação e dentro da janela causal de 20 minutos. O instante
da última consulta ao cache não é essa evidência. Dados passivos posteriores
continuam válidos para estacionamento e telemetria, porém não podem transformar
um wake antigo ou falho em sucesso nem deixar o card verde. O dashboard deve
mostrar separadamente há quanto tempo o último wake foi solicitado e quanto
falta para o próximo ciclo ou retry. O alerta de ausência de dados ancora-se no
início contínuo dessa espera: uma segunda transição de morador ou uma nova
tentativa não pode substituir tempo decorrido por contagem de tentativas nem
antecipar a mensagem de 20 minutos.

No backend brasileiro, o wake chama `/ccs2/carstatus` e a telemetria vem depois
de `/latest`. HTTP 200 sozinho não prova aceite: o envelope precisa conter
`retCode=S` e `resCode=0000`. A publicação pode demorar mais que a espera inicial
de 25 segundos; nesse caso, seis rechecks limitados ao cache cobrem os 150
segundos seguintes, renovam autenticação antes de cada leitura e não emitem
outro wake. Ao descarregar a entrada da integração, tarefas pendentes de recheck
e histórico precisam ser canceladas para a instância antiga não continuar
consultando em paralelo.

Falhas do refresh notificam `mobile_primary` e o painel de notificações do Home
Assistant com classe, endpoint e etapa. A deduplicação usa classe mais endpoint:
repetições idênticas são silenciadas, mas uma mudança real gera novo aviso. O
sucesso semântico limpa os detalhes antigos e remove a notificação persistente.
`integration_unavailable` significa especificamente que o serviço
`kia_uvo.update` não existe porque a entrada da integração não carregou; dados
stale, readiness incompleto e wake aceito sem telemetria nova não provam essa
classe de falha.

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
