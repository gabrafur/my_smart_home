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
residentes estão em casa e 15 minutos quando algum deles está fora ou near_home.
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
a nova versão em staging. O ciclo autorizado do Node-RED pode encaminhar uma
candidata mesclada e auditada ao promotor; a instalação exige checkout limpo,
backup, preservação dos deltas locais, validação de runtime e rollback.
Veja o [runbook de atualização](../../../docs/VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md).

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

<!-- memory-record {"id":"permissoes-npm-e-retomada-de-imagens","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-28","evidence":[{"file":"Makefile","sha256":"7b1a173f59f6d079b9ec79dee1084b8f7d4583c322bba303a9f7b07fd98815b8"},{"file":"scripts/docker-auto-update.mjs","sha256":"947270abd2d39297147cf76c6853dec5e64bf0880a938ad2bdaf5c5d4858337b"},{"file":"scripts/docker-auto-update.test.mjs","sha256":"08743530c6afbd0797b78c1834f6ff6c0fdbc2226f4621cedb1e51f18cdbd1cd"},{"file":"scripts/update-repository-dependency.mjs","sha256":"a4439e034f627c34bcd5c85d536321b4999ff79919e7c3af8ec143bf3353cab2"},{"file":"scripts/repository-dependency-update.test.mjs","sha256":"20ab0a090abeac05373f4f2fca47cfcaa00265517afdb0668d6e9f2d9939e008"},{"file":"docs/CONTAINERS.md","sha256":"900fe80417f6e7acbca7ba9d906dc2a7265406ba3c9520e5d7b3142de57ddc59"},{"file":"scripts/docker-update-recovery.mjs","sha256":"13f033adbb46f0e7bedbea8947031fba819fd7ef9292763006e3069c7ad5610c"},{"file":"scripts/docker-update-recovery.test.mjs","sha256":"deae763f743f075a1aace8788bec8088684574b2371e1def32dc8708c7541e38"},{"file":"scripts/container-readiness.mjs","sha256":"c178cd4ff73f20b6d9e189996a62b3bf69d0c52afd00ce7123b5982ce5eb630a"},{"file":"scripts/portainer-readiness.test.mjs","sha256":"5c20ad6f666c1c1ae57603c99fefa60bb763fb56aa9c43cc37432c03bf1b14de"}]} -->
## Permissões npm e retomada de imagens

Instalações de pacotes públicos precisam manter leitura entre os usuários distintos do host e do Node-RED. Os alvos de validação e o instalador de dependências fixam umask 022 durante npm ci; o instalador restaura a máscara privada do chamador mesmo se falhar. Uma validação de imagens que falha antes de recriar o serviço deve restaurar somente a candidata Compose que escreveu, preservando edições concorrentes. Na retomada, compare o ID da imagem realmente usada pelo container com o ID desejado, mesmo quando o digest do Compose já coincide com o canal: arquivo atualizado não comprova deploy.

Após recriação, todos os serviços alterados precisam confirmar prontidão antes do backup Git. Falha ou interrupção mantém registro privado de recuperação e bloqueia novas reconciliações até revisão humana; não fazer downgrade automático sobre dados possivelmente migrados nem limpar imagens em uma tentativa falha. Serviços sem sonda ou healthcheck são bloqueados antes da recriação. O registro de recuperação não substitui snapshot consistente do estado privado.

O registro de recuperação usa a pasta privada do worker e mantém o bloqueio para registros legados ou temporários interrompidos. Após prontidão, sincroniza um recibo privado antes de remover o registro ativo; não amplia permissões da pasta compartilhada.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-otp-somente-manual","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-28","evidence":[{"file":"homeassistant/custom_components/icloud/manual_auth.py","sha256":"a8c7100346d79a46d68b06819829999b1dca034c3113e882e57e8483ef875d2f"},{"file":"homeassistant/custom_components/icloud/config_flow.py","sha256":"b2e91c19a3f5ebbb1a0d792b74dba8eaa3c1fa8264b311cd9ca539819e9753dc"},{"file":"homeassistant/tests/test_icloud_manual_auth.py","sha256":"6b4446ae59212a6114280d59723caed836c93e3a962535a63d6a9b766ce40e78"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"791e7a206e261503b738fe4d58722fce13833f4d492419efa2b39529431bbdb4"},{"file":"homeassistant/tests/test_icloud_silent_recovery.py","sha256":"32206189b41ecf5972cc0cf980c4f3fc8ac61503422a061adc3812ff212e8095"},{"file":"homeassistant/custom_components/icloud/auth_gate.py","sha256":"ecc2ba27b95e896e592292478a57e439a5fac573d469cc24ebcb7dc464dab337"},{"file":"homeassistant/custom_components/icloud/__init__.py","sha256":"39a11ac03222b0f85452124b9be7b5ecff9d0b319eef34fd71d763f9001ba6af"}]} -->
## iCloud com OTP somente por ação manual

A adaptação local preserva domínio, config entry e sessão nativos. Uma expiração confirmada permite uma tentativa de SRP nativo com a senha configurada e pause_2fa=True. Um Store separado grava primary_attempted antes do efeito; reinício isolado não o libera. Expiração confirmada de uma sessão antes válida ou setup autenticado completo encerra o incidente recuperado; aceitar somente o token ou falhar durante o carregamento não libera o marcador. O fallback request_2fa_code e SMS automáticos são bloqueados mesmo quando chamados pela biblioteca. Desafio após a tentativa aguarda a interface do HA; solicitar código continua exigindo ação explícita. Abrir reparo ou informar OTP inválido não envia outro código. Não apagar .storage nem confiança salva. O reparo só é encerrado após setup completo, plataformas carregadas e ausência de desafio, limitado à mesma entrada. Revalidar o contrato na imagem Core/pyicloud candidata.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-retry-de-transporte-no-setup","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-28","evidence":[{"file":"homeassistant/custom_components/icloud/__init__.py","sha256":"39a11ac03222b0f85452124b9be7b5ecff9d0b319eef34fd71d763f9001ba6af"},{"file":"homeassistant/custom_components/icloud/setup_retry.py","sha256":"5611e06df27d1477983f49e579fd163955eb0a4adde4fb0c7e750058f9e58270"},{"file":"homeassistant/tests/test_icloud_manual_auth.py","sha256":"6b4446ae59212a6114280d59723caed836c93e3a962535a63d6a9b766ce40e78"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"791e7a206e261503b738fe4d58722fce13833f4d492419efa2b39529431bbdb4"},{"file":"homeassistant/custom_components/icloud/auth_gate.py","sha256":"ecc2ba27b95e896e592292478a57e439a5fac573d469cc24ebcb7dc464dab337"},{"file":"homeassistant/custom_components/icloud/native_bridge.py","sha256":"1400c8ac8a62208a6525a2cb380c91de6295115870d85080c8988d336bfa320d"},{"file":"homeassistant/tests/test_icloud_cached_transport.py","sha256":"eb7538d8139a9b9c9178c35e6c67e823303b7588b95237595e494b6736b86197"}]} -->
## Retry de transporte no setup do iCloud

Causas tipadas de DNS, conexão e timeout, inclusive encapsuladas pelo pyicloud, viram ConfigEntryNotReady no setup e usam o backoff nativo. A validação do token intercepta transporte antes do catch da biblioteca e preserva PROBE/VALID; contenção adia trabalho, sem confundir checkpoint temporário com expiração. Keep-alive aguarda o próximo ciclo. Esse caminho de transporte não autoriza login primário ou OTP. Expiração confirmada usa a tentativa com senha salva documentada; desconhecido, entrega incerta e desafio após tentativa não recebem repetição automática. Testar concorrência, persistência antes do efeito, reinício e ausência de OTP.

<!-- /memory-record -->

<!-- memory-record {"id":"alexa-kids-polling-compartilhado","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-19","evidence":[{"file":"homeassistant/tests/test_alexa_media_amazon_kids.py","sha256":"30732702da14c2780ffd4c6538723d3cf1da22177d7d08667b8bb5ac6d536bfa"},{"file":"homeassistant/custom_components/alexa_media/amazon_kids.py","sha256":"b656a93af6773b5676828e85a4ea0bcf734730a38443f338d3f3e35f2e79321c"},{"file":"scripts/alexa-media-safe-update.mjs","sha256":"c671130d520ca9c609fdc9df757e9b65bdf37ca25705ba280930681b80576506"},{"file":"scripts/alexa-media-safe-update.test.mjs","sha256":"f18f0a9b8f0ae5f57726110bc4cffc5a9f884c45a5fbe0aab9a10984c76e8032"}]} -->
## Amazon Kids e o coordenador Alexa

Na integração vendorizada, AmazonKidsState centraliza polling por conta a cada cinco minutos e notifica sensor, switch e select. O sensor não faz polling individual e não expõe alexa_entity_id; a seleção do coordenador continua por capacidade e estado enabled. A licença upstream é preservada separadamente como LICENSE.upstream e scripts/alexa-media-upstream.json fixa tag, objeto de tag e commit. As regressões exercitam seleção, inscrição/desinscrição e início idempotente do polling sem rede residencial. O worker acionado por atualizacoes_diarias valida a memória pública contra o staging e os próximos metadados antes de instalar; evidência divergente retorna blocked/public_memory_invalid sem recalcular hashes. A versão corrente pertence ao manifesto de proveniência, não ao texto desta nota. Sucesso de instalação solicita backup Git, mas não comprova publicação.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-compatibilidade-antes-da-imagem","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-28","evidence":[{"file":"homeassistant/custom_components/icloud/device_owner.py","sha256":"a9afdca542f9b11de172138897c9db8b20b3bbe0c334b3ca3e445165c62e8993"},{"file":"homeassistant/custom_components/icloud/upstream.json","sha256":"cb25df45f5c89ae42316be692fa4e038c2624822111e47b51177c3c823faedc4"},{"file":"scripts/custom-integration-compatibility.mjs","sha256":"bec135cb143a9eed436a6b49d4317ad6e20055ab466a90c2be5b85ecae33dc25"},{"file":"scripts/icloud-image-preflight.py","sha256":"90f6b4888e9459209206e13796070d166a70391d76ef3320c6dabe0a50fea0c1"},{"file":"scripts/custom-integration-compatibility.test.mjs","sha256":"11111559d5112014c225307ae727410928b66f00390ea5d57e65b96590cbb654"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"791e7a206e261503b738fe4d58722fce13833f4d492419efa2b39529431bbdb4"}]} -->
## Compatibilidade iCloud antes de promover imagem

O adaptador iCloud exige allowlist de versões Core e hash do construtor nativo. Antes de promover imagem, o atualizador testa compatibilidade e pyicloud isolados, sem configuração residencial; versão desconhecida bloqueia a promoção e dry-run retorna not_checked. O verificador fixa limites próprios quando cgroup de memória está ausente. Após restart, a prova exige nonce e revisão atuais e HA em execução. entry_waiting_user informa setup incompleto: não prova necessidade de OTP, recuperação Apple ou sincronização. O guard admite a tentativa normal com senha configurada quando permitida; OTP permanece manual. Preservar upstream, licença, confiança e validated_compatibility.

<!-- /memory-record -->

<!-- memory-record {"id":"kia-restored-baseline-after-uncertain-promotion","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-10-28","evidence":[{"file":"scripts/kia-uvo-baseline-reconciliation.mjs","sha256":"221551712a0cf193f5a2c220034136527dfd1ae8a85df5505a468293ca35a17e"},{"file":"docs/VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md","sha256":"310824510260805a9a731711d7b2dd6ff851b70ef2bcf55cc34f26fd06b7e491"}]} -->
## Base restaurada após promoção Kia incerta

Uma promoção failed sem efeito conhecido não comprova rollback. Uma candidata diferente pode seguir somente com atestado Root temporário do estado atual, arquivo histórico exato do recibo e nova verificação de arquivos, HACS e loader antes de aplicar. O atestado não altera o resultado histórico, não libera applying/publicação/cleanup pendentes e não repete a candidata terminal. Adiamentos anteriores à nova aplicação preservam o recibo antigo. A instalação continua no promotor normal com backup e rollback.

<!-- /memory-record -->
