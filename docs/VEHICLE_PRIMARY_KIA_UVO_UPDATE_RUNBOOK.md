# Runbook de atualizacao segura Hyundai / Kia Connect

## Objetivo

Atualizar `custom_components/kia_uvo` sem permitir que o HACS sobrescreva o
delta local do vehicle_primary. A base upstream e registrada em
`scripts/kia-uvo-upstream.json`; as customizacoes permanecem nos commits deste
repositorio, sem manter uma copia manual de patch que possa ficar stale.

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
tem automação desligada por padrão e fontes desconhecidas falham fechadas. O
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
arquivos remanescentes e alterações extras são rejeitados. A comparação inclui
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

Uma falha real (`failed`) continua chegando ao observador global. O consumidor
deduplica por estado e versão candidata em contexto persistente, inclusive após
restart; uma transição de estado ou outra versão permite nova avaliação. O
horário permanece no resultado diagnóstico, fora da assinatura do erro.

O replay `flows:test-daily-host-updates` cobre adiamento repetido, falha real,
mudança de horário, recuperação, nova candidata e isolamento do dry-run.

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
