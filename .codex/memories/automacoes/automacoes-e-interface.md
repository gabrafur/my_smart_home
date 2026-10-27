# Automações e interface

## Chegada e iluminação de segurança

Zonas, rastreadores congelados, cooldowns e deduplicação formam um único
contrato de segurança. Antes de mudar esse comportamento, consulte
`docs/ILUMINACAO_SEGURANCA_NODERED.md` e
`docs/SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md`.

- Saúde da fonte e frescor da posição são sinais diferentes. O binding propaga
  `source_reported_at` através dos aliases e mantém `location_observed_at`
  ligado à evidência de localização, incluindo o timestamp autêntico do iCloud;
  republicação e startup não podem fabricar observação GPS nem heartbeat novo
  do Mobile App. Consulte `public_bindings/location.py` para a validação.
- O refresh dos telefones distingue renovação preventiva por morador de sondas
  ligadas à saída/retorno, mas compartilha dedupe e limites entre os gatilhos.
  Não restaure polling geral ilimitado de 30/60 segundos com base em memória
  antiga. As fontes atuais são
  `nodered/tools/functions/people-refresh-decide.js` e
  `nodered/tools/functions/people-wake-ring-refresh-build.js`.
- Um push aceito não comprova atualização. Se o Mobile App não responder mas o
  iCloud continuar reportando, o painel deve mostrar separadamente a fonte sem
  heartbeat e a posição apenas inalterada; automações de chegada continuam
  exigindo `location_observed_at` fresco.
- Os raios de decisão ficam somente no grupo visual de política do tab
  `localizacao_pessoas`: `home` 100 m e `near_home` 350 m. As zonas HA
  `location_update_ring` (1.500 m), `location_update_notification_ring` (700 m)
  e `location_update_inner_ring` (300 m) são
  geofences de transporte para leituras do iOS; não autorizam efeitos. O antigo controle inativo de
  refresh rápido em 2.000 m foi removido. Consulte os caminhos canônicos de
  recovery e sondas antes de mudar a frequência dos pedidos explícitos.
- Quando nenhuma fonte tem posição observada nos últimos 15 min, o tracker
  canônico publica `unavailable` e mantém o último estado bruto apenas como
  diagnóstico, sem republicar coordenadas vencidas como localização atual.
- Uma transição confirmada de qualquer residente de `home` para `near_home` ou
  `not_home` exige `force_refresh` imediato do `vehicle_primary` (wake seguido
  da obtenção de estado novo), com deduplicação e serialização de chamadas.
- Efeitos físicos de chegada exigem um ciclo externo semântico comprovado por
  `not_home` ou outra zona externa. Distância acima do limite casa/fora nunca
  arma a chegada sozinha, nem a própria borda inicial de saída; é necessária
  uma observação externa posterior ou a borda direcional externa `-> near_home`.
  `home -> near_home` é saída e não produz efeitos imediatos. Para residentes,
  ela abre um ciclo local de 90 min restrito à iluminação; depois de um `off`,
  somente um novo `on` com localização atual em `near_home` ou `home` caracteriza
  a volta. Para `vehicle_primary`, o rebote continua sem efeitos.
- O refletor do portão usa somente a aproximação de um morador com localização
  atual de `not_home`/zona externa para `near_home` (ou recovery de ciclo externo
  já armado), inclusive salto direto confirmado para `home`, durante a noite.
  Exige motor `on` atual; `off` vencido e bypass de posse automática não
  autorizam acendimento, inclusive em salto direto para `home`.
  A posição do `vehicle_primary` nunca autoriza o acendimento. Se a integração
  do motor estiver comprovadamente indisponível, o bypass de posse manual pode
  substituir apenas esse gate; ele nunca supera um `off` confiável.
- Se o motor ligar depois da entrada, ou se o bypass se tornar válido durante
  falha comprovada da integração, a autorização reavalia imediatamente o
  morador que ainda esteja armado e atual em `near_home`.
  O evento carrega a própria evidência canônica de `near_home`, evitando corrida
  com a atualização paralela do contexto. Cada `home` de morador agenda sua
  própria leitura extraordinária do veículo 90 s mais tarde, mesmo sem
  lifecycle ativo do refletor; nem `near_home` nem a posição `home` do próprio
  carro iniciam esse prazo.
- O botão técnico que resolve `vehicle_primary.force_refresh` não deve publicar
  estado visível; somente o `input_button` manual entra no coordenador. Isso
  evita que um alvo interno pareça uma segunda rotina de atualização.

## Histórico de notificações

- Os três hubs `hub_notificacoes_moveis`, `hub_notificacoes_alexa` e
  `hub_notificacoes_persistentes_ha` registram cada chamada aceita em JSONL
  privado, em `nodered/notification-history/<canal>/<AAAA-MM-DDTHH>.jsonl`,
  usando UTC. Registram origem lógica, canal, destinatário/target, título,
  conteúdo, operação, perfil e correlação para backtests e incidentes.
- O histórico fica fora do Git e do Recorder. A retenção é de **7 × 24 horas**;
  o próprio canvas dispara purge no startup e a cada 5 minutos, filtrando o
  arquivo da hora de fronteira pelo timestamp. Após parada, retoma no startup.
- `accepted` comprova somente retorno bem-sucedido do serviço; não comprova
  entrega, fala ou leitura. Cada celular tem registro individual, mesmo em
  falha parcial. Background commands e `dismiss` têm operação/perfil próprios.
- Dry-run não grava dados de produção. A escrita não bloqueia o aceite ao
  chamador: falhas seguem o observador e há uma pequena janela de perda em
  encerramento abrupto. Não há reconstrução retroativa de envios antigos.
- Fonte atual: `docs/NODERED_NOTIFICATION_HUBS.md`; retenção e serialização
  verificadas por `nodered/tools/test-notification-history.mjs`. Nunca copie
  conteúdo residencial dos registros para memória pública ou commits.

## Alertas dos fluxos operacionais

- Atualizações diárias, revisão documental semanal e guardião de memória
  notificam no HA persistente e em `resident_primary` somente falhas e ações
  necessárias. Conclusões e intervenções normais permanecem silenciosas.
- Avisos de pendência manual e pressão sem ação segura têm dedupe persistente;
  recuperação remove o aviso no HA sem novo push. `unknown` não encerra um
  incidente confirmado do worker semanal. Testes usam contexto separado e o
  terminal dry-run global.
- Contrato e cenários: `docs/NODERED_NOTIFICATION_HUBS.md` e
  `nodered/tools/test-operational-alerts.mjs`.

## Portão da garagem

O relé Zigbee TS0001 deve receber pulso em software (`ON` seguido de `OFF`).
Não usar `on_time` ou `onWithTimedOff`. Consulte
`docs/PORTAO_GARAGEM_RELE_LOCAL.md` e
`docs/PORTAO_GARAGEM_BOTAO_PULSO.md`.

## Fronteira nativa do Home Assistant

- A lógica residencial comum pertence ao Node-RED, mas automações ligadas ao
  lifecycle/API interna do Home Assistant ou que fornecem um watchdog
  independente podem permanecer nativas.
- O inventário permitido é fechado; verifique `homeassistant/automations.yaml`
  e os blocos `automation:` de `homeassistant/packages/` antes de adicionar ou
  migrar uma entrada.
- O watchdog do relé do portão só pode emitir `OFF`. Mantê-lo fora do runtime
  que produz pulsos é uma defesa em profundidade, não duplicação de lógica.
- Todas as abas funcionais do Node-RED convergem erros e indisponibilidade no
  tab `observabilidade_global`, com dedupe, push para `resident_primary` e
  notificação persistente na aba **Notificações** do Home Assistant. O
  observador agrega quedas de HA/MQTT e suprime por 90 segundos a cascata de
  erros de seus nós após a reconexão, sem silenciar falhas de funções alheias;
  queda compartilhada do HA exige pelo menos dois nós corroborando o estado.
  Falhas nos classificadores centrais do próprio monitor usam um caminho
  interno deduplicado e não recursivo até os mesmos dois canais.
  O Home Assistant observa o tópico MQTT “nodered/status” diretamente para
  detectar a queda do próprio runtime após 90 segundos; esse watchdog permanece
  nativo porque não pode depender do componente que monitora.
- Mudanças Node-RED exigem cobertura pelo gerador/validador global e replay
  dry-run. O smoke test real marcado `TESTE` no canal central é usado somente
  quando solicitado ou quando a própria rota de entrega é alterada. O aceite
  do HA aparece como `NODERED_GLOBAL_NOTIFICATION_ACCEPTED`; apresentação no
  celular continua sendo uma confirmação manual de última milha.
- O tab `monitoramento_vpn` recebe do host somente o estado sanitizado de
  `vpn_primary`. Ele suprime falhas enquanto `monitoramento_internet` não está
  online, confirma queda e recuperação antes de notificar e nunca persiste
  endereços, peers ou topologia da VPN. A fonte operacional é
  `docs/VPN_HEALTH_NOTIFICATIONS.md`.

## Alarme e painéis

- A integração Moni Mobile cobre armar, desarmar e ler o estado agregado das
  partições. Ela não expõe entidades individuais de zona. Consulte
  `docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md`.
- Os painéis Lovelace YAML são declarados em `lovelace.dashboards` dentro de
  `homeassistant/configuration.yaml`; as chaves públicas de dashboard usam
  hífen. Para assistentes e chat, consulte `docs/CHAT_CLAUDE_CODE_HA.md`.

## Chat de agentes no Home Assistant

- Os agentes `Claude Code Chat` e `Codex` têm controle total do host e usam uma
  allowlist explícita de usuários humanos ativos. Cargo administrativo não
  concede acesso implicitamente; identificadores permanecem somente no config
  entry privado da integração.
- Config entries antigos com um único usuário são migrados preservando esse
  acesso. Alterações posteriores na allowlist recarregam apenas a integração.
- Autorização é verificada antes de histórico, limpeza ou envio, e a conversa
  persistente continua separada por agente e usuário autenticado. O bearer
  token local do `ai-bridge` forma uma segunda fronteira independente.
- Card dedicado e entidades do Assist injetam o mesmo contexto confiável: nome
  do usuário autenticado, escopo limitado ao Raspberry Pi e seus recursos
  acessíveis (incluindo Home Assistant, Node-RED, Docker e arquivos), e
  capacidade de alterá-los somente quando o pedido autorizar.
- Fontes atuais: `homeassistant/custom_components/claude_code_chat/` e
  `docs/CHAT_CLAUDE_CODE_HA.md`.

## Padrões Lovelace reutilizáveis

Em views nativas `sections`, um card dentro de um `grid` de duas colunas ocupa
uma célula desse grid. Textos explicativos que precisam preencher a coluna
inteira devem ser cards irmãos do grid na seção, não o último filho ímpar. Isso
preserva a responsividade sem CSS customizado e deve ter teste de regressão do
nível de indentação/layout.

Tabelas Markdown geradas por Jinja precisam manter cabeçalho, separador e linhas
sem linhas vazias entre eles: use controle de whitespace nos blocos do loop,
pois uma quebra vazia encerra a tabela e transforma as linhas seguintes em
texto. Em colunas estreitas, combine campos relacionados na mesma célula com
`<br>` antes de adicionar rolagem horizontal. Valide o template renderizado com
dados sintéticos no ambiente do Home Assistant, além de testar o YAML fonte.

## Preservação dos canvases e regeneração

Canvases podem conter edição manual aprovada. Geradores devem reconciliar os
nós existentes e preservar sua geometria e os pares nomeados já aprovados;
reorganização puramente visual nunca altera IDs, wires nem comportamento.
Routing explícito por links é uma mudança de grafo distinta e exige regressão
de equivalência, incluindo destinos compartilhados. Consulte
`nodered/tools/test-canvas-wire-routing.mjs` e
`nodered/tools/test-flow-generator-stability.mjs`.

O motor ELK existe, mas aceita somente propostas com melhoria mensurável e sem
regressão; caso contrário preserva o baseline. Não aplique seu resultado bruto
sobre canvases manuais. Contrato: `docs/node-red/ELK_LAYOUT_ENGINE.md`.

Snapshots coordenados e eventos de chegada podem chegar em ordens diferentes.
Uma atualização parcial de residente não pode descartar o evento de outro;
confirme o contrato em `nodered/tools/test-arrival-context-flow.mjs` e
`docs/ILUMINACAO_SEGURANCA_NODERED.md` antes de alterar o merge.

<!-- memory-record {"id":"renovacao-gps-e-cadencia-do-veiculo","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-16","evidence":[{"file":"nodered/tools/functions/people-refresh-decide.js","sha256":"77920e3c77009495441a8cf3968a86dca05d5b82567e0066b174d11f668b0f35"},{"file":"nodered/tools/functions/location-policy-validate.js","sha256":"248b89edc59e7bd16c05095a60c7c3af42c88d2ce3e2b0dcedeb950837aa728b"},{"file":"nodered/tools/functions/vehicle-primary-refresh-policy.js","sha256":"3cd79eb01b2164ae26af0f1d3c4179ebed01fa8d360843a4fbacd02282bb6cfb"},{"file":"nodered/tools/functions/vehicle-refresh-facts.js","sha256":"f62a4df41741d431b4a8b4c81c37526240d0203412d9527389350ff696c6be36"},{"file":"nodered/tools/functions/vehicle-primary-provider-backoff-sync.js","sha256":"1893c67c2cd2e84366bae5f4189a85ec5ad6d76bb10b77008668259a064b9cdb"},{"file":"docs/ILUMINACAO_SEGURANCA_NODERED.md","sha256":"f3f89f33a5f0683c59b10b26de137fbff4eb18ee99c5361709d4fb1ed32cd842"}]} -->
## Renovação preventiva e limites externos

A localização de cada morador solicita renovação aos 5 min em near_home e aos 10 min nas demais situações; a validade permanece em 15 min. Com ciclo externo armado e posição atual fora de home até people_approach_radius_m (1.500 m), solicita aos people_approach_refresh_seconds (60 s). Proximidade não burla dedupe, tentativas ou backoff. Tick, sondas do anel e vigília de chegada compartilham o coordenador, com até três tentativas a 60 s, diagnóstico silencioso sem push nem aviso persistente por falta de GPS novo, e depois backoff de 30/60/120/240 min. Apenas posição realmente nova e atual confirma sucesso e zera tentativas; aceite de serviço e republicação não bastam. O iOS/iCloud não garante resposta; três pedidos sem callback não comprovam falha de conexão/permissão e podem ocorrer antes de vencer o GPS. Não mascarar dados vencidos. Avisos legados dessa condição são removidos silenciosamente sem declarar recuperação; erros efetivos de serviço/conexão continuam no observador. Parâmetros visíveis ficam em localizacao_pessoas, grupos 0b/0c. Para o veículo, proximidade atual ou retorno armado limitado pela janela canônica mantém 1 min com motor OFF e 5 min com motor ON; ambos os moradores atuais em home encerram essa faixa. A posição do veículo pode acelerar polling, nunca autorizar o refletor. O prazo explícito do provedor prevalece inclusive sobre comandos extraordinários/manuais e mudanças de cadência; liberação antecipada remove somente esse prazo, sem declarar a telemetria recuperada. A leitura extraordinária 90 s após home continua independente do lifecycle do refletor. Antes de afirmar que uma correção está ativa, comparar a definição em memória pela API do Node-RED e observar um ciclo nativo: arquivo ou commit não comprova deploy.

<!-- /memory-record -->

<!-- memory-record {"id":"retomada-internet-vpn-e-estabilidade-zigbee","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-18","evidence":[{"file":"docs/NODERED_STARTUP_RECOVERY.md","sha256":"9050c385356f1761caee1ef2b8687fb615ea86d9fd4b1bbdc6ffed87bed18203"},{"file":"nodered/tools/install-startup-readiness.mjs","sha256":"3880b2e8a232e7d1e4e39a63f697c0898d443f8ed33319c685fecfb66d2b137e"},{"file":"nodered/tools/functions/zigbee-route-state-mutate.js","sha256":"0c764e30d50230c9c13b7b2e84368228fc56a474e9a0a0c059a6add5e7bb96b9"},{"file":"nodered/tools/functions/zigbee-route-error-normalize.js","sha256":"6c7725df3313bf2652da5d816c1e71bce10413c5a7035e9c234d4f16961cee79"},{"file":"nodered/tools/test-zigbee-startup-recovery.mjs","sha256":"e2383f1efd5436728e087481665c51935b97d87e258ce9a760988c3397d7ddfd"}]} -->
## Retomada dependente de internet e VPN e estabilidade Zigbee

O tab retomada_servicos consome as classificações canônicas de internet e VPN e libera tarefas externas após 180 s de startup e 120 s contínuos com ambas online. Usa uptime monotônico, rejeita retained como prova, coalesce intenções por chamador e revalida decisões depois da liberação. Monitores de conexão e proteções locais iniciam independentemente. No monitoramento_zigbee, configure ok apenas inicia verificação: recuperação exige dados novos após 300 s sem falha; erros tardios e duplicatas preservam o incidente e o limite de três tentativas. Consulte docs/NODERED_STARTUP_RECOVERY.md para escopo, limites e testes. A entrada bridge/logging reconhece NWK_NO_ROUTE e MAC_NO_ACK com dispositivo identificável e preserva a causa durante startup/retry. O replay manual atravessa o normalizador real e inclui o tópico networkmap nas respostas sintéticas. A recuperação por software não garante corrigir alcance ou interferência persistentes. O ciclo da rede deve alimentar status, alertas e as três publicações MQTT; mensagens de uma única saída Function exigem lista aninhada. O replay completo rejeita saídas desconectadas ou publicação parcial.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-lazy-manager-no-executor","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"homeassistant/custom_components/public_bindings/icloud.py","sha256":"dced8ba6a333e15291ed09d364cd47b9a80b11524f035fd895d0dce640f38f9e"},{"file":"homeassistant/custom_components/public_bindings/__init__.py","sha256":"dc6d94639f501be2921902d095e457dcb42366e0b04df946abf761ce20855427"},{"file":"homeassistant/tests/test_public_bindings_icloud.py","sha256":"634d10ddce66fc200516e43bb4ccda9b3f5ef3fcfd8800bfa822c53b31d19c9f"},{"file":"nodered/tools/functions/people-refresh-decide.js","sha256":"77920e3c77009495441a8cf3968a86dca05d5b82567e0066b174d11f668b0f35"},{"file":"nodered/tools/functions/global-flow-observer-normalize.js","sha256":"e3f51bbd3d2ee9cdb768422498616c4dc46f8bcb84260ba7c4cac5fbbe27d571"},{"file":"nodered/tools/test-global-flow-observer.mjs","sha256":"63c0f0fceed3e6017064fecc04b620dfc23031dc79dd3cc9a99792a401591be4"},{"file":"docs/PUBLIC_PRIVATE_BOUNDARY.md","sha256":"68c60430af59ec88cbb7a2430d7b4d193aee6e423b210992e27ae3810fe622ca"}]} -->
## Refresh iCloud fora do event loop

O acesso à propriedade api.devices pode executar HTTP antes de retornar o gerenciador. O public_bindings deve resolver essa propriedade e executar refresh(True) juntos no executor do Home Assistant; mover somente o método refresh não elimina o bloqueio. O adaptador mantém falhas explícitas e não altera as políticas de seleção ou frequência do Node-RED. A regressão executa o adaptador real com uma propriedade lazy que rejeita acesso no event loop. Interrupção HTTP comprovada por RemoteDisconnected na cadeia de exceções recebe o código ICLOUD_TRANSPORT_INTERRUPTED, preservando a causa. O adaptador não repete chamadas: o coordenador Node-RED publica refresh_transport_retry_pending segundo seu limite visual. Apenas os nós iCloud conhecidos podem adiar o alerta central com esse código e contrato; esgotamento, ausência do contrato, autenticação e falhas desconhecidas continuam alertáveis. O diagnóstico permanece registrado e aceite do serviço não renova GPS.

<!-- /memory-record -->

<!-- memory-record {"id":"historico-detalhado-falhas-node-red","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md","sha256":"11ca7fb320932446fecb3e14ddc84124d2caffc8393600b1ec49484df4c066bb"},{"file":"nodered/tools/functions/global-flow-observer-diagnostic-build.js","sha256":"7f98b5c56e2fc0c6806d7b169d11b78e656057f23c7ccabbb13ea07a2449e579"},{"file":"nodered/tools/test-failure-diagnostics.mjs","sha256":"809739055a8173c363c09eb6814c7e816b5498e397f439cee7500a5ee78a835d"}]} -->
## Histórico detalhado de falhas Node-RED

O observador global grava diagnóstico privado por ocorrência antes dos gates de notificação, inclusive erros repetidos ou suprimidos. Alertas de domínio e status confirmados entram pelo dispatch. Mensagem, stack, causas encadeadas e campos operacionais explícitos ficam em JSONL fora do Git, com remoção de padrões de credenciais, truncamento declarado e retenção pela política error_retention_days. O resumo de push e o estado de dedupe não substituem esse histórico. Testes usam terminal em memória; falha do escritor segue somente ao log do runtime para evitar recursão. Detalhes nunca recebidos ou já descartados por versões antigas não são reconstruídos.

<!-- /memory-record -->

<!-- memory-record {"id":"recuperacao-status-nativo-home-assistant","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"nodered/tools/functions/global-flow-observer-status-recovery.js","sha256":"6e792b8f5a9399ddfc126939cb1471bb478d01ff835efc6ab31c74c7bd368663"},{"file":"nodered/tools/test-global-flow-observer.mjs","sha256":"63c0f0fceed3e6017064fecc04b620dfc23031dc79dd3cc9a99792a401591be4"},{"file":"docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md","sha256":"11ca7fb320932446fecb3e14ddc84124d2caffc8393600b1ec49484df4c066bb"},{"file":"nodered/tools/functions/global-flow-observer-normalize.js","sha256":"e3f51bbd3d2ee9cdb768422498616c4dc46f8bcb84260ba7c4cac5fbbe27d571"},{"file":"nodered/tools/functions/global-flow-observer-policy-store.js","sha256":"b8ab97d882e1bba6dece5e7ae4b2a0e7fc24fb54ec8fc74b4933645c9e0fe1b6"},{"file":"nodered/tools/functions/global-flow-observer-status-failure.js","sha256":"57396ee52d1adfa24b7dcb27cc74a1199a5b17096860781ec44fa8d167e82320"},{"file":"nodered/tools/functions/vehicle-primary-refresh-error.js","sha256":"94011918e5344e1f5e6d59d2aa8dd51710d375fb920373c027b68e68db034852"},{"file":"nodered/tools/test-vehicle-primary-refresh-scheduler.mjs","sha256":"7d1a03bf126722b8ee21ada8071200395c9fcd959c1800ff30f737f72ff8ce4a"}]} -->
## Recuperação da conexão por status nativo

A fonte de inventário HA do próprio observador encaminha erros e status ao classificador central; NoConnectionError nessa fonte não deve gerar alerta de falha interna. A recuperação encerra o incidente compartilhado e erros de API sem evidência de desconexão continuam alertáveis. O replay cobre queda breve, prolongada e entrega dry-run.

A integração Home Assistant emite as chaves não traduzidas home-assistant.status.connected e home-assistant.status.running. O observador deve reconhecê-las como recuperação explícita e encerrar todas as fontes da conexão compartilhada; ignorá-las mantém incidentes vencidos e lembretes mesmo com a conexão restabelecida. Valores de entidade, sucesso de serviço e connecting não comprovam recuperação. O replay cobre desconexão curta, recuperação e ausência de lembrete após seis horas. Estados de entidade offline/unavailable, inclusive com horário e múltiplas fontes, não comprovam queda compartilhada. A classificação exige o contrato explícito de conexão; carregar a política remove somente evidências legadas desses estados, preservando incidentes reais e MQTT. NoConnectionError, Connection lost e o envelope websocket de resultado com código 3 e Connection lost, emitidos por nó HA, entram na mesma confirmação mesmo antes do status. Timeouts de chamadores gerados dos hubs com contrato de notificação compartilham a carência da conexão; links comuns continuam alertáveis. O tratador do veículo não transforma desconexão do HA em falha do provedor, bypass automático ou segunda emissão de node.error; libera somente a chamada em voo e preserva deadlines e evidência, com estado de teste separado.

<!-- /memory-record -->

<!-- memory-record {"id":"diagnostico-do-guardiao-de-memoria","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-10-07","evidence":[{"file":"docs/HOST_MEMORY_GUARDIAN.md","sha256":"917dc307ad3315f9d93f02fa36a3577edd2107b6b33f95028c78eaf5807031ad"},{"file":"nodered/tools/functions/host-memory-guardian-request-response-normalize.js","sha256":"23fb79994e054f442ff057137bd43fc4fefe6e29651b2ff83a0c4a68f981adab"},{"file":"nodered/tools/functions/host-memory-guardian-result-freshness.js","sha256":"c40bf53b58ccfcaf9d87243b243b5b352e61b1091a2d8cd6b8309fce0fc9613a"},{"file":"nodered/tools/install-operational-alerts.mjs","sha256":"7d50a1d84dbd92738507eeea58c170c285091e3c189627e00feeadd78f0ea725"},{"file":"nodered/tools/functions/operational-alert-lifecycle.js","sha256":"66410b50f73c7fabc60a2a78128eb2e6de576b263c5e7d2588a1b2ed9c670120"},{"file":"nodered/tools/test-host-memory-guardian-flow.mjs","sha256":"65ef6b8d250bf7f04706c0bd7f132072d77960fd1b12965950204f70f6d459e5"},{"file":"nodered/tools/test-operational-alerts.mjs","sha256":"82cac8ec491c03eaef42142f5d58fcee77a67549cd38d0af5b52e01853c26bad"}]} -->
## Correlação e lifecycle do guardião de memória

O guardião só avalia em produção resultados cujo request_id pertença aos pedidos aceitos ou coalescidos desde a partida atual do Node-RED. Mantém em memória as oito correlações mais recentes para não perder o resultado final do ciclo anterior; um resultado anterior ao startup ou sem correlação fica em espera e não abre falso stale_result. Falha do worker, limpeza parcial e resultado vencido usam incidente explícito com dedupe e recuperação, preservando o ID persistente legado; resultado healthy, reclaimed ou terminated encerra a falha. A primeira recuperação após a migração também remove uma vez um alerta legado que estivesse aberto, sem repetir dismiss nos ciclos seguintes. O diagnóstico local usa warning e não representa condição de domínio como node_error. Para investigar, confira status, reason, request_id e checked_at no resultado sanitizado; nunca copie registros operacionais para a memória pública.

<!-- /memory-record -->

<!-- memory-record {"id":"recuperacao-direta-da-iluminacao","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-16","evidence":[{"file":"nodered/tools/install-location-lifecycle-flow.mjs","sha256":"c619509bf935e50fe174c51706f510433f4499d1bb930314439bf48c15968dbe"},{"file":"nodered/tools/functions/people-lifecycle-recovery-build.js","sha256":"a417932e8402862031b3e763d68d99189e6e7886fd66e5935b12f7c721077a87"},{"file":"nodered/tools/functions/security-light-mark-active.js","sha256":"fbd39974c264e2afba35d0f7e60c4560cbe79590614571be409f3ec1a094a02b"},{"file":"nodered/tools/functions/security-light-arrival-facts.js","sha256":"3732a42c6a768b07bb15004789a4859e0a4eabfd0a7c78715578b22fad11cdca"},{"file":"nodered/tools/test-security-light-flow.mjs","sha256":"6331dd26798bc9d6d12942f37e8fcecd21b2a913f13ef4d3a902a68522d0517d"}]} -->
## Recovery direto e ordem dos eventos da iluminação

O produtor deve emitir recovery de iluminação para unknown/unavailable -> home somente com ciclo externo previamente armado, posição atual e sem catch-up tardio; consumir o armado em home e preservar a rota exclusiva de iluminação. O evento leva snapshot canônico com gate_distance_m, revalidado tanto no gate de chegada quanto na fronteira final. Evento parcial legado só completa a distância com cache da mesma observação; dado novo sem distância não herda medida antiga: links independentes podem entregar o evento antes do cache. Cache mais recente e GPS vencido continuam bloqueando. O gate JSONata usa $lookup para selecionar o residente; testar a expressão publicada e o caminho até o terminal dry-run, não apenas eventos montados diretamente no consumidor. A falha persistida de comunicação do motor vale também no gate final, inclusive com bypass de posse manual. Essas regressões comprovam falhas do código, não a causa de um incidente residencial específico.

<!-- /memory-record -->

<!-- memory-record {"id":"ciclo-local-perdido-antes-do-contexto-no-startup","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-16","evidence":[{"file":"nodered/tools/functions/security-light-local-excursion.js","sha256":"485ed84ed5c6e541484b82aa4b73e344d10454f1721aef69dc1fe9d6354549e8"},{"file":"nodered/tools/functions/security-light-mark-active.js","sha256":"fbd39974c264e2afba35d0f7e60c4560cbe79590614571be409f3ec1a094a02b"},{"file":"nodered/tools/functions/people-lifecycle-facts.js","sha256":"6efd07ca976c0ce3bc1e043bf142b0e487eecc25e5e35bcd7ce82164821ae9f2"},{"file":"nodered/tools/functions/people-lifecycle-state-load.js","sha256":"56fbad9850c223014f2ba2a90e8446403449bad48f7c94a56a88d9401e4c2665"},{"file":"nodered/tools/functions/security-light-pending-validate.js","sha256":"478c2377775ba8af0dfcc0aad21ceb33833fe9b70dc4f8f57426473502611026"},{"file":"nodered/tools/functions/security-light-replay-build.js","sha256":"6a8cc5b23318e6467d5c0d1a58ccdb053b0900064564222a8b05a5be47f422c5"},{"file":"nodered/tools/test-security-light-return-recovery.mjs","sha256":"e51c4432d9b74216a621cb05f1d159e96f9308cd6a245607f5017c6369314afd"},{"file":"nodered/tools/functions/security-light-local-gps-evidence.js","sha256":"ee2c623ae48d7045ca2aab81a4533967e40baa1f6b77311fbbcbd5460e7d4915"},{"file":"nodered/tools/test-security-light-flow.mjs","sha256":"6331dd26798bc9d6d12942f37e8fcecd21b2a913f13ef4d3a902a68522d0517d"}]} -->
## Recovery do ciclo local e chegada longa pareada

Startup parcial não encerra passeios locais persistidos: a prova ON/OFF é validada e retida até reencontrar o ciclo canônico com posição atual, respeitando a janela de local_excursion_minutes. OFF durante falha de comunicação não comprova parada. Preparar um candidato não o consome; somente a fronteira final autorizada marca consumed_at. Zona externa ou permanência em home além de primary_home_grace_minutes encerra o passeio e invalida replays. Para saídas externas longas, snapshot home pode transferir o armado para home_arrival_candidates sem emitir chegada; somente evento direcional da mesma observação a recupera dentro de arrival_recovery_minutes, inclusive após restart. Replay pendente reutiliza os gates de motor e não impede retorno local atual de outro residente quando sua própria posição está indisponível. A regressão sintética cobre permutações de startup, cancelamento, isolamento e retornos após horas até o terminal dry-run; não comprova a ordem dos eventos de um incidente residencial específico.

Uma ida/volta GPS significativa também pode provar retorno local sem amostrar a parada: três observações distintas, pico >= movement_threshold_m, progresso radial de ida e volta >= local_return_progress_m e soma das precisões, duração >= external_cycle_confirm_seconds, ON anterior ao pico e ON atual fresco. A prova é por residente/ciclo, persistida e consumida apenas no gate final. Não promove external_cycle_confirmed nem autoriza alarme. O replay manual GPS preserva produção e termina em dry-run; ver docs/ILUMINACAO_SEGURANCA_NODERED.md.

<!-- /memory-record -->

<!-- memory-record {"id":"relatos-periodicos-frescor-iluminacao","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-16","evidence":[{"file":"docs/ILUMINACAO_SEGURANCA_NODERED.md","sha256":"f3f89f33a5f0683c59b10b26de137fbff4eb18ee99c5361709d4fb1ed32cd842"},{"file":"nodered/tools/test-security-light-flow.mjs","sha256":"6331dd26798bc9d6d12942f37e8fcecd21b2a913f13ef4d3a902a68522d0517d"}]} -->
## Frescor físico com estado inalterado

O frescor físico da iluminação de segurança deve aceitar relatos MQTT vivos de estado inalterado pelo binding exterior_light.topics.security_state. Eventos de mudança do Home Assistant sozinhos não representam relatos periódicos. Rejeitar retained e mensagens sem estado válido; manter a reconciliação monotônica e a expiração canônica quando cessarem os relatos. O adaptador não cria chegada nem aciona dispositivos.

<!-- /memory-record -->

<!-- memory-record {"id":"adiamento-silencioso-da-promocao-kia","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-26","evidence":[{"file":"docs/VEHICLE_PRIMARY_KIA_UVO_UPDATE_RUNBOOK.md","sha256":"e19b350de4c680c117f09f1850675655571f775556d62fca7570d45e46615847"},{"file":"nodered/tools/install-daily-host-update-flow.mjs","sha256":"08fc06501d5234cf14354627284faa6f7c2ba9276fec3877258fc43a5ebd5a7c"},{"file":"nodered/tools/test-daily-host-update-flow.mjs","sha256":"fa7af5685365b8d41ca9ac1d1a5201b038988750fd26dbb7cf6a6c555f048680"},{"file":"scripts/kia-uvo-safe-update.mjs","sha256":"9f41e6e20eb066431e0be34147b63b62ff6f29975118088edcf0c86b2092d7f1"},{"file":"scripts/kia-uvo-regression-gate.test.mjs","sha256":"3a12736575b99d8b46cdb65ce112b47233bfb03242fa13c22e9a61227dc5b924"},{"file":"scripts/promote-kia-uvo-candidate.mjs","sha256":"472e12be6a37341f34b2eb63abbc6c48be82dade235c9dde0df429994d939831"},{"file":"scripts/promote-kia-uvo-candidate.test.mjs","sha256":"a23920937d2d3f3c2b689f59a12f67db1b9e82cf57afc43b1b21997347cc387c"},{"file":"nodered/tools/functions/daily-kia-audit-result.js","sha256":"77b0372c3cc1c9ac7ff2e8222ae5fc6ee132ef964f80d93440febe8749938a1a"},{"file":"scripts/kia-uvo-audit-failure.mjs","sha256":"c928b3add7fba39068589d07e55722b2a89af1b57045987c05e5df3474f455b6"},{"file":"scripts/kia-uvo-audit-lifecycle.test.mjs","sha256":"cb7601cabc8e171b7e2250098128732f1b0f7760dfcb0fe1a06de4a484af76fd"},{"file":"scripts/kia-uvo-audit-result.test.mjs","sha256":"536e962ddcefb6f089ff0b6b15d96de3361c2193e250b474b6dd0d1e22705f9a"},{"file":"scripts/promote-kia-uvo-uncertain-guard.test.mjs","sha256":"e7d7297d13dce824596d3774e4d9f1a9e4ad35ad6b7793ed81636918f573725a"},{"file":"scripts/promote-kia-uvo-stage-evidence.test.mjs","sha256":"72a9dd1b16ffdd4cde1b23f2ebeac28f75392a4241c1f3cb0e98f750f2104855"}]} -->
## Adiamento da promoção e publicação automática

A promoção Kia adiada por pré-requisito é estado esperado: o consumidor no canvas de atualizações mantém status amarelo, sem node.error nem push. O horário do polling não identifica incidente. Falhas reais são deduplicadas por estado e versão candidata em contexto persistente; transições e novas candidatas permitem nova avaliação, com dry-run separado. A publicação automática exige checkout limpo e validação pública: evidências de memória sobre outro serviço não devem depender incidentalmente dos digests do Compose inteiro quando Dockerfile, testes e guia já sustentam a nota. O gerador preserva geometria e links aprovados e possui regressão de idempotência. A preparação da candidata executa as regressões locais de consumo e refresh em cópia isolada antes da instalação, sem efeitos externos; falhas abortam a preparação. Se o runtime já foi validado mas ainda não há commit de promoção, a retomada exige caminhos exatos e bytes iguais à candidata, incluindo staged; arquivos removidos no upstream devem estar ausentes e symlinks são rejeitados. Essa retomada preserva o gate de alterações protegidas e não reinstala a integração.

Falha da auditoria é resultado operacional do worker, separado de exceção do parser. O motivo vem de categoria fechada, sem texto ou stack privados; mantém IDs, ausência de repetição de falha consumida e silêncio de seis horas. Encerrar o aviso exige resultado posterior conclusivo com versão e checked_at válidos, posterior à falha e não futuro. Compatibilidade ou conflito da auditoria não comprova instalação nem saúde do veículo. Testes sintéticos alcançam o gate dry-run do observador.

Recibo applying, ilegível ou desconhecido impede nova aplicação. Uma candidata diferente não sobrescreve runtime_applied, applied_pending_git ou main_published; failed só permite candidata diferente com etapa e efeito positivamente runtime_not_attempted. Essa classificação descreve a tentativa atual, não prova rollback nem saúde. Stage ausente permanece desconhecido. Falha na validação da retomada Git preserva git_publication_failed.

<!-- /memory-record -->

<!-- memory-record {"id":"assimetria-off-vencido-no-lifecycle-da-iluminacao","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-16","evidence":[{"file":"nodered/tools/functions/security-light-arrival-facts.js","sha256":"3732a42c6a768b07bb15004789a4859e0a4eabfd0a7c78715578b22fad11cdca"},{"file":"nodered/tools/functions/security-light-off-decision.js","sha256":"3f3af38d313eada74564f9ea3ccf54eb4cd181e6b50876e8ee75080edf9068f6"},{"file":"nodered/tools/functions/security-light-turn-off-if-active.js","sha256":"ae156c85acaf0c1506b69d95ae9c96bc5dc993add8de44fbf4b382202570da67"},{"file":"docs/ILUMINACAO_SEGURANCA_NODERED.md","sha256":"f3f89f33a5f0683c59b10b26de137fbff4eb18ee99c5361709d4fb1ed32cd842"},{"file":"nodered/tools/functions/security-light-pending-validate.js","sha256":"478c2377775ba8af0dfcc0aad21ceb33833fe9b70dc4f8f57426473502611026"},{"file":"nodered/tools/functions/security-light-arrival-pending.js","sha256":"6de9f008782df947f1aa6226c772c68228f0e9d14baf9b484fbad869693a14cf"},{"file":"nodered/tools/test-security-light-flow.mjs","sha256":"6331dd26798bc9d6d12942f37e8fcecd21b2a913f13ef4d3a902a68522d0517d"},{"file":"nodered/tools/functions/security-light-off-evidence.js","sha256":"bd7e1e37fd45f99195df98e1068368b0255b3cd8c11fa5ff43c0265465296ca2"},{"file":"nodered/tools/test-security-light-off-policy.mjs","sha256":"af57e4090ab10c95cead9b68bac94877280a5a52f2e22509d2cc1001458779ff"}]} -->
## Prova nova do motor e carência no desligamento

OFF antigo não autoriza acendimento nem encerra um ciclo posterior à sua observação. O desligamento exige timestamp do provedor (telemetry_updated_at; engine_updated_at somente na ausência dele), posterior a on_since, dentro da validade canônica e sem falha de comunicação. A primeira prova agenda off_grace_seconds (90 s); a fronteira final revalida ciclo, prazo, prova e estado físico. Duplicatas não prorrogam; ON ou perda da prova cancelam a pendência. Restart reconstrói o prazo; o backstop de 15 min continua independente. Logs distinguem bloqueio, agendamento, solicitação e aceite do serviço; aceite não comprova estado físico. A iluminação usa approach_radius_m (350 m) e gate_distance_m canônico, preservando near_home de 350 m para preparação e home de 100 m. Intenções fora do acesso persistem por morador; uma aproximação concorrente não substitui a outra. Um salto para home só promove a intenção existente após transição confirmada da mesma pessoa, observação atual e posterior à original, preservando o prazo original. Snapshot isolado, GPS vencido e intenção expirada não autorizam a promoção; o acendimento consome as pendências concorrentes. Coordenadas reais e incidentes ficam apenas no runtime privado.
 O gate OFF não depende de vehicle.ready: GPS vencido ou inferência de uso pendente não invalidam prova recente do motor. Validar engine_state_valid, comunicação e timestamp tanto no agendamento quanto na fronteira final; regressões cobrem ready=false sem liberar evidência inválida.

<!-- /memory-record -->

<!-- memory-record {"id":"geofence-interno-e-distancias-ausentes","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-14","evidence":[{"file":"homeassistant/packages/zonas_presenca.yaml","sha256":"ed8f5bea8758320440743d5a22219ca607b881fdc25d26d8cab9eddcf8f17857"},{"file":"nodered/tools/functions/people-location-classify-near-home.js","sha256":"06fa7f3e78a4d8faeb9027651a4d2e7066ab230efabbd9fda128dc49eea30d23"},{"file":"nodered/tools/functions/people-lifecycle-normalize.js","sha256":"f296a43120edfb8d401880223711b71e47e364dc30039a53a6bf4b870fef6b4e"},{"file":"nodered/tools/functions/people-lifecycle-facts.js","sha256":"6efd07ca976c0ce3bc1e043bf142b0e487eecc25e5e35bcd7ce82164821ae9f2"},{"file":"nodered/tools/test-canonical-location-flow.mjs","sha256":"d0b8bd943c7cbc0312157d2244b715685185f08539a2ebf47f484ba2a939ccf4"}]} -->
## Geofence interno e distância desconhecida

O anel técnico interno de 300 m complementa o externo de 1.500 m nos trajetos locais. O nome bruto da zona não autoriza chegada: a seleção de fonte e o ciclo canônico mantêm os gates de posição atual, direção e ciclo externo. Testes atravessam ambos os moradores até a notificação dry-run e rejeitam saída, GPS ausente, impreciso ou vencido. Distância canônica null convertida com Number() vira zero e pode fabricar current_home; o normalizador preserva valores ausentes, vazios e booleanos como desconhecidos. Reclassificação de zona, relatório da fonte ou reload de política que reutilize o mesmo location_observed_at é somente contexto: não pode armar saída, chegada, external_since nem passeio local; movimento exige observação física estritamente mais nova. A proteção precisa também preservar como referência direcional o último estado associado a uma observação física nova: se uma reclassificação sem timestamp novo avançar apenas o cache de estado, a observação física seguinte já na mesma zona perde a borda external -> near_home e o retorno pode terminar como external_cycle_not_confirmed. A regressão deve cobrir ciclo externo confirmado, reclassificação sem avanço para near_home, nova observação em near_home e conclusão em home. Não afirmar que a entrega do geofence pelo iOS foi validada por replay sintético; após reload das zonas, a sincronização do app e a passagem física continuam necessárias.

<!-- /memory-record -->

<!-- memory-record {"id":"acendimento-com-confirmacao-atual-do-motor","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-16","evidence":[{"file":"nodered/tools/functions/vehicle-lifecycle-normalize.js","sha256":"222906a08450bde8359d208cc0b0cd40c14c2830f385485f1722ffe261ddbd33"},{"file":"nodered/tools/functions/security-light-vehicle-gate.js","sha256":"d0709073765df86103f2313d907cbef547afa4b9f36a97efbefd9088c7ded433"},{"file":"nodered/tools/functions/security-light-mark-active.js","sha256":"fbd39974c264e2afba35d0f7e60c4560cbe79590614571be409f3ec1a094a02b"},{"file":"nodered/tools/test-vehicle-primary-refresh-scheduler.mjs","sha256":"7d1a03bf126722b8ee21ada8071200395c9fcd959c1800ff30f737f72ff8ce4a"},{"file":"nodered/tools/test-security-light-flow.mjs","sha256":"6331dd26798bc9d6d12942f37e8fcecd21b2a913f13ef4d3a902a68522d0517d"},{"file":"nodered/tools/functions/people-lifecycle-arrival-build.js","sha256":"c6c92b4b01ab100e94f0d9d35c9616c34df3252587438d4522cdd91f298852c3"},{"file":"nodered/tools/functions/people-lifecycle-recovery-build.js","sha256":"a417932e8402862031b3e763d68d99189e6e7886fd66e5935b12f7c721077a87"}]} -->
## Acendimento com prova atual do motor

O acendimento automático exige ON atual, uso confirmado e comunicação saudável. OFF vencido e bypass de posse automática não comprovam retorno de carro. O bypass manual continua restrito à falha de comunicação. A fronteira final revalida o contexto para bloquear OFF, perda de frescor ou falha surgida depois do primeiro gate. O frescor do motor usa o timestamp do provedor quando presente, permitindo confirmação recente de estado inalterado e rejeitando recibo recente com telemetria antiga ou futura. A antecipação depende de localização real; sem atualização intermediária, o aviso mantém a semântica de HOME confirmado, sem inventar aproximação.

<!-- /memory-record -->

<!-- memory-record {"id":"aviso-de-retorno-com-raio-independente","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-14","evidence":[{"file":"nodered/tools/functions/people-notification-facts.js","sha256":"7e33c713753b3459c09ebda37ff4734bce2ed3fc96dfdc0ac9332cc13f389ab8"},{"file":"nodered/tools/functions/people-notification-build.js","sha256":"0a8207707a5482575f3fd0c3cb8c422cebe0619198c3158dc0974d79ec99139a"},{"file":"nodered/tools/functions/resident-notifications-state-read.js","sha256":"d10ca52c004333d141895b1ab5d5b0850f552edb2548079db0635b6da76ba526"},{"file":"nodered/tools/test-canonical-location-flow.mjs","sha256":"d0b8bd943c7cbc0312157d2244b715685185f08539a2ebf47f484ba2a939ccf4"},{"file":"nodered/tools/test-resident-approach-notifications.mjs","sha256":"d08a45ebde9ae8b43772d18ccdd4f23dbc07ecd67abe646c651ecf105a0b2cd8"}]} -->
## Aviso de retorno antes da iluminação

O aviso usa notification_approach_radius_m (700 m de HOME), separado do near_home e do refletor (350 m do portão). Exige ciclo externo armado, posição anterior fora e observação nova mais próxima dentro do raio, inclusive sem mudança do nome da zona. HOME encerra o ciclo; nova saída cria outra identidade. O contrato notification_only segue apenas ao consumidor de avisos. O fallback canônico de 350 m exige que o mesmo ciclo tenha observado posição fora de notification_approach_radius_m e compartilha notification_cycle_id, com dedupe persistente mesmo após o TTL de eventos legados. Sem saída do raio de aviso, uma passagem interna por near_home não deve consumir a identidade da notificação; HOME confirmado continua como fallback para trajetos curtos. Salto direto para HOME mantém confirmação de permanência; não inventa aviso antecipado. Teste e produção usam memória separada e o teste termina sem dispatch. O anel HA de 700 m incentiva callback; replay não comprova entrega de GPS nem exibição no iOS. A rota de retorno local por motor preserva ON/OFF/ON observado e depende de a parada aparecer na telemetria; a alternativa por ida/volta GPS está descrita em Recovery do ciclo local.

<!-- /memory-record -->

<!-- memory-record {"id":"replays-de-iluminacao-e-evidencia-do-motor-na-volta","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-16","evidence":[{"file":"nodered/tools/functions/resident-notifications-state-read.js","sha256":"d10ca52c004333d141895b1ab5d5b0850f552edb2548079db0635b6da76ba526"},{"file":"nodered/tools/functions/resident-notifications-state-write.js","sha256":"474c38592130a326c38e76c7a4233fdf51283fa60eabc9411fe4bfa070ea1c66"},{"file":"nodered/tools/install-security-light-visual-policy.mjs","sha256":"23f2ed09509e3b6c3d74c55224a8d09d64ce2f86902d64d88e1adad4f7773a02"},{"file":"nodered/tools/functions/vehicle-primary-refresh-policy.js","sha256":"3cd79eb01b2164ae26af0f1d3c4179ebed01fa8d360843a4fbacd02282bb6cfb"},{"file":"nodered/tools/functions/arrival-context-home-refresh-due-read.js","sha256":"49a403d7f1a7ccc4af6f42da56a1b9bfbe720436302e66fe5d3ff5248d35c691"},{"file":"nodered/tools/functions/arrival-context-home-refresh-due-select.js","sha256":"efbcb8bb32bc241e268bba5427e6b3b9f28ad8fbae44a2305cf32345cbbf84f5"},{"file":"nodered/tools/test-resident-approach-notifications.mjs","sha256":"d08a45ebde9ae8b43772d18ccdd4f23dbc07ecd67abe646c651ecf105a0b2cd8"},{"file":"nodered/tools/test-arrival-context-flow.mjs","sha256":"61095ddf45a66abda3c06154f62a9ae1a44564f9788278acfaa29f9d388e9e1e"},{"file":"nodered/tools/test-vehicle-primary-refresh-scheduler.mjs","sha256":"7d1a03bf126722b8ee21ada8071200395c9fcd959c1800ff30f737f72ff8ce4a"},{"file":"nodered/tools/functions/resident-notifications-delivery-ack.js","sha256":"8ffa2bfb6655936f8f8572cf289ca150c40ff58271a8a0051bb2089cabc09345"},{"file":"nodered/tools/functions/resident-notifications-delivery-failure.js","sha256":"fddad64a4ecf9e389332b3ca177a1c11ecaae7fb8ae3559ddb06b8af427dd18e"},{"file":"nodered/tools/install-resident-notifications-flow.mjs","sha256":"d7d016b454c3677a9db000408678fd2ad754f5fbe7fea8e4aebb3209f594d3fb"}]} -->
## Replays, reserva atômica e prova do motor no retorno

Replays de iluminação HOME/approach não representam outra chegada e não podem entrar no consumidor de avisos. Apenas local_return atravessa a rota específica, com identidade estável do passeio. Leitura do recibo e reserva precisam ser atômicas; a fronteira final consome cada token uma vez para impedir confirmações concorrentes ou mensagens clonadas. Callbacks de serviço antigos não substituem a reserva de uma viagem nova. A confirmação HOME tolera oscilação por até 10 min, mas continua exigindo 90 s contínuos e localização atual. HOME legado após HOME aceito é deduplicado, preservando nova viagem canônica. Para obter evidência de motor durante paradas próximas, distância atual do morador dentro de people_approach_radius_m mantém polling de 1 min com OFF e 5 min com ON, mesmo fora de near_home; ambos em HOME encerram essa faixa e bloqueio do provedor prevalece. A confirmação extraordinária de HOME não exige ON anterior: OFF desconhecido ou anterior à chegada exige nova consulta. Somente timestamp próprio do motor/provedor, atual, posterior à chegada e sem falha de comunicação dispensa a consulta; updated_at agregado não é prova. Replay não pode fabricar a telemetria que uma consulta adicional teria retornado.

<!-- /memory-record -->

<!-- memory-record {"id":"supressao-de-alertas-dependentes-da-wan","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md","sha256":"11ca7fb320932446fecb3e14ddc84124d2caffc8393600b1ec49484df4c066bb"},{"file":"nodered/tools/functions/global-flow-observer-normalize.js","sha256":"e3f51bbd3d2ee9cdb768422498616c4dc46f8bcb84260ba7c4cac5fbbe27d571"},{"file":"nodered/tools/functions/notification-hub-failure.js","sha256":"733e1a998d108af8f87f5bd6aa9644c3a600f186d55a1c9bd5f7772388bdf1a6"},{"file":"nodered/tools/test-global-flow-observer.mjs","sha256":"63c0f0fceed3e6017064fecc04b620dfc23031dc79dd3cc9a99792a401591be4"},{"file":"nodered/tools/test-notification-hubs.mjs","sha256":"e985dda4b6264f8ebe3dd8d61a9d365545cb1a447c74f0f0cdc2dd8143a7f620"}]} -->
## Supressão de alertas dependentes da WAN

Uma queda confirmada de internet é o incidente canônico; falhas móveis de entrega durante offline/recovering continuam diagnosticadas e retornam ao chamador, mas não geram um segundo alerta sobre o próprio canal. Estados unknown/checking não comprovam queda e mantêm a falha alertável. Nós Dulo dependentes da WAN só abrem incidente quando a internet está confirmada online; nos demais estados, o observador remove a evidência dependente em vez de duplicar a causa. Replays cobrem online, offline, recovering, checking e unknown sem produzir efeitos reais.

<!-- /memory-record -->

<!-- memory-record {"id":"dismiss-rtx-repetido-sem-incidente","category":"PROJECT_CONVENTION","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"docs/NODERED_NOTIFICATION_HUBS.md","sha256":"038449d9cd67a61001bca0410aed09d64279c7d0668aa5aa0f7012caced5a995"},{"file":"nodered/tools/functions/local-ai-rtx-alert-build.js","sha256":"763d3c84d7b36ec0c1a9f78e98a1d043c84f7f897d7d2f0b00336d32b3939460"},{"file":"nodered/tools/install-local-ai-rtx-recovery-flow.mjs","sha256":"b824ee03bf19821bec765e14add8bb38a7f1973339b4a2295d164c850da26268"},{"file":"nodered/tools/test-local-ai-rtx-recovery-flow.mjs","sha256":"c460aef245ee772bf15ea9d712a22b6bdbd4e54a04c442854ebb7d9003ca8749"}]} -->
## Lifecycle do alerta de indisponibilidade da RTX

O alerta de indisponibilidade da RTX registra em contexto persistente quando o incidente de produção foi realmente aberto. Disponibilidade do endpoint ou desligamento esperado do computador encerra a responsabilidade, mas só envia persistent_notification.dismiss quando esse marcador está aberto; o marcador é limpo antes do efeito e ciclos seguintes permanecem silenciosos. A mensagem de fechamento remove reset e rtx_alert_condition antes do gate, para que a limpeza da deduplicação não reinicialize a própria detecção de recuperação. TESTE usa estado separado e nunca fecha incidente de produção.

<!-- /memory-record -->

<!-- memory-record {"id":"desligamento-diario-silencioso-iluminacao-externa","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-10-26","evidence":[{"file":"docs/ILUMINACAO_EXTERNA_NODERED.md","sha256":"16a3cf617c7d5f4e1692fd2fc36518f72ec9ea3807034963cf8f84d68a2c0af3"},{"file":"nodered/tools/install-external-lighting-visual-policy.mjs","sha256":"cc620563957dfbd2eef26b4ab23ab595c2f3c4d58c4d0d4220491e9d05575ea9"},{"file":"nodered/tools/test-external-lighting-alarm-flow.mjs","sha256":"a4be1fd2d0849e8ca620c078a6109270dacb921645656c2d78996757d3f5288c"},{"file":"nodered/tools/functions/external-lighting-confirmation-message.js","sha256":"d181c95ea29438eace22427a30cd7735679e65e59bec21a45de160b6a4687bf8"},{"file":"nodered/tools/test-external-lighting-matching-state.mjs","sha256":"60df643ff80d91dfca047e6e6e9d6156f3b9735d9cc298b154a4f3d1360c1e01"}]} -->
## Desligamento diário silencioso da iluminação externa

O tab iluminacao_externa envia OFF na transição real de sun.sun para above_horizon, com outputInitially false para que startup ou redeploy durante o dia não simule um novo amanhecer. O comando percorre a disponibilidade Zigbee, distribuição e confirmação canônicas. Sucesso no amanhecer permanece silencioso; falha Zigbee ou luz ainda ligada continua alertável. O replay manual TESTE 5 atravessa o mesmo pipeline até o terminal dry-run, sem MQTT, Alexa ou notificação.

Estados informados que já coincidem com o alvo, mas cuja data é anterior ao comando, não provam falha nem aceite novo. A confirmação permanece unconfirmed e não emite aviso de falha ou recuperação fictícia. Destinos divergentes ou indisponíveis continuam diagnosticáveis sem retry; somente observação posterior válida confirma o comando. Testes preservam a separação entre cenário sintético e pendência de produção.

Aviso de divergência exige estado on/off válido posterior ao comando e oposto
ao alvo. Unknown, unavailable, leitura ausente ou antiga mantêm unconfirmed
sem abrir incidente ou emitir aviso de falha. O estado geral do Zigbee2MQTT
não confirma estado individual. A volta da leitura não converte aviso legado
de indisponibilidade em recuperação. Incidente real por divergência fica
aberto durante intervalo inconclusivo, sem repetir o mesmo aviso; recuperação
exige novas observações de todos os destinos.

<!-- /memory-record -->

<!-- memory-record {"id":"recuperacao-de-monitores-apos-reinicio","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"docs/NODERED_NOTIFICATION_HUBS.md","sha256":"038449d9cd67a61001bca0410aed09d64279c7d0668aa5aa0f7012caced5a995"},{"file":"docs/ZIGBEE_HEALTH_NOTIFICATIONS.md","sha256":"8a200d4ed4cf32bf27dc71927c29321cbefc79d7e4e83a0632cc07d92cd8ca6e"},{"file":"docs/ILUMINACAO_EXTERNA_NODERED.md","sha256":"16a3cf617c7d5f4e1692fd2fc36518f72ec9ea3807034963cf8f84d68a2c0af3"},{"file":"nodered/tools/test-global-flow-observer.mjs","sha256":"63c0f0fceed3e6017064fecc04b620dfc23031dc79dd3cc9a99792a401591be4"},{"file":"nodered/tools/startup-replay-harness.mjs","sha256":"a6bffece8a2ce7c50f9431b47eefe82712eff6e43d8fd71605abde6e0a3701f6"},{"file":"scripts/raspberry-mcp/collector-cadence/60-sampling.conf","sha256":"d372c64c478e57105968ac2480cde56364f1d0a6399f801f65186e62385c6997"},{"file":"scripts/raspberry-mcp/collector-cadence/README.md","sha256":"90eed7f34722235a70f71e4271bea950aa497758d6901f27ad77f732bc6831a1"},{"file":"scripts/raspberry-mcp/basic-snapshot-cadence.acceptance.json","sha256":"92e2c65ea496f14093d1c1aa004e04c1cc7c6dfe8d9666ab6058d5a90dd740d1"}]} -->
## Recuperação de monitores após reinício

Funções de recuperação Zigbee copiam somente estado JSON sem depender de structuredClone global; o sandbox Function não expõe todos os globais do Node.js. Replays de startup devem reproduzir essa fronteira. O acesso remoto exige relatório fresco recebido no runtime e conta cada checked_at uma vez. A recuperação da iluminação usa next_setting em data local futura, nunca last_changed como evidência de pôr do sol. No hub móvel, somente a resposta explícita de serviço public_bindings.call ausente admite retry limitado, porque comprova ausência de execução; falhas ambíguas continuam no tratamento normal. A admissão de erro do observador relê o estado para deduplicar mensagens intercaladas.

Em timers systemd, atribuição vazia de uma diretiva de disparo limpa toda a lista anterior, inclusive o disparo de boot. Overrides de cadência precisam recolocar o disparo inicial depois do reset; uma recorrência relativa sem ativação anterior pode permanecer elapsed com próximo disparo infinito. A parada apenas do timer antes da troca evita dois disparos iniciais por reload e ativação. TimersMonotonic pode repetir a propriedade: preservar todos os valores e confirmar publicações naturais distintas pelo MCP, sem fabricar snapshot ou reiniciar o host. Fonte de backups/logs separada não herda a causa de falha do snapshot básico.

<!-- /memory-record -->

<!-- memory-record {"id":"imagem-canonica-do-auxiliar-de-seguranca","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-09","evidence":[{"file":"scripts/setup-node-red-security.mjs","sha256":"d775dc5f483addbe6483d17d31e48e575b9cd52c7e256d665d115874d8beb665"},{"file":"scripts/storage-maintenance.test.mjs","sha256":"77d156ad841e359d3b6566b13be5af22d469e8893eb15a619949e74b7ad431d2"}]} -->
## Imagem canônica do auxiliar de segurança Node-RED

O auxiliar de segurança resolve a imagem Node-RED diretamente do serviço canônico no Compose, exigindo o repositório esperado e digest SHA-256. Não deve manter uma segunda cópia literal do digest: uma atualização automática do Compose deixaria o auxiliar obsoleto e bloquearia a validação do backup. A regressão cobre o digest atual, mudança para outro digest, ausência, duplicação e referências não fixadas. Não é necessário executar o auxiliar nem alterar credenciais para validar esse contrato.

<!-- /memory-record -->

<!-- memory-record {"id":"input-button-restauracao-sem-intencao","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-10-26","evidence":[{"file":"nodered/tools/install-input-button-restoration-guards.mjs","sha256":"6d6ebe60ef8b512d3935dbb85b528e8eded2b4a828ffc77a721b44312dfa486d"},{"file":"nodered/tools/test-input-button-restoration.mjs","sha256":"328cdc426e1d1b85ada8d771eed7bd62a57a0d089787eaa4563201bde550ccf8"},{"file":"docs/ICLOUD_MANUAL_AUTH.md","sha256":"7eaa185941937ccc376de955e74fdddf9d6c2c6641e7a1259a2108d165e60ed0"}]} -->
## Restauração de input_button não representa intenção

Gatilhos server-state-changed de input_button precisam ignorar old_state nulo e emissão inicial. A criação/restauração da entidade após reinício pode republicar um timestamp antigo; isso não é clique e não autoriza efeitos. Manter ignorePrevStateUnknown=false permite o primeiro clique real de um helper já existente em unknown. O gerador install-input-button-restoration-guards preserva a geometria; o teste test-input-button-restoration usa o controlador nativo e cobre restauração, primeiro clique, duplicata, entidade alheia e desconexão sem serviços reais.

<!-- /memory-record -->

<!-- memory-record {"id":"observacao-host-fatos-e-incidentes","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-27","evidence":[{"file":"nodered/tools/HOST_OBSERVER.md","sha256":"7f2d7c4dbe38ae8b5d1d3fdbfd825fad05b56d7819e530fd7a57d9520ea53d58"},{"file":"nodered/tools/install-host-observer-flow.mjs","sha256":"bb78468109f7b1f870b4317fa92d3ee59f67cd95c3a025d911f332723cdf6b58"},{"file":"nodered/tools/test-host-observer.mjs","sha256":"7aaf5374968e5d2bb5800b64dfbb2f602ce5e97505336c1573dbf4c617ef127f"}]} -->
## Observação do host e evidência de incidentes

O produtor passivo fornece fatos sanitizados; políticas de validade, thresholds, confirmação, dedupe e recuperação pertencem ao canvas observacao_host. Ausência de coleta é falha de observação, não prova de falha dos serviços. Container start não comprova prontidão; unknown preserva incidentes sem fabricar recuperação. Baseline não reenvia histórico; reconexão sem evento novo não confirma uma transição antiga. Testes usam contexto separado até o gate global dry-run. O operador do Switch para valor ausente é null; isnull não existe no runtime verificado. Replay aproximado não substitui validação do módulo oficial e observação operacional. Intenção de alerta, entrega do canal, execução do assistente e cobertura completa são provas distintas.

<!-- /memory-record -->
