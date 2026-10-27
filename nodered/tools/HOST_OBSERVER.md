# Observação do servidor no Node-RED

O tab `observacao_host` consome somente o relatório protegido do
[produtor passivo](../../scripts/host-observation/README.md). O Node-RED mantém
as decisões visíveis: validade, classificação da fonte, thresholds de recursos,
confirmação, dedupe, recuperação e envio ao gate global existente. Não executa
reparos nem comandos enviados por clientes. A Eva consulta o MCP e usa suas
operações autorizadas, com os mesmos limites e validade administrativa vigentes.

O leitor [read-host-observation.mjs](read-host-observation.mjs) não aceita argumentos.
Abre o diretório fixo e o arquivo via descritor, sem seguir symlinks, exige
proprietário/grupo root e modos esperados, rejeita hardlinks e limita a leitura
a 65.536 bytes. Sua projeção fechada descarta campos extras e rejeita datas,
sequências, ações ou métricas inválidas. Falhas geram somente envelope sanitizado.
Não exporta logs, mensagens, nomes privados de containers, credenciais ou prompts.
O executável `/usr/local/bin/node` foi verificado no container instalado; em uma
instalação diferente, confirme o caminho antes de habilitar o canvas.

## Política visual e semântica

O grupo de política contém valores, unidades, finalidade e limites. O nó de
validação preserva a última configuração válida quando recebe uma inválida.
Padrões: leitura a cada 2s, relatório válido por 30s, recursos por 45s,
confirmação de evento por 5s, recursos e observação por 20s. CPU ocupada: 90%;
memória disponível: 512MiB; disco/inodes usados: 85%; temperatura: 80°C.
Esses valores são política de atenção, não prova de latência alcançada.
Recursos precisam de duas amostras distintas; repetir a mesma não confirma
persistência. O contador OOM crescente indica ocorrência no host, sem atribuir
causa ou morte a um processo específico, e permanece latched para investigação.

Falha direta de unidade, término/destruição de container e healthcheck unhealthy
seguem a confirmação visual. `started` do systemd confirma o resultado do job,
sem comprovar prontidão de todas as aplicações. Container `start`, `restart` ou
healthcheck `starting` conservam evidência desconhecida; somente healthcheck
`healthy` encerra automaticamente seu incidente de prontidão. Serviços sem esse
healthcheck exigem evidência de aplicação própria. Ausência/stale de relatório ou
stream é incidente de **observação**, não prova de falha do Docker ou de toda a casa.

Na primeira leitura ou mudança de instância, o cursor estabelece baseline;
não reenvia o histórico anterior como incidente novo. Lacuna do anel é explícita.
Após uma desconexão observada ou lacuna de relatórios, uma transição antiga
não volta a provar estado atual sem novo evento. Não há inventário inicial
completo, cursores duráveis do produtor ou garantia de recuperar eventos perdidos.
Incidentes já notificados ficam preservados quando a evidência fica desconhecida.
A política não usa um simples pedido de manutenção pendente para suprimir falhas.
Transições planejadas e confirmação podem absorver eventos breves; não há gate
completo de manutenção intencional nem alegação de cobertura universal.

Produção usa o store `persistent`; testes têm chaves separadas `__test`.
O lifecycle marca o incidente antes de solicitar entrega e suprime repetições.
Essa marca prova intenção local, não confirmação do Home Assistant, do celular ou
da Eva; falha de entrega deve ser reconciliada pelo canal global, sem replay cego.
Recuperação remove somente o aviso associado; o histórico de falhas continua.

## Medição passiva e janela de cobertura

O grupo próprio de medição recebe toda leitura normalizada e sempre a devolve
aos gates existentes. Não altera notificações, thresholds ou lifecycle. Seus
contratos visíveis são evento até 10.000 ms e recurso até 60.000 ms; a validação
aceita respectivamente 1.000–60.000 ms e 20.000–120.000 ms, preservando o último
valor válido. São limites da evidência, separados dos tempos de confirmação.

O produtor publica sequências de amostras, totais por origem e contadores de
falhas de stream, inclusive quando a conexão se recupera entre duas leituras.
O consumidor conta cada incremento uma vez, incluindo eventos saudáveis e
amostras sem incidente. Eventos removidos do anel e amostras intermediárias
não lidas entram em `missing`; horário ou métrica ausente entra em `unknown`.
`expected` representa incrementos conhecidos da sequência, não uma contagem
independente de ciclos que o produtor deveria ter executado. Cadência real e
intervalos sem produção precisam de verificação adicional para aceite de 24h.
Ausência de eventos Docker permanece contagem zero, sem comprovar a latência
daquela origem. A contagem começa no baseline, sem reconstruir o passado.

O leitor mede seu próprio horário e relógio monotônico, exigindo o mesmo hash
de boot do produtor. Cada leitura verifica a relação entre relógios com limite
de alinhamento de 1.000 ms, incluído conservadoramente no limite superior da
latência fonte→leitor→canvas. Relação não confirmada permanece desconhecida.
O canvas usa o builtin `perf_hooks` para medir a janela monotônica. Mudança
de instância, reinício do consumidor, alteração do contrato ou salto de relógio
abre outra época e preserva contadores anteriores e épocas inconclusivas.
O produtor marca incerteza de relógio por 60s após um salto civil detectado.

O estado `host_observer_timing_v1` fica no store `persistent`, com até 25 âncoras
horárias cumulativas. A janela só vira `candidate` depois de abranger pelo
menos 86.400s monotônicos; seus deltas precisam corresponder às âncoras. Isso
não é aprovação de 24h: verificar contagens, perdas, desconhecidos, excessos,
falhas de fonte e lacunas. O contexto tem flush de 30s e não é arquivo bruto de
eventos nem journal transacional.

`invalid_reason_history` preserva contagens por motivo fechado e as últimas 16
observações inválidas, com horário de observação (ou `null`) e época. A
recuperação não apaga esse registro. `covered_total` vincula a atribuição à soma
dos contadores inválidos atual e anterior; metadados incoerentes ficam
`unknown`, sem reiniciar contadores ou inventar um histórico limpo.

A migração registra falhas anteriores em `unattributed_prior_count`, sem deduzir
sua causa. Ela mantém época, início e âncoras existentes. Se uma reversão para o
produtor antigo acrescentar contagens sem atualizar os motivos, a versão nova
reconcilia somente essa diferença como desconhecida. Os testes de motivos
incluem recuperação, reinício, reversão, retenção limitada e entradas corruptas.
O MCP valida esse contrato e omite texto ou campos fora da allowlist. Isso é
diagnóstico de observações, não uma nova política de alerta residencial. Perdas anteriores ao produtor e interrupções
entre épocas continuam fora da cobertura comprovada. HA/MQTT, chegada de push
e execução da Eva exigem evidência adicional própria.

A projeção fechada é
`maintenance_capabilities.evidence.data.host_observation.passive_timing`.
Ela expõe épocas, contadores, máximos e janela, sem IDs brutos ou âncoras. Seus
campos de aceite global permanecem falsos. O
[aceite sanitizado](../../scripts/raspberry-mcp/passive-host-timing.acceptance.json)
separa replay sintético, transação MCP e amostras naturais.

## Replay e implantação

Sequência no canvas: reset → saudável (baseline) → falha → confirmar (+25s) →
confirmar novamente (dedupe) → saudável (recuperação). Repetir com CPU alta,
fonte ausente, relatório antigo e inválido. Todo replay passa pelas mesmas
funções, decisões e lifecycle até `global_observer_dispatch_guard`, que encaminha
exclusivamente ao terminal dry-run. Não clicar nos nós reais de leitura para
simular incidentes e não usar o teste opcional de push como requisito deste tab.

O replay automatizado no runtime pode fornecer `_host_test_run_id` com 32 hex.
Reset inicia esse rascunho isolado; outras etapas só avançam com o mesmo ID.
Cliques manuais continuam disponíveis após reset sem ID. O identificador
atravessa os mesmos adaptadores e lifecycle até o terminal compartilhado, que
registra `run_id`, `source_flow_id` e `receipt_sequence` em memória. Produção,
teste de entrega e traces inválidos não geram esse recibo. Confirmação duplicada
preserva a sequência; recuperação cria o próximo recibo. O cliente espera as
barreiras do fixture, incidente e terminal, depois limpa apenas as chaves de
teste e confirma sua ausência no store persistente.

O mesmo replay atravessa a medição com `host_observer_timing_v1__test`, somente
em memória. Após saudável, falha, duas confirmações e recuperação, deve contar
quatro amostras de recursos e dois eventos novos de systemd, sem duplicar o
anel. Reset limpa também esse estado e o marcador de runtime de teste, sem
alterar o estado de produção. Os recibos de notificação desse cenário usam
horário sintético futuro e conservam conflito de relógio; não medem entrega.

Automatizado: `node nodered/tools/test-host-observer.mjs`. A descoberta canônica
inclui o teste; cobre datas ausentes/conflitantes, coleta falha, alertas/recovery,
container start sem prontidão, recurso sem nova amostra, OOM, cursor, dedupe,
allowlists e separação de contextos. Há um contrato fechado dos operadores
suportados pelo Switch; `null` é o operador do runtime, `isnull` não existe.
O primeiro replay aproximado não detectou esse erro; 42 avaliações isoladas do
módulo oficial instalado e observação real posterior complementam os testes.
Não confundir replay aproximado com execução completa do runtime residencial.

Gerador: `npm --prefix nodered run flows:update-host-observer`. Depois validar
layout, testes manuais e cobertura global; renderizar e inspecionar o canvas.
A implantação pelo Admin API reutiliza autenticação existente em memória,
compara revisão/hashes, registra intent antes de um envio e confirma estado
carregado e persistido. Usa deploy de nós alterados, sem restart de serviço.
Resultado incerto exige somente reconciliação; não repetir o envio.

A rota final reutiliza o hub de notificações e notices HA já sanitizados.
A assinatura Events e seu orçamento permanecem iguais. `budget_held` continua
impedindo entrega adicional nessa janela; um alerta criado não comprova webhook
aceito ou execução da Eva. O relatório novo é exposto por
`maintenance_capabilities.evidence.data.host_observation`, com projeção fechada e
aceite no cliente real. Os gates de latência completa, PC desligado e 24h continuam separados.

Para desativar decisões novas, desabilitar somente o tab por revisão autenticada,
preservando contexto/incidentes/recibos; o produtor passivo pode permanecer.
Para removê-lo do projeto, atualizar também o gerador, a política de testes e a
cobertura global. Nunca apagar intents ou limpar contexto de produção para
permitir repetição de efeitos incertos.

Evidência sanitizada de implantação e ingestão natural: [nodered-integration.acceptance.json](../../scripts/host-observation/nodered-integration.acceptance.json).

Aplicação/reversão/reaplicação pelo MCP, com replay nativo correlacionado:
[nodered-controlled-deployment.acceptance.json](../../scripts/raspberry-mcp/nodered-controlled-deployment.acceptance.json).
Esse aceite não substitui os gates de eventos naturais, latência, PC ou 24h.
