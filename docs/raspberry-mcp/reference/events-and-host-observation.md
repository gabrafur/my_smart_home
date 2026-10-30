# Eventos e observação do host

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Entrega de eventos e atualização recuperada

Em `maintenance_capabilities`, `events.current_observation.state` descreve a
assinatura. Consulte também `events.current_observation.delivery`: uma
assinatura `active` pode ter entrega `budget_held`, `reconciliation_required`
ou `unknown`. O resumo expõe somente contadores limitados, estado sanitizado
do último envio e razão enumerada. Não inclui conteúdo de avisos, callback
ou chave. Seis tentativas na janela móvel bloqueiam novos envios; uma espera
por espaçamento não recebe um horário de retry inventado. O resumo não muda
o limite, não renova a assinatura e não repete entregas incertas.

`webhook_accepted` não comprova execução da assistente nem prontidão de uma
entrega futura. Datas ausentes, conflito de relógio e falha de coleta mantêm
`unknown`. O aceite foi conferido por cliente MCP padrão no Raspberry e
pelo conector remoto real após recarregar a ponte. Uma conexão persistente
pode continuar usando o módulo anterior até ser renovada. A ativação teve
recibo próprio e não reiniciou o daemon Codex nem serviços residenciais.
Veja [event-delivery-health.acceptance.json](../../../scripts/raspberry-mcp/event-delivery-health.acceptance.json)
e [os testes de entrega](../../../scripts/raspberry-mcp/event-delivery-health.test.mjs).

A entrega agrupada ativa usa `notification_summary_v1`. Cada tentativa inclui
até oito notificações e agrupa suas revisões, com estado atual vindo de snapshot
recente. Estados atuais e mudanças novas precedem remoções antigas. Os IDs e
transições permanecem no ledger, com intent e membros atômicos antes da rede.
Remoção não comprova recuperação; resultado incerto não permite reenviar os
membros, mesmo em outro resumo. Registros que saem da janela recebem arquivo
e motivo explícitos, sem descarte silencioso; arquivo cheio falha fechado.

`events_status.delivery_queue` informa grupos, revisões agrupáveis, idade,
contagens de arquivo e vínculos duráveis. `delivery_opportunity` calcula o
bloqueio, próximo slot e compatibilidade com a validade da assinatura. Os mesmos
agregados estão em `maintenance_capabilities` no campo `delivery.summary`.
São projeções fechadas; coleta falha não vira zero. A cadência
`grouped_minimum_spacing_v2` admite até 144 tentativas em 24h, limite derivado
do intervalo mínimo preservado de dez minutos. O teto local anterior de seis
foi removido; tentativas antigas continuam contando, sem reset ou replay.
Isso não renova a assinatura, não altera limites da plataforma e não modifica
o heartbeat externo do Healthchecks.

Foi comprovada a leitura dos novos campos pelo cliente MCP real; a entrega de
um resumo no ciclo natural e a execução do assistente exigem recibos separados.
Confira o [contrato e procedimento](../../../scripts/raspberry-mcp/runtime-source/native-events/README.md),
o [aceite histórico do resumo](../../../scripts/raspberry-mcp/event-summary.acceptance.json),
o [aceite da cadência atual](../../../scripts/raspberry-mcp/event-cadence.acceptance.json) e
os [testes de resumo](../../../scripts/raspberry-mcp/event-summary.test.mjs).

Atualizar um módulo ESM no disco não muda o import já carregado no frontend
MCP persistente. Validar a chamada real pode revelar esse caso mesmo quando
testes isolados passaram. A correção precisou recarregar Events e reconectar
somente o túnel existente, mantendo autenticação e assinatura. Não reiniciou
Home Assistant, Node-RED, MQTT ou Codex. Reversão conserva dados/membros e
mantém Events parado até revisão de compatibilidade, para impedir replay.


A recuperação do Home Assistant concluiu no worker existente, confirmou
versão e prontidão e publicou o Compose no GitHub. A falha anterior foi
preservada. A etapa posterior dos containers parou antes de recriar serviços
porque faltava cobertura de prontidão do Portainer; esse gate permanece
ativo. Consulte [homeassistant-recovery.acceptance.json](../../../scripts/raspberry-mcp/homeassistant-recovery.acceptance.json).
Isso não comprova todas as integrações nem restauração de desastre.


## Observador passivo e recuperação de coleta

O [produtor de fatos do host](../../../scripts/host-observation/README.md) foi instalado
como serviço root isolado: eventos de containers/unidades e recursos sanitizados,
sem comandos remotos ou efeitos de reparo. A integração a políticas
[Node-RED](../../../nodered/tools/HOST_OBSERVER.md) foi implantada e tem aceite separado;
a exposição do novo relatório pelo MCP foi validada no cliente real, conforme
a seção seguinte. O cliente não deve inferir essa cobertura
apenas porque o serviço está ativo. Reconexões, anel limitado e falta de inventário
inicial impedem afirmar histórico completo.

A [regressão do modo atômico](../../../scripts/raspberry-mcp/procmon-observability/README.md)
registra a recuperação real de uma falha persistente da coleta, mantendo o
coletor original e os gates. Os ciclos naturais voltaram; a lacuna de 10.623
segundos permanece na evidência. Isso invalida o aceite de continuidade de 24h
nessa janela. Falhas antigas continuam históricas, mesmo após sucesso posterior.

## Monitor do host e contagens de Events pelo MCP

As ferramentas existentes aceitam `{"host":"raspberry"}` e continuam somente
leitura. Não foram acrescentados parâmetros de comandos, caminhos, prompts,
identidade ou permissões. A evidência real fica em
[host-observation-MCP.acceptance.json](../../../scripts/raspberry-mcp/host-observation-MCP.acceptance.json).

`maintenance_capabilities.evidence.data.host_observation` projeta dois arquivos
fixos: relatório do produtor root e contexto de aplicação do tab Node-RED.
O leitor abre diretório/arquivo sem seguir symlinks, exige owner/grupo/modo,
rejeita hardlinks, limita cada leitura a 64KiB e rejeita arquivo alterado durante
a leitura. Não executa conteúdo desses arquivos. O contexto pertence ao usuário
da aplicação; não é uma aprovação administrativa nem uma identidade de chatbot.

| Campo | Tipo / significado |
| --- | --- |
| `state`, `collection_error`, `observed_at` | observação disponível ou `unknown`, erro sanitizado/null e UTC |
| `producer` | horário/idade, sequência, perdas do anel, conexão dos streams e métricas allowlisted |
| `producer.resources` | horário/idade, valores numéricos ou null, erros e validade da política visual |
| `producer.producer_cost` | custo do próprio produtor; exclui journal filho e janela de 24h |
| `NodeRED` | horário/idade do último frame, sequência, papéis observados e incidentes sanitizados |
| `NodeRED.visual_policy` | política validada, lida do canvas; não redefine thresholds no MCP |
| `notification_intent_recorded` | intenção persistida; não prova entrega da notificação |
| `operational_health` | permanece `unknown`: cobertura parcial não prova saúde global |
| `*_proven` | continuam false paro cliente MCP autorizado, PC desligado, 24h e latência completa |

O contexto pode levar até 30s para persistir. Sua idade é apresentada e contexto
com mais de 60s fica desconhecido. Divergência de instância/sequência, datas
faltantes/futuras, política inválida e falha de coleta conservam `unknown`.
A API não exporta mensagens, logs, prompts ou credenciais. Um valor ausente não
vira zero ou recuperação. O monitor [Node-RED](../../../nodered/tools/HOST_OBSERVER.md)
continua sendo o local de decisões, confirmação, lifecycle e limites visuais.

`events_status` e `maintenance_capabilities.evidence.data.events.current_observation.delivery`
separam:

- `retained_event_records`: todos os registros de eventos ainda retidos;
- `eligible_pending_event_records`: eventos selecionáveis pela regra atual do
  dispatcher: assinatura ativa do mesmo principal, tópico autorizado, janela
  de 24h/início da assinatura e ausência de qualquer intent de envio;
- `queued_event_records`: alias compatível da contagem elegível, acompanhado
  de `queued_event_records_semantics`;
- `event_count_collection_error`: null ou erro sanitizado; erro/falta de evidência
  deixa pendência desconhecida, sem inferir ausência de trabalho.

Nas versões anteriores, `queued_event_records` era o total de linhas retidas,
inclusive eventos enviados. Não interprete recibos antigos como backlog real.
A projeção reconhece a resposta antiga como total retido e mantém pendência
`null`. Contagem nova inconsistente também fica desconhecida. A consulta usa
snapshot somente leitura e não modifica IDs, intents, assinatura ou orçamento.
Intent incerto/recusado/aceito exclui o evento da pendência; não vira retry.
Pendente não significa orçamento disponível, callback aceito ou execução do cliente MCP autorizado.

Para usar: consultar saúde e erros, verificar a origem/idade e diagnosticar
somente o papel afetado pelas ferramentas existentes. Seguir o catálogo
administrativo autorizado com identidade, idempotência, resultado e reconciliação;
não repetir efeitos incertos. `budget_held` deve ser preservado. A ativação
recarregou apenas Events e o túnel MCP, com recibos por etapa; manteve a mesma
assinatura e os intents existentes. Nenhum serviço residencial ou daemon Codex
foi reiniciado. As fontes auditadas e testes estão no snapshot público; manifestos,
políticas locais e credenciais continuam privados. Esses snapshots não podem
sobrescrever políticas de outro servidor sem revisão dos bindings pelo operador.


## Correlação de falhas e custo do coletor

A instrumentação de [sinal/gravação/custo](../../../scripts/raspberry-mcp/procmon-observability/README.md)
preserva o coletor original e seus limites. O observador do host registra CPU
nativa da unidade após transição real e com identidade correspondente. O
[auditor fixo](../../../scripts/raspberry-mcp/procmon-observability/invocation_audit.py)
é somente leitura, sem argumentos e sem nova operação de comandos no MCP.
Seu aceite real e hashes estão em
[procmon-signal-accounting.acceptance.json](../../../scripts/raspberry-mcp/procmon-signal-accounting.acceptance.json).

Em 26/10/2026 o wrapper do coletor recebeu um envelope explícito de 15 segundos
para concluir I/O, preservando CPU, memória, timer, handlers e durabilidade.
A unidade usa `TimeoutStartSec=20`. Dois ciclos naturais posteriores concluíram;
a continuidade de 24h segue pendente. Uma captura fixa somente de leitura está
agendada para 27/10/2026 às 23:00 UTC, inclusive após expiração administrativa,
sem novas admissões ou reparos. O [contrato do procmon](../../../scripts/raspberry-mcp/procmon-observability/README.md)
explica os limites da evidência, testes e reversão; os relatórios históricos
e seus resultados reprovados permanecem preservados.


O resultado distingue CPU do observador, CPU do processo até a telemetria e CPU
da unidade inteira. Invocações históricas sem telemetria continuam ausentes;
memória sem contador continua desconhecida. O aceite não substitui cadência das
amostras duráveis, observação de 24h, latência até cliente MCP autorizado nem prova de PC desligado.
Esses campos novos ainda não são projetados pelo coletor agendado de aceite;
o MCP continua expondo os limites explícitos da projeção já instalada.


