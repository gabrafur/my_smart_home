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

## Replay e implantação

Sequência no canvas: reset → saudável (baseline) → falha → confirmar (+25s) →
confirmar novamente (dedupe) → saudável (recuperação). Repetir com CPU alta,
fonte ausente, relatório antigo e inválido. Todo replay passa pelas mesmas
funções, decisões e lifecycle até `global_observer_dispatch_guard`, que encaminha
exclusivamente ao terminal dry-run. Não clicar nos nós reais de leitura para
simular incidentes e não usar o teste opcional de push como requisito deste tab.

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
aceito ou execução da Eva. O relatório novo ainda precisa de exposição própria
pelo MCP e os gates de latência completa, PC desligado e 24h continuam separados.

Para desativar decisões novas, desabilitar somente o tab por revisão autenticada,
preservando contexto/incidentes/recibos; o produtor passivo pode permanecer.
Para removê-lo do projeto, atualizar também o gerador, a política de testes e a
cobertura global. Nunca apagar intents ou limpar contexto de produção para
permitir repetição de efeitos incertos.

Evidência sanitizada de implantação e ingestão natural: [nodered-integration.acceptance.json](../../scripts/host-observation/nodered-integration.acceptance.json).
