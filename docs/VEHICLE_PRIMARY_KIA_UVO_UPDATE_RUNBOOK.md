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

## Conflito e absorcao upstream

Os arquivos alterados localmente e conflitos aparecem no JSON de status. Se a
aplicacao do delta falhar, a versao instalada permanece intacta. Em cada
versao, compare os marcadores e o diff: funcionalidade incorporada oficialmente
deve ser removida do delta local e validada usando o upstream.

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
