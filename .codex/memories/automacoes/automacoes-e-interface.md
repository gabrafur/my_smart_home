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
  `localizacao_pessoas`: `home` 100 m e `near_home` 700 m. A zona HA
  `location_update_ring` (1.500 m) é apenas um geofence de transporte do iOS e
  não é consumida por painéis ou automações. O antigo controle inativo de
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
  Exige motor `on` confiável ou contingência canônica; no salto direto para
  `home`, um `off` vencido sem falha de comunicação possui fallback específico.
  A posição do `vehicle_primary` nunca autoriza o acendimento. Se a integração
  do motor estiver comprovadamente indisponível, o bypass preservado pode
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

<!-- memory-record {"id":"renovacao-gps-e-cadencia-do-veiculo","category":"LONG_LIVED_DECISION","kind":"PROJECT_DECISION","last_verified":"2026-09-22","evidence":[{"file":"nodered/tools/functions/people-refresh-decide.js","sha256":"3aa01a0bbfe67090b2508179a98695e07aaf7e49f0674329d7775a8be178e030"},{"file":"nodered/tools/functions/location-policy-validate.js","sha256":"6d77dfa2d14d78deafa124d1e78ecb6bc51d20fe71fed8269fdd6f2e8bbc5d73"},{"file":"nodered/tools/functions/vehicle-primary-refresh-policy.js","sha256":"3be1a5f6ced31f7f9706b78e643c87fe4aed5c1d021b40c696e04bf5919cda76"},{"file":"nodered/tools/functions/vehicle-refresh-facts.js","sha256":"f62a4df41741d431b4a8b4c81c37526240d0203412d9527389350ff696c6be36"},{"file":"nodered/tools/functions/vehicle-primary-provider-backoff-sync.js","sha256":"1893c67c2cd2e84366bae5f4189a85ec5ad6d76bb10b77008668259a064b9cdb"},{"file":"docs/ILUMINACAO_SEGURANCA_NODERED.md","sha256":"526e48e3036efb173d150e0c80c57ce222ff6bdbf0e3900081d5b8c54909dcab"}]} -->
## Renovação preventiva e limites externos

A localização de cada morador solicita renovação aos 5 min em near_home e aos 10 min nas demais situações; a validade permanece em 15 min. Tick, sondas do anel e vigília de chegada compartilham o coordenador, com até três tentativas a 60 s, diagnóstico silencioso sem push nem aviso persistente por falta de GPS novo, e depois backoff de 30/60/120/240 min. Apenas posição realmente nova e atual confirma sucesso e zera tentativas; aceite de serviço e republicação não bastam. O iOS/iCloud não garante resposta; três pedidos sem callback não comprovam falha de conexão/permissão e podem ocorrer antes de vencer o GPS. Não mascarar dados vencidos. Avisos legados dessa condição são removidos silenciosamente sem declarar recuperação; erros efetivos de serviço/conexão continuam no observador. Parâmetros visíveis ficam em localizacao_pessoas, grupos 0b/0c. Para o veículo, proximidade atual ou retorno armado limitado pela janela canônica mantém 1 min com motor OFF e 5 min com motor ON; ambos os moradores atuais em home encerram essa faixa. A posição do veículo pode acelerar polling, nunca autorizar o refletor. O prazo explícito do provedor prevalece inclusive sobre comandos extraordinários/manuais e mudanças de cadência; liberação antecipada remove somente esse prazo, sem declarar a telemetria recuperada. A leitura extraordinária 90 s após home continua independente do lifecycle do refletor. Antes de afirmar que uma correção está ativa, comparar a definição em memória pela API do Node-RED e observar um ciclo nativo: arquivo ou commit não comprova deploy.

<!-- /memory-record -->

<!-- memory-record {"id":"retomada-internet-vpn-e-estabilidade-zigbee","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"docs/NODERED_STARTUP_RECOVERY.md","sha256":"61241fd9488ce7d2211f725adc9b9d714d38ea1515cadadcb13256d40f67d988"},{"file":"nodered/tools/install-startup-readiness.mjs","sha256":"3880b2e8a232e7d1e4e39a63f697c0898d443f8ed33319c685fecfb66d2b137e"},{"file":"nodered/tools/functions/zigbee-route-state-mutate.js","sha256":"a41c6bb65dfb4b9f04f501b5a29b85696670b52e5b77b711c2fbcc0c87108888"}]} -->
## Retomada dependente de internet e VPN e estabilidade Zigbee

O tab retomada_servicos consome as classificações canônicas de internet e VPN e libera tarefas externas após 180 s de startup e 120 s contínuos com ambas online. Usa uptime monotônico, rejeita retained como prova, coalesce intenções por chamador e revalida decisões depois da liberação. Monitores de conexão e proteções locais iniciam independentemente. No monitoramento_zigbee, configure ok apenas inicia verificação: recuperação exige dados novos após 300 s sem falha; erros tardios e duplicatas preservam o incidente e o limite de três tentativas. Consulte docs/NODERED_STARTUP_RECOVERY.md para escopo, limites e testes.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-lazy-manager-no-executor","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"homeassistant/custom_components/public_bindings/icloud.py","sha256":"a86c4b0c48f7004fdd802695475e687eb05ac754d0747e4e8308b90ef4bc6cca"},{"file":"homeassistant/custom_components/public_bindings/__init__.py","sha256":"c3dba93496ea5902064c77c5db38fc0672db8c6d1f6ba78cba390a107d84f632"},{"file":"homeassistant/tests/test_public_bindings_icloud.py","sha256":"8ff9ecdfb3e42397ea82b3dd12d4ee1e0eb7c5cc38383129943fd6fe3b84dbbe"}]} -->
## Refresh iCloud fora do event loop

O acesso à propriedade api.devices pode executar HTTP antes de retornar o gerenciador. O public_bindings deve resolver essa propriedade e executar refresh(True) juntos no executor do Home Assistant; mover somente o método refresh não elimina o bloqueio. O adaptador mantém falhas explícitas e não altera as políticas de seleção ou frequência do Node-RED. A regressão executa o adaptador real com uma propriedade lazy que rejeita acesso no event loop.

<!-- /memory-record -->

<!-- memory-record {"id":"historico-detalhado-falhas-node-red","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md","sha256":"35d48cb8c9972842c2bb1b30a67371475725e4071ae23eee1e00449b0b17352a"},{"file":"nodered/tools/functions/global-flow-observer-diagnostic-build.js","sha256":"e9a6af71efe7c4e17a72f7c7b5bcbbec7a0bfaf7b6fe3eaca74b4296611b378c"},{"file":"nodered/tools/test-failure-diagnostics.mjs","sha256":"a83adefabe68521338b38755d14dfbaa329582860a31199693292270e7d57951"}]} -->
## Causas detalhadas fora do resumo de notificação

O observador global grava diagnóstico privado por ocorrência antes dos gates de notificação, inclusive erros repetidos ou suprimidos. Alertas de domínio e status confirmados entram pelo dispatch. Mensagem, stack, causas encadeadas e campos operacionais explícitos ficam em JSONL fora do Git, com remoção de padrões de credenciais, truncamento declarado e retenção pela política error_retention_days. O resumo de push e o estado de dedupe não substituem esse histórico. Testes usam terminal em memória; falha do escritor segue somente ao log do runtime para evitar recursão. Detalhes nunca recebidos ou já descartados por versões antigas não são reconstruídos.

<!-- /memory-record -->

<!-- memory-record {"id":"recuperacao-status-nativo-home-assistant","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"nodered/tools/functions/global-flow-observer-status-recovery.js","sha256":"6e792b8f5a9399ddfc126939cb1471bb478d01ff835efc6ab31c74c7bd368663"},{"file":"nodered/tools/test-global-flow-observer.mjs","sha256":"2337302d98e2749517670102f6a6a73281ec7835becf8ecba5f573cc7fb8a552"},{"file":"docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md","sha256":"35d48cb8c9972842c2bb1b30a67371475725e4071ae23eee1e00449b0b17352a"}]} -->
## Recuperação da conexão por status nativo

A integração Home Assistant emite as chaves não traduzidas home-assistant.status.connected e home-assistant.status.running. O observador deve reconhecê-las como recuperação explícita e encerrar todas as fontes da conexão compartilhada; ignorá-las mantém incidentes vencidos e lembretes mesmo com a conexão restabelecida. Valores de entidade, sucesso de serviço e connecting não comprovam recuperação. O replay cobre desconexão curta, recuperação e ausência de lembrete após seis horas.

<!-- /memory-record -->

<!-- memory-record {"id":"diagnostico-do-guardiao-de-memoria","category":"OPERATING_PROCEDURE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"docs/HOST_MEMORY_GUARDIAN.md","sha256":"aacee2549c2aae5710ff4ea61602a1c238aec02dc6bac3e777e6ccc6a6bcc22e"},{"file":"docs/NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md","sha256":"35d48cb8c9972842c2bb1b30a67371475725e4071ae23eee1e00449b0b17352a"}]} -->
## Diagnóstico do guardião de memória

Alertas antigos genéricos não identificam sozinhos a causa do guardião. O alerta canônico atual preserva o motivo sanitizado; a enumeração de processos usa somente nomes e mantém o código de erro do sistema. Investigue o histórico filtrado pelo nó e os campos status/reason; não deduza falta de RAM apenas do título de indisponibilidade. Falha de leitura deve bloquear a limpeza de temporários. Nunca copie registros operacionais para a memória pública.

<!-- /memory-record -->

<!-- memory-record {"id":"recuperacao-direta-da-iluminacao","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"nodered/tools/install-location-lifecycle-flow.mjs","sha256":"908a35c3c5e19c43f1d42b90ebfdb95e6b11af99a9cb1dc7fa5d83c2e7e1449c"},{"file":"nodered/tools/functions/people-lifecycle-recovery-build.js","sha256":"de620f9e7fdefa458c0efc165cfd48ca2158da83033906d1c776bb5e18248f9a"},{"file":"nodered/tools/functions/security-light-mark-active.js","sha256":"a8bd90850afa216b96388ddfa578420c00a97dc6a776b6671bb32a964ad68739"},{"file":"nodered/tools/functions/security-light-arrival-facts.js","sha256":"6c59e2f9e41509af011e7c707a478107ad5f59b7dbd215d2c8d7349ddad919c1"},{"file":"nodered/tools/test-security-light-flow.mjs","sha256":"5ff301d58495932e26623728467b9520ca444ac604e01a8149930201d905dc03"}]} -->
## Recovery direto e ordem dos eventos da iluminação

O produtor deve emitir recovery de iluminação para unknown/unavailable -> home somente com ciclo externo previamente armado, posição atual e sem catch-up tardio; consumir o armado em home e preservar a rota exclusiva de iluminação. O evento leva snapshot canônico, revalidado tanto no gate de chegada quanto na fronteira final: links independentes podem entregar o evento antes do cache. Cache mais recente e GPS vencido continuam bloqueando. O gate JSONata usa $lookup para selecionar o residente; testar a expressão publicada e o caminho até o terminal dry-run, não apenas eventos montados diretamente no consumidor. A falha persistida de comunicação do motor vale também no gate final, inclusive com bypass de posse manual. Essas regressões comprovam falhas do código, não a causa de um incidente residencial específico.

<!-- /memory-record -->

<!-- memory-record {"id":"ciclo-local-perdido-antes-do-contexto-no-startup","category":"KNOWN_FAILURE_MODE","kind":"VERIFIED_FACT","last_verified":"2026-09-22","evidence":[{"file":"nodered/tools/functions/security-light-local-excursion.js","sha256":"121cebfc1bc985d24ea49e10b50c2969be6b626ed2e260d2a327eed2d789bffe"},{"file":"nodered/tools/functions/security-light-mark-active.js","sha256":"a8bd90850afa216b96388ddfa578420c00a97dc6a776b6671bb32a964ad68739"},{"file":"nodered/tools/functions/people-lifecycle-facts.js","sha256":"785e4389f02778057d97b498dd535144738ffe7a9389c4c980b06e380e32c734"},{"file":"nodered/tools/functions/people-lifecycle-state-load.js","sha256":"56fbad9850c223014f2ba2a90e8446403449bad48f7c94a56a88d9401e4c2665"},{"file":"nodered/tools/functions/security-light-pending-validate.js","sha256":"41b3b68d4f81c3e052ba83ac8c1ddf00db95578a5008acda8bd55c2ca9c79d29"},{"file":"nodered/tools/functions/security-light-replay-build.js","sha256":"6a8cc5b23318e6467d5c0d1a58ccdb053b0900064564222a8b05a5be47f422c5"},{"file":"nodered/tools/test-security-light-return-recovery.mjs","sha256":"c923eaee2701a68d37eea0d5f3063028ab2c51bdcdae20994e552c829c00b1d8"}]} -->
## Recovery do ciclo local e chegada longa pareada

Startup parcial não encerra passeios locais persistidos: a prova ON/OFF é validada e retida até reencontrar o ciclo canônico com posição atual, respeitando a janela de local_excursion_minutes. OFF durante falha de comunicação não comprova parada. Preparar um candidato não o consome; somente a fronteira final autorizada marca consumed_at. Zona externa ou permanência em home além de primary_home_grace_minutes encerra o passeio e invalida replays. Para saídas externas longas, snapshot home pode transferir o armado para home_arrival_candidates sem emitir chegada; somente evento direcional da mesma observação a recupera dentro de arrival_recovery_minutes, inclusive após restart. Replay pendente reutiliza os gates de motor e não impede retorno local atual de outro residente quando sua própria posição está indisponível. A regressão sintética cobre permutações de startup, cancelamento, isolamento e retornos após horas até o terminal dry-run; não comprova a ordem dos eventos de um incidente residencial específico.

<!-- /memory-record -->
