# Git, workers e evidências de manutenção

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Proveniência dos ciclos Git e histórico de falhas

### Publicação interativa e correção posterior

`verified_publication` expõe um recibo adicional de comparação entre HEAD e
`origin/main`, com SHA completo, origem, horário, idade e cobertura. Não altera
`last_observed_publication`, que continua significando uma linha de push do
worker, nem converte `no_changes` em envio. A comparação é histórica, feita pelo
produtor no horário do recibo; a consulta MCP não abre uma conexão ao GitHub.

Publicações interativas usam `python3 scripts/git-publication-evidence.py publish`,
com checkout limpo, lock residencial e pre-push preservado. Para um envio já
concluído, `observe` apenas compara e registra: não repete o push. O worker chama
a mesma observação depois de sucesso, inclusive quando não houve mudanças.
O log fixo existente recebe uma linha própria `git publication verified`, nunca
uma linha falsa de sucesso do backup. Falha de observação não reenvia publicação.

`validation_diagnosis` reconhece somente causas fechadas em ciclos completos do
log limitado. A primeira causa é a referência documental remanescente ao HACS:
exige os quatro erros exatos do verificador, sem exportar logs arbitrários.
`hacs-correction` exige essa falha, executa o verificador documental atual e
confirma HEAD/remoto antes de vincular a correção ao horário da falha.
`last_verified_correction` preserva essa evidência histórica mesmo após um novo
recibo sem correção. Não comprova saúde permanente, ciclo diário, offsite ou
restauração. Recibo inválido, divergente ou futuro fica desconhecido.

Quando o pre-push falha em uma suíte TAP longa, o worker conserva no log privado
até quatro trechos de falha, com até 48 linhas de 2.000 caracteres cada, além
das últimas 160 linhas da saída. Isso mantém o diagnóstico de um teste que
falhou antes de centenas de testes posteriores. Não exporta a saída pelo MCP,
não reconstitui diagnósticos já descartados e não demonstra recuperação.
O próximo ciclo natural continua exigindo sucesso da validação canônica.

O recibo não cria agenda nem tópico de webhook. Os eventos atuais permanecem
notificações HA e términos de tarefas registradas. Depois de um deploy, a
aceitação com Eva deve consultar `backup_results` real; acesso visual ao catálogo
ou uma mensagem enviada pelo operador não basta para provar essa leitura.


O produtor `backup_results` usa o schema `1.3.0`. `last_worker_cycle` preserva
o resultado original do worker; `last_observed_publication` observa publicações
no log limitado e não identifica a origem da execução. `last_scheduled_cycle`
exige os metadados do fluxo canônico, identidade da requisição e horários
consistentes com o worker. Ausência, conflito ou falha de coleta mantém
`unknown`. A origem vem do tópico canônico e do ID do helper, não de uma
atestação criptográfica do agendador.

O fluxo de backup grava somente metadados sanitizados no arquivo fixo
`/data/.git-backup-health.json`, dentro do volume de dados já existente. A
simulação não grava esse arquivo nem altera o contexto persistente. A agenda,
os gates e o requisito de sucesso Git agendado para iniciar offsite são
preservados. Execução manual não libera offsite.

`known_failure_history` reúne a observação anterior preservada pelo operador
e até 16 falhas conhecidas do produtor canônico. Isso não recompõe uma série
histórica completa. Campos privados são descartados. O recibo anterior, o
contexto original e os resultados do worker permanecem preservados. Uma
publicação posterior não transforma uma falha antiga em sucesso.

A instalação exige preservar uma observação sanitizada real em
`/usr/local/lib/raspberry-repair-control/git-worker-baseline.json`, pertencente
a root, e fixar seu hash nas dependências da política existente. Esse recibo
é específico do host e não pertence ao pacote público. A API administrativa
do Node-RED usa a credencial existente somente em memória, compara o hash e
a revisão carregada, registra intent antes de submeter e confirma o estado
carregado e persistido depois. Resultado incerto exige reconciliação somente
leitura; não se repete a implantação. Não requer reiniciar o serviço.

Aceite: executar os testes `test-git-backup-health.mjs` e
`test-git-backup-flow.mjs`, as regressões puras de `test_health_summary.py`,
a validação e inspeção visual do canvas; depois consultar `backup_results`
pelo cliente MCP real. Antes do primeiro resultado natural com proveniência,
o ciclo agendado continua `unknown`. Somente o ciclo real posterior valida
o produtor em operação. Sucesso Git nunca comprova upload offsite,
integridade do bundle ou recuperação dos serviços.

## Captura automática de evidências sem ampliar administração

O componente [acceptance-observer](../../../scripts/raspberry-mcp/acceptance-observer/README.md)
lê o histórico e a telemetria existentes em cinco horários fixos: 25/10/2026
às 04h30, 15h20 e 20h33 UTC e 26/10 às 11h e 16h UTC. Esses calendários
não renovam a validade administrativa. Ele não admite tarefas,
não executa reparos e não renova a autorização. Consulta pelo MCP:
`maintenance_capabilities`, campo `evidence.data.procmon_acceptance_observation`.
A origem, a idade, falhas de coleta, cobertura e limites acompanham a resposta.
Antes da primeira captura real, o estado permanece `unknown`. Uma janela
válida não significa aceite do PC desligado, de todos os eventos ou da meta.

## Limite de espera do Git e recuperação de repasse

O executor Node-RED de backup usa uma variável de ambiente fixa
`GIT_BACKUP_REQUEST_TIMEOUT_SECONDS=600` e limite externo de 660 segundos.
O payload não vira argumento de comando. O script bind-mounted permanece
inalterado; o valor não vem do cliente MCP. O ciclo de 25/10/2026 mostrou
uma solicitação concluída em 206 segundos, após o limite antigo de 180.
A validação isolada reproduz a espera acima de 180 passos sem aguardar
minutos reais e confirma o mesmo identificador no resultado.

Timeout da ponte continua sendo erro de comunicação, não falha comprovada
do Git. Consulte `backup_results`, correlacione o identificador com o resultado
do worker e preserve os recibos. Não repita o Git nem invente uma origem
agendada para liberar offsite. A correção do limite não introduz retry
automático para efeitos incertos. O gate de origem agendada e a separação
entre backup manual e offsite permanecem iguais.

A recuperação administrativa de 25/10 teve recibo próprio e uma única
submissão ao worker offsite existente, depois da publicação Git real. Foram
confirmados 13 componentes, proteção criptográfica, recibo do agente externo,
retomada dos sete serviços em 64 segundos e retenção `observe_only` sem
exclusões. Isso não constitui aceite de um encadeamento canônico automático
completo, download remoto com checksum independente ou restauração de
desastre. As evidências públicas sanitizadas ficam em
[offsite-recovery.acceptance.json](../../../scripts/raspberry-mcp/offsite-recovery.acceptance.json).
O fluxo diário existente avançou depois para outras etapas: DietPi concluiu
e a atualização do Home Assistant falhou antes de recriar o container:
o worker não podia gravar seu registro de recuperação na pasta compartilhada.
A correção usa o diretório privado já pertencente ao worker, preservando os
bloqueios de registros antigos e mantendo recibos após prontidão verificada.

As fontes auditadas das recuperações administrativas ficam em
[`queue_offsite_handoff.py`](../../../scripts/raspberry-mcp/runtime-source/administrative-recovery/queue_offsite_handoff.py),
[`apply_git_bridge_wait.py`](../../../scripts/raspberry-mcp/runtime-source/administrative-recovery/apply_git_bridge_wait.py)
e [`flow_client.cjs`](../../../scripts/raspberry-mcp/runtime-source/administrative-recovery/flow_client.cjs).
São snapshots para revisão, com marcadores para o manifesto aprovado e o
host privado do Node-RED. Não são ferramentas de shell do MCP nem um
instalador para sobrescrever políticas ativas. A submissão offsite tem intent
anterior ao efeito, uma identidade fixa, verificação do Git concluído,
checagem de recursos/concorrência e recibo imutável. Após a submissão,
`backup_results` fornece o resultado atual do worker; o recibo de fila
isoladamente não comprova execução.

A candidata de imagem que não passou pela etapa de validação do Home
Assistant foi preservada fora do checkout para revisão. O Compose voltou
à imagem que permanece em execução, sem reiniciar serviços nessa contenção.
Antes de editar ou validar o projeto, confira a atividade de todas as etapas
diárias; o fluxo existente pode avançar após o resultado offsite.
