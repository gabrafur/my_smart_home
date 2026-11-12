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
O leitor compartilhado prefere o cadastro Marketplace nativo e só recorre ao
HACS quando o arquivo nativo está ausente. O instalador legado permanece
bloqueado para cadastro nativo até revisão do rollback compartilhado; corrigir
a leitura não comprova auditoria completa nem autoriza repetir recibos falhos.
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

- Medir novamente antes de atribuir crescimento a Docker: tamanhos lógicos,
  camadas compartilhadas e variação do filesystem não são a mesma medida.
- Pedidos legados de Storage Health e o botão manual continuam somente
  observação; não selecionar categorias padrão do script legado para limpá-los.
- A agenda Node-RED possui rota explícita separada para cache de construção:
  registros privados, imutáveis, não usados há 30 dias, corroborados por duas
  fontes locais; até 32 registros/2 GB e um despacho por 24 horas. Usar somente IDs
  exatos. Imagens de rollback, volumes, backups e bancos ficam fora do escopo.
- Preservar prévia/recibo; resultado incerto exige reconciliação e nunca novo
  envio. A poda pode preservar parte das entradas por dependências: seleção
  lógica não é promessa de bytes físicos recuperados. Não repetir imediatamente.
- Contenção do lock anterior à entrada no executor de cache retorna 75 e adia
  o mesmo pedido. Não confundir essa recusa sem despacho com resultado incerto;
  este último conserva o marcador bloqueado para reconciliação, sem replay.
- Fonte operacional: `docs/RASPBERRY_PI_SYSTEM_HEALTH.md`. Testes e instalação
  precisam ser comprovados separadamente do primeiro ciclo da agenda.

## Bluetooth, Matter e energia

Mudanças de Bluetooth, Matter, D-Bus ou controle de energia devem seguir
`docs/BLUETOOTH_MATTER.md` e `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`.
Confirme qualquer ampliação de privilégio, acesso ao host ou ação física.

<!-- memory-record {"id":"permissoes-npm-e-retomada-de-imagens","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-11-12","evidence":[{"file":"Makefile","sha256":"7b1a173f59f6d079b9ec79dee1084b8f7d4583c322bba303a9f7b07fd98815b8"},{"file":"scripts/docker-auto-update.mjs","sha256":"991f3b2b4ddc80164dae9e5916b217d2477bf49916db90e7410eb5193a8d692f"},{"file":"scripts/docker-auto-update.test.mjs","sha256":"95650d58b27ada2b7274f9b3c2f2f1f31b84517bde03b81a7bb634e75a77eda4"},{"file":"scripts/update-repository-dependency.mjs","sha256":"c6362b185cfbece506857ea37182d872a9f088771b2fe6ee0902da58d6da6ce6"},{"file":"scripts/repository-dependency-update.test.mjs","sha256":"273b99f51b757cb2bdb6b31b6beb7f9f83dce6219813f8e9d4133cb2348f7e62"},{"file":"docs/CONTAINERS.md","sha256":"900fe80417f6e7acbca7ba9d906dc2a7265406ba3c9520e5d7b3142de57ddc59"},{"file":"scripts/docker-update-recovery.mjs","sha256":"13f033adbb46f0e7bedbea8947031fba819fd7ef9292763006e3069c7ad5610c"},{"file":"scripts/docker-update-recovery.test.mjs","sha256":"deae763f743f075a1aace8788bec8088684574b2371e1def32dc8708c7541e38"},{"file":"scripts/container-readiness.mjs","sha256":"c178cd4ff73f20b6d9e189996a62b3bf69d0c52afd00ce7123b5982ce5eb630a"},{"file":"scripts/portainer-readiness.test.mjs","sha256":"5c20ad6f666c1c1ae57603c99fefa60bb763fb56aa9c43cc37432c03bf1b14de"}]} -->
## Permissões npm e retomada de imagens

Instalações de pacotes públicos precisam manter leitura entre os usuários distintos do host e do Node-RED. Os alvos de validação e o instalador de dependências fixam umask 022 durante npm ci; o instalador restaura a máscara privada do chamador mesmo se falhar. Uma validação de imagens que falha antes de recriar o serviço deve restaurar somente a candidata Compose que escreveu, preservando edições concorrentes. Na retomada, compare o ID da imagem realmente usada pelo container com o ID desejado, mesmo quando o digest do Compose já coincide com o canal: arquivo atualizado não comprova deploy.

Após recriação, todos os serviços alterados precisam confirmar prontidão antes do backup Git. Falha ou interrupção mantém registro privado de recuperação e bloqueia novas reconciliações até revisão humana; não fazer downgrade automático sobre dados possivelmente migrados nem limpar imagens em uma tentativa falha. Serviços sem sonda ou healthcheck são bloqueados antes da recriação. O registro de recuperação não substitui snapshot consistente do estado privado.

O registro de recuperação usa a pasta privada do worker e mantém o bloqueio para registros legados ou temporários interrompidos. Após prontidão, sincroniza um recibo privado antes de remover o registro ativo; não amplia permissões da pasta compartilhada.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-otp-somente-manual","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-11-12","evidence":[{"file":"homeassistant/custom_components/icloud/manual_auth.py","sha256":"a8c7100346d79a46d68b06819829999b1dca034c3113e882e57e8483ef875d2f"},{"file":"homeassistant/custom_components/icloud/config_flow.py","sha256":"b2e91c19a3f5ebbb1a0d792b74dba8eaa3c1fa8264b311cd9ca539819e9753dc"},{"file":"homeassistant/tests/test_icloud_manual_auth.py","sha256":"526d68733cd693edef0c9f508b3c6b83fc03e42725bee2fb8df507c8833fb7f6"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"be7b7f32f7cc08edb1260da46d0b5419b6087b5f5920bb0b27c4a7fb3fe37b9c"},{"file":"homeassistant/tests/test_icloud_silent_recovery.py","sha256":"00c0e76a8b2e11e350bad4c61880730b73fe5861d77fefdb8db54d55f63b3306"},{"file":"homeassistant/custom_components/icloud/auth_gate.py","sha256":"d339e227bc437c4d8214aea10e14885aed5ab4070c92b0c51bca9a8baa06794c"},{"file":"homeassistant/custom_components/icloud/__init__.py","sha256":"a6bd4bfa538f034b4d9ced253680a9484e62489bfc84e7bc3e683674592df3fd"}]} -->
## iCloud com OTP somente por ação manual

A adaptação local preserva domínio, config entry e sessão nativos. Uma expiração confirmada permite uma tentativa de SRP nativo com a senha configurada e pause_2fa=True. Um Store separado grava primary_attempted antes do efeito; reinício isolado não o libera. Expiração confirmada de uma sessão antes válida ou setup autenticado completo encerra o incidente recuperado; aceitar somente o token ou falhar durante o carregamento não libera o marcador. O fallback request_2fa_code e SMS automáticos são bloqueados mesmo quando chamados pela biblioteca. Desafio após a tentativa aguarda a interface do HA; solicitar código continua exigindo ação explícita. Abrir reparo ou informar OTP inválido não envia outro código. Não apagar .storage nem confiança salva. O reparo só é encerrado após setup completo, plataformas carregadas e ausência de desafio, limitado à mesma entrada. Revalidar o contrato na imagem Core/pyicloud candidata.

No polling, uma rejeição confirmada do serviço de dispositivos é interceptada antes do formulário nativo de senha. A tentativa persistida usa a credencial já configurada e preserva o cliente quando recupera; nova rejeição não repete o login. Desafio OTP, termos e transporte não autorizam essa tentativa. A regressão executa o keep_alive nativo isolado, sem rede.

O refresh de localização pode autorizar uma renovação do token salvo, com intent separado persistido antes do efeito. Resposta incerta ou OTP conhecido suspendem a renovação; o marcador só é liberado após setup autenticado completo. Preparar a tela de um desafio ainda não entregue exige envio explícito do formulário e não solicita código automaticamente.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-retry-de-transporte-no-setup","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-11-12","evidence":[{"file":"homeassistant/custom_components/icloud/__init__.py","sha256":"a6bd4bfa538f034b4d9ced253680a9484e62489bfc84e7bc3e683674592df3fd"},{"file":"homeassistant/custom_components/icloud/setup_retry.py","sha256":"b7cf4c5b39f2e0eeeb483c557486bea3cb46bed8d445abe76575dda125381e8e"},{"file":"homeassistant/tests/test_icloud_manual_auth.py","sha256":"526d68733cd693edef0c9f508b3c6b83fc03e42725bee2fb8df507c8833fb7f6"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"be7b7f32f7cc08edb1260da46d0b5419b6087b5f5920bb0b27c4a7fb3fe37b9c"},{"file":"homeassistant/custom_components/icloud/auth_gate.py","sha256":"d339e227bc437c4d8214aea10e14885aed5ab4070c92b0c51bca9a8baa06794c"},{"file":"homeassistant/custom_components/icloud/native_bridge.py","sha256":"118c68e75c618213beb513fe5660d060bc8f50305d829a47196f8ffada2ba254"},{"file":"homeassistant/tests/test_icloud_cached_transport.py","sha256":"8afe9be6fcfd7c094eaa3a03d00a8152ce72d47afea32fe4d7f345efe3b71868"}]} -->
## Retry de transporte no setup do iCloud

Causas tipadas de DNS, conexão e timeout, inclusive encapsuladas pelo pyicloud, viram ConfigEntryNotReady no setup e usam o backoff nativo. A validação do token intercepta transporte antes do catch da biblioteca e preserva PROBE/VALID; contenção adia trabalho, sem confundir checkpoint temporário com expiração. Keep-alive aguarda o próximo ciclo. Esse caminho de transporte não autoriza login primário ou OTP. Expiração confirmada usa a tentativa com senha salva documentada; desconhecido, entrega incerta e desafio após tentativa não recebem repetição automática. Testar concorrência, persistência antes do efeito, reinício e ausência de OTP.

<!-- /memory-record -->

<!-- memory-record {"id":"alexa-kids-polling-compartilhado","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-11-11","evidence":[{"file":"homeassistant/custom_components/alexa_media/amazon_kids.py","sha256":"1757db5a86bf287a2c107e1c1425b5c09121c05574f5f9f019339f2e3fccce20"},{"file":"homeassistant/custom_components/alexa_media/binary_sensor.py","sha256":"515276b4003152333b4deeb3f987c2160fc0f70d6b1256aebb0479b1b36c3f61"},{"file":"homeassistant/custom_components/alexa_media/__init__.py","sha256":"a97f96c3b190f7f887b2f691ca7cc878ce9c6852c0e16445f2eb5d8fd78c0093"},{"file":"scripts/alexa-media-safe-update.mjs","sha256":"dea88ac51e46f8097dd676f2ad134e62e98d53aa3a77d3625f8a1b8fe6cb5ceb"},{"file":"homeassistant/tests/test_alexa_media_amazon_kids.py","sha256":"0c42106961f59664451f17b37cf12a2da6518736ef7fd925cc4238b99fe1909d"},{"file":"docs/DEPENDENCY_PROVENANCE.md","sha256":"db74f9dc4a472b4c83c5f3cb7d639d1b2c934b5e389b0af8c7f7546b42e8d926"},{"file":"scripts/integration-repository.mjs","sha256":"f21321d81a5d487aacf1f82ae54d467f06a19dbf80be26c0087671ab97370b31"},{"file":"scripts/integration_repository.py","sha256":"5d7317885f555341672ac62ab5c11c48d9870abaf67ccd2e042cfda507173f94"},{"file":"scripts/integration-repository.test.mjs","sha256":"a145d1145ecf3723fde6ac1660dc519acabd786153bd5c249cb682d7407fe9d3"},{"file":"scripts/integration_repository_test.py","sha256":"3759f6c9bfd57b1eecd673a54d439243273d18e3a687c32c35b248ccd8b20eab"}]} -->
## Amazon Kids e o coordenador Alexa

AmazonKidsState mantém estado compartilhado por conta e agenda polling a cada cinco minutos para sensor, switch e select. AmazonKidsSensor lê esse estado, desativa polling individual, não define alexa_entity_id e registra callback com remoção automática. A inclusão dos sensores binários no coordenador geral exige alexa_entity_id disponível e entidade habilitada. O contrato do atualizador exige preservar a licença upstream como LICENSE.upstream, verificar sua integridade e registrar versão, commit e objeto de tag no manifesto de proveniência. Essas exigências não comprovam que o checkout ou runtime estejam reconciliados. Antes da instalação, o atualizador verifica a memória pública contra o staging e os próximos metadados; divergências bloqueiam com public_memory_invalid, sem atualizar automaticamente os hashes da memória. A versão declarada pertence ao manifesto, não a esta nota. async_start agenda a consulta em segundo plano e retorna sem aguardar a rede; plataformas posteriores inicializam apenas dispositivos com estado desconhecido e revalidam a seleção sob o lock. async_stop cancela o timer e as tarefas pendentes dessa instância. Os testes atravessam async_refresh real com APIs simuladas e comprovam timer único, ausência de nova consulta de estados conhecidos, inicialização de novos alvos, concorrência, inicialização sem aguardar a rede e cancelamento no unload; um mock da função inteira não verifica esses contratos.

O adaptador de registros prefere o Marketplace nativo; só permite fallback ao HACS quando o arquivo nativo não existe. Schema inválido, identidade ambígua e instalação não confirmada bloqueiam a operação. O backup guarda somente o registro da integração selecionada. A recuperação exige Home Assistant parado e usa um ambiente descartável da mesma imagem, sem rede ou capabilities; restaura apenas esse registro e conserva as alterações posteriores de outras integrações. Versão própria inesperada, troca de schema e escrita concorrente impedem a restauração. Os testes isolados comprovam essas recusas, conservação e gravação atômica; não constituem prova de um rollback residencial.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-compatibilidade-antes-da-imagem","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-11-12","evidence":[{"file":"homeassistant/custom_components/icloud/device_owner.py","sha256":"728c6f37b922fd13681ef13799d1405c3a538f13b96b1431775faec915764851"},{"file":"homeassistant/custom_components/icloud/upstream.json","sha256":"60e00ad79637b2bce29ccf9d0f47a40cb889c3f1272a9c1e7759d676d41026b5"},{"file":"scripts/custom-integration-compatibility.mjs","sha256":"50c2fc2a70d15f4caf9b41e3f45d1ab2124fe518a9b7eeea370db5aa2075b38e"},{"file":"scripts/icloud-image-preflight.py","sha256":"505708c5f671e27cc4ad2b1a3d516754dbba38b975d5fd092fa62b979caf8597"},{"file":"scripts/custom-integration-compatibility.test.mjs","sha256":"9ce569cc70da59087e632fb00271f8c75e17815cdca4606939a4d843c9172cdf"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"be7b7f32f7cc08edb1260da46d0b5419b6087b5f5920bb0b27c4a7fb3fe37b9c"}]} -->
## Compatibilidade iCloud antes de promover imagem

O adaptador iCloud exige allowlist de versões Core e hash do construtor nativo. Antes de promover imagem, o atualizador testa compatibilidade e pyicloud isolados, sem configuração residencial; versão desconhecida bloqueia a promoção e dry-run retorna not_checked. O verificador fixa limites próprios quando cgroup de memória está ausente. Após restart, a prova exige nonce e revisão atuais e HA em execução. entry_waiting_user informa setup incompleto: não prova necessidade de OTP, recuperação Apple ou sincronização. O guard admite a tentativa normal com senha configurada quando permitida; OTP permanece manual. Preservar upstream, licença, confiança e validated_compatibility.

<!-- /memory-record -->

<!-- memory-record {"id":"kia-restored-baseline-after-uncertain-promotion","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-11-11","evidence":[{"file":"scripts/kia-uvo-baseline-reconciliation.mjs","sha256":"a5052cf3053754cece559f777a6c46bfdab5d399c15a2698ebbaa208148f2b46"},{"file":"docs/VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md","sha256":"dbca2545130a5507eaf2775720bcd6ae7c69f5ed83dfa917fec3945a1846888c"},{"file":"scripts/kia-uvo-baseline-reconciliation.test.mjs","sha256":"f02e5c215979d6ca0cf29ee0ff51d049807f94ed38d05bba3066ea3322f920a8"}]} -->
## Base restaurada após promoção Kia incerta

Uma promoção failed sem efeito conhecido não comprova rollback. Uma candidata diferente pode seguir somente com atestado Root temporário do estado atual, arquivo histórico exato do recibo e nova verificação de arquivos, cadastro da integração e loader antes de aplicar. O atestado não altera o resultado histórico, não libera applying/publicação/cleanup pendentes e não repete a candidata terminal. Adiamentos anteriores à nova aplicação preservam o recibo antigo. A instalação continua no promotor normal com backup e rollback; cadastro Marketplace nativo exige um adaptador de instalação revisado e não reutiliza o rollback HACS legado. O inventário inclui todos os arquivos upstream, inclusive ícones com @2x no nome, sem omitir branding; mantém limites de tamanho, identidade estável e rejeição de links e nomes inseguros.

<!-- /memory-record -->

<!-- memory-record {"id":"heartbeat-deadline-e-registro-duravel","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-11-08","evidence":[{"file":"scripts/raspberry-mcp/runtime-source/host-heartbeat/README.md","sha256":"ba16546dab4be6a63d69f2f90cd104a44f97db8bfad23e47399588c72e0305c7"},{"file":"scripts/raspberry-mcp/runtime-source/host-heartbeat/webhook.py","sha256":"73322b6321338ab1e1736396df406a84ba7fd41fc37a9fb169ad327bb544c6a2"},{"file":"scripts/raspberry-mcp/runtime-source/host-heartbeat/history.py","sha256":"721b3621f01152f4fa396c2025076a34630294375e1606f976d0166f7413b7da"}]} -->
## Heartbeat: deadline e registro durável

O deadline do transporte não inclui toda a inicialização e persistência do processo. A unidade precisa de margem finita para registrar o resultado; o drop-in documentado limita a execução a 30 segundos e mantém transporte em 10 segundos, quota de CPU e ausência de retry. Timeout do gerenciador pode deixar intent incerto sem categoria: não atribuir automaticamente falha de rede nem repetir esse envio. Novos ciclos agendados são observações distintas. Resultado HTTP aceito comprova somente aceite pelo provedor; serviço oneshot inativo entre ciclos não é queda. Mudança de margem não comprova causa raiz ou eliminação de recorrência.

<!-- /memory-record -->

<!-- memory-record {"id":"zigbee-backup-nao-comprova-queda","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-11-12","evidence":[{"file":"nodered/tools/install-zigbee-recovery-flow.mjs","sha256":"9e375c4f2a9455826036809b5ce9c31a469d98aee2272279f4704c4493173842"},{"file":"nodered/tools/test-zigbee-coordinator-recovery.mjs","sha256":"770f054aad21db0346e5e82e1a0b0968831c1ef9e0ad72275ed77ae06106b8af"}]} -->
## Falha de cópia Zigbee não comprova queda da rede

Uma recusa de snapshot por snapshot_not_healthy ou maintenance_active, sem queda, banco vazio ou erro de rádio, permanece diagnóstico local e preserva a última cópia boa. Falha inesperada da cópia tem alerta próprio; o alerta de queda exige fatos da rede. Os gates de recuperação e a persistência dos recibos não são relaxados. A deduplicação do alerta usa chave persistente separada da contagem de falha, pois branches com mensagens clonadas podem sobrescrever o estado compartilhado. O reset sintético limpa somente as duas chaves de teste; replay nunca grava pedido residencial.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-recuperacao-autorizada-no-refresh","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-11-12","evidence":[{"file":"nodered/tools/install-people-location-refresh.mjs","sha256":"b308e823d6dd2939cbc3c704131c0c03916452c9bc7751a8a50e22eebe8261b8"},{"file":"homeassistant/custom_components/icloud/auth_gate.py","sha256":"d339e227bc437c4d8214aea10e14885aed5ab4070c92b0c51bca9a8baa06794c"},{"file":"homeassistant/custom_components/icloud/native_bridge.py","sha256":"118c68e75c618213beb513fe5660d060bc8f50305d829a47196f8ffada2ba254"},{"file":"homeassistant/custom_components/icloud/manual_flow.py","sha256":"a670e583c54d1780fd3657d20ad872d42ac3645d46e8cc614b54d1c9f472234f"},{"file":"homeassistant/custom_components/public_bindings/icloud.py","sha256":"34016edb46e25dc5d095bad6151c05b7d2f4bf407e02b170b385d65af5282dc3"},{"file":"homeassistant/tests/test_icloud_saved_session_recovery.py","sha256":"ab073a22fa3bd85400b581a0cc2f295f3e83ea63784b2ac1231ada18aca73ae4"},{"file":"homeassistant/tests/test_public_bindings_icloud_recovery.py","sha256":"e871d4f89311643f2ae3963f1ff3f8ce1bbb10d63cd8fac0cefdbad6918d546b"}]} -->
## Recuperação iCloud autorizada pelo refresh de localização

O canvas envia recover_session=true somente nos efeitos iCloud das duas funções lógicas de morador, após os gates normais e fora do dry-run. O binding fixa a conta e remove a intenção antes da chamada downstream. A recuperação renova o token salvo e recarrega a entrada uma vez; falta de token usa somente o orçamento separado existente para senha salva. Um Store adicional com attempted é persistido antes da renovação e permanece consumido em resposta incerta ou reinício. Setup autenticado completo pode liberá-lo. Um desafio conhecido retorna ICLOUD_OTP_REQUIRED sem envio de código; a interface manual só prepara o desafio por envio explícito do formulário. Lock por entrada evita dois moradores renovarem a mesma sessão em paralelo. Testes isolados comprovam token aceito sem senha/OTP, espera persistente por código, rejeição posterior e ausência de replay.

<!-- /memory-record -->
