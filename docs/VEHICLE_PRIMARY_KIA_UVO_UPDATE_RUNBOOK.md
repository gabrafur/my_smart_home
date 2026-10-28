# Runbook de atualizacao segura Hyundai / Kia Connect

## Objetivo

Atualizar `custom_components/kia_uvo` sem permitir que o HACS sobrescreva o
delta local do vehicle_primary. A base upstream e registrada em
`scripts/kia-uvo-upstream.json`; as customizacoes permanecem nos commits deste
repositorio, sem manter uma copia manual de patch que possa ficar stale.

## Diagnóstico de falha da auditoria

O worker publica `reason` no resultado `kia-uvo-result`, junto do status, ID,
modo, alvo e código de saída já existentes. O campo aceita somente
`connect_timeout`, `transport_timeout`, `dns_resolution_failed`,
`connection_failed`, `tls_verification_failed` ou `audit_failed_unclassified`.
Um motivo ausente ou não reconhecido permanece desconhecido; não se recupera
uma causa histórica a partir de uma tentativa posterior.

A categoria vem do código técnico da exceção e de sua cadeia de causas
limitada, nunca do texto da mensagem. Um descritor herdado interno transporta
somente esse token; não há parâmetro para caminho de diagnóstico nem exportação
de URL, stack ou credencial. O arquivo temporário tem modo 0600 e é removido.
O resultado mantém a publicação atômica e os IDs anteriores. Uma falha consumida
não é repetida; o adiamento mantém a solicitação pelo contrato existente.

No Node-RED, `failed`, `unavailable` e `rollback` são resultados operacionais do
worker. Produzem o aviso **Verificação da integração veicular não concluída**,
com motivo seguro, em vez de simular uma exceção do parser. Respostas de
protocolo inválidas continuam sendo erros do nó. O aviso conserva silêncio de
seis horas e deduplicação. O campo de motivo não autoriza retry ou instalação.

O encerramento do aviso exige um resultado posterior `compatible`, `conflict`
ou `applied`, com versão válida e `checked_at` posterior à falha e não futuro.
Ausência, data antiga ou conflitante mantém o incidente aberto. O encerramento
se refere à verificação; não prova a saúde do veículo, atualização instalada,
execução da Eva ou saúde de outros serviços. A notificação genérica histórica
não é apagada pela instalação desta correção.

Os testes `scripts/kia-uvo-audit-*.test.mjs` usam workers e relógios sintéticos.
Não executar `check` como teste de ausência de efeitos: o auditor real pode
publicar um evento de atualização disponível no Home Assistant. A implantação
altera somente o parser e sua ligação explícita ao observador, com deploy
Node-RED do tipo `nodes`; não exige reiniciar serviços ou executar uma auditoria.
Reversão exige conferir hashes e restaurar produtor, fluxo e fontes da revisão
anterior, preservando recibos e solicitações; resultado incerto exige
reconciliação antes de qualquer nova tentativa.

## Deteccao

O tab Node-RED `atualizacoes_diarias` inventaria todas as entidades `update.*`
a cada 30 minutos e ao subir. Esses ciclos são somente auditoria. Às 03:00, ou
por acionamento do botão manual de produção, o inventário recebe uma autorização
efêmera válida apenas para aquele ciclo. Um switch visual reconhece Bluelink e
encaminha somente essa entidade ao subfluxo protegido. A ponte coalescente não
expõe Docker socket, token ou checkout ao container; o worker do host executa
uma solicitação com alvo exato:

```bash
node scripts/kia-uvo-safe-update.mjs check --target vX.Y.Z
```

O alvo vem de `latest_version` da entidade do Home Assistant, é validado como
SemVer pelo Node-RED e volta a ser validado pelo helper do host. Nunca é
substituído por metadata HACS possivelmente defasada. O check baixa base e alvo
oficiais em `/tmp`, calcula o delta local, tenta
aplica-lo no alvo e executa `compileall` e os marcadores obrigatorios. O
resultado fica em `/config/.storage/kia_uvo_safe_update` e e exibido por
`sensor.integracao_vehicle_primary`.

As demais entidades seguem subfluxos próprios: Core é reconciliado pelo digest
do container, integrações HACS versionadas exigem auditoria, firmware físico
instala automaticamente a versão mais recente oferecida pela integração, com
candidato recente, bloqueio durante instalação, dedupe e dry-run. Fontes
desconhecidas falham fechadas. O
modo direto `docker-auto-update.mjs ha-updates` foi aposentado. Sem autorização,
o resultado Kia é apenas registrado. Em uma janela autorizada, `compatible` e
`conflict` encaminham o alvo exato ao worker Codex; ele cria uma candidata
isolada, e o host a promove somente com checkout limpo, backup, rollback e
validação completa. O Node-RED não chama `update.install` genericamente.

Estados possiveis: `compatible`, `conflict`, `applying`, `applied` e
`rollback`. `conflict` nunca altera o componente em uso.

## Aplicacao protegida

O caminho normal é o ciclo autorizado do Node-RED. O worker Codex reconcilia o
upstream com os deltas locais e publica uma única branch candidata; o promotor
revalida essa candidata no host antes de chamar o mesmo aplicador seguro. Os
workers Alexa e Kia compartilham um lock, e a promoção também espera qualquer
etapa ativa de DietPi, Core, containers ou dependências do repositório.

Antes de qualquer instalação, `validateMerged` também executa as regressões
locais de consumo e refresh contra uma cópia isolada da candidata. Uma falha
interrompe a preparação, antes de `update.install` ou do restart. Os testes
simulam as APIs externas, sem consultar o veículo ou tocar a instalação ativa.
Novos imports upstream precisam ser representados nessa simulação quando
pertinentes; a simples compilação não comprova preservação dos comportamentos.

O comando abaixo permanece apenas como recuperação operacional ou execução
manual deliberada, depois de revisar o resultado, o diff e os testes:

```bash
HA_LONG_LIVED_TOKEN='<token somente no ambiente>' \
  node scripts/kia-uvo-safe-update.mjs apply --target vX.Y.Z
```

O token nao e gravado pelo script. O fluxo:

1. repete toda a analise em staging;
2. cria backup local do componente e de `hacs.repositories`;
3. chama o servico oficial `update.install` do Home Assistant/HACS;
4. reaplica o delta local ja validado;
5. reinicia somente o Home Assistant;
6. valida entidades essenciais, combustivel, botoes, biblioteca e metadata;
7. atualiza `scripts/kia-uvo-upstream.json` para a nova base.

No caminho normal, o promotor versiona e publica a sincronização somente depois
dessas confirmações. Nunca use force push.

Se o runtime já foi validado e a publicação falhar antes do commit, a retomada
aceita somente os caminhos exatos da candidata e compara todos os bytes antes
de continuar. Remoções upstream exigem ausência do arquivo local; symlinks,
arquivos remanescentes e alterações no conteúdo da candidata são rejeitados.
Alterações extras de outros trabalhos pausam a publicação sem descartá-las. A comparação inclui
mudanças staged e não staged. A retomada mantém a verificação de alterações
protegidas desde a base e não reinstala nem reinicia a integração já validada.

## Conflito e absorcao upstream

Os arquivos alterados localmente e conflitos aparecem no JSON de status. Se a
aplicacao do delta falhar, a versao instalada permanece intacta. Em cada
versao, compare os marcadores e o diff: funcionalidade incorporada oficialmente
deve ser removida do delta local e validada usando o upstream.

## Adiamento e alertas da promoção

No canvas `atualizacoes_diarias`, `deferred` indica que a promoção aguarda um
pré-requisito, como checkout limpo ou término de outra atualização. Esse estado
fica amarelo e não emite erro nem push. O polling pode atualizar `updated_at`
a cada leitura; esse horário não identifica um incidente novo.

Depois de validar o runtime, `applied_pending_git` preserva esse checkpoint:
`working_tree_changed` informa arquivos de outro trabalho; `main_behind_remote`
informa main local atrasada; `host_update_in_progress` informa outra etapa do
host. A espera fica amarela e não reinstala o componente. A retomada só publica
quando a worktree foi reconciliada; não executa reset, stash nem merge automático.
Os códigos são enumerados na ponte; detalhes privados ficam no host.

Uma falha real (`failed` ou `applied_pending_git` com
`reason_code=git_publication_failed`) continua chegando ao observador global. O consumidor
deduplica por estado, código de motivo e versão candidata em contexto persistente, inclusive após
restart; uma transição de estado ou outra versão permite nova avaliação. O
horário permanece no resultado diagnóstico, fora da assinatura do erro.

O replay `flows:test-daily-host-updates` cobre adiamento repetido, falha real,
mudança de horário, recuperação, nova candidata e isolamento do dry-run.
Use **reset promoção → Git ocupado → falha da promoção segura → promoção
concluída** no canvas. O teste do promotor usa repositórios temporários e comprova
retomada após concorrência, pausa por outro update e main atrasada, sem chamar
updater, Home Assistant ou dispositivos. Bytes adulterados continuam bloqueados.

A promoção retoma automaticamente quando os pré-requisitos voltam a estar
disponíveis. Uma publicação de imagem rejeitada pode deixar o checkout alterado
e bloquear essa retomada. Verifique a validação pública antes de repetir o
update: notas sobre outros serviços devem usar evidências específicas, como
Dockerfile, testes e guia operacional, sem depender incidentalmente do hash do
Compose inteiro. Preserve o gate de evidências e confirme que as fontes
restantes sustentam a nota. O gerador do canvas também preserva a geometria e
os links nomeados aprovados; sua regressão cobre a regeneração idempotente.

## Rollback

Antes de instalar, o script preserva:

- o diretorio completo `kia_uvo`;
- o registro `hacs.repositories`;
- a versao/base anterior;
- a configuracao do Home Assistant, que nunca e modificada.

Falha de startup, entidades ausentes, combustivel indisponivel, versao de
biblioteca incorreta ou metadata HACS divergente interrompe o processo. O
Home Assistant e parado, componente e metadata sao restaurados e a versao
anterior e iniciada novamente. O estado final fica `rollback` com a causa.


## Repetição incerta e evidência da etapa de promoção

Recibo `applying`, ilegível ou desconhecido bloqueia aplicação antes de fetch e
extração. Uma candidata diferente também não pode sobrescrever `runtime_applied`,
`applied_pending_git` ou `main_published`: reconcilie a operação anterior primeiro.
Um `failed` anterior não comprova rollback. Outra candidata pode avançar quando a
etapa e o efeito registrados demonstrarem `runtime_not_attempted`, ou após a
reconciliação explícita do estado atual descrita abaixo. A mesma candidata
terminal continua deduplicada, sem reinstalação.

Para um `failed` com efeito desconhecido, a reconciliação exige atestado Root
em `/var/lib/raspberry-kia-promotion-reconciliation/current.json`, diretório
0750 e arquivo 0640, com grupo do executor. O atestado vale no máximo 24 horas,
é vinculado ao checkout, hash exato do recibo antigo, commit da candidata
diferente, alvo, inventário SHA-256 da base restaurada, versão instalada e
commit do HACS. O recibo antigo deve ser preservado integralmente no subdiretório
Root `history`, nomeado por seu SHA-256, antes de emitir o atestado. Não existe
emissão automática nem renovação pelo promotor.

A revisão administrativa deve comparar todos os arquivos com o backup
preservado, verificar HACS e loader atual, auditar licença, proveniência e
deltas da candidata e conservar a evidência anterior. O promotor relê arquivos,
HACS e loader imediatamente antes de registrar a nova aplicação; qualquer
divergência bloqueia. Atestado ausente, vencido, alterado ou sem arquivo histórico
também bloqueia. Estados `applying`, publicação ou cleanup pendentes continuam
exigindo sua própria reconciliação. Adiamento por host ocupado, checkout alterado
ou erro anterior ao novo `applying` preserva o recibo antigo.

Essa prova descreve apenas a base atual e permite o caminho normal da nova
candidata, com seus testes, backup e rollback. O resultado e a causa históricos
permanecem desconhecidos; não são convertidos em sucesso nem em
`runtime_not_attempted`. A reconciliação não aciona serviços ou veículo. Os
testes usam arquivos, recibos e WebSocket sintéticos, sem acessar a residência.

O promotor publica `failure_stage` e `effect_state` em enumerações fechadas.
Falha em `runtime_apply` permanece `runtime_outcome_unknown`; publicação Git e
cleanup possuem suas próprias incertezas. `runtime_not_attempted` descreve apenas
a tentativa atual. Campo ausente em recibo antigo continua desconhecido; não
classificar retrospectivamente por mensagem, mtime ou código novo. Uma falha de
validação durante a retomada Git preserva `git_publication_failed`, para continuar
acionável pelo consumidor existente.

Na investigação de 26/10/2026, os frames do log foram correlacionados com o código
versionado e confirmaram timeout na primeira espera de prontidão, antes da espera
pelo polling natural. O Recorder registrou os seis papéis exigidos indisponíveis
nesse intervalo. Os 36 arquivos atuais coincidem com o backup anterior à aplicação.
Essas provas não identificam a causa interna da indisponibilidade, nem comprovam
recuperação funcional da candidata. A versão instalada continua 3.19.0 e a tentativa
anterior não foi repetida.

A guarda e sua projeção MCP foram aplicadas, revertidas e reaplicadas por tarefas
administrativas MCP seriais, com hashes e leitura real completos em cada fase.
Somente o sidecar de diagnóstico foi ativado; os sete serviços mantiveram seus
horários de início. Nenhuma fase executou promotor, updater ou chamada ao veículo.
Veja o [aceite sanitizado](../scripts/raspberry-mcp/kia-promotion-evidence.acceptance.json).
Uma nova reversão exige comparação dos hashes atuais e pacote delimitado próprio;
não reutilize fases ou IDs já consumidos, nem repita efeitos incertos.
