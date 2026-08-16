# Runbook de atualizacao segura Hyundai / Kia Connect

## Objetivo

Atualizar `custom_components/kia_uvo` sem permitir que o HACS sobrescreva o
delta local do Creta. A base upstream e registrada em
`scripts/kia-uvo-upstream.json`; as customizacoes permanecem nos commits deste
repositorio, sem manter uma copia manual de patch que possa ficar stale.

## Deteccao

O job `scripts/docker-auto-update.mjs ha-updates` continua bloqueando a
instalacao automatica de entidades com `kia_uvo`, `hyundai`, `bluelink` ou
`uvo`. Quando uma delas fica `on`, ele registra
`CRETA_INTEGRATION_UPDATE_AVAILABLE` e executa somente:

```bash
node scripts/kia-uvo-safe-update.mjs check --target vX.Y.Z
```

O check baixa base e alvo oficiais em `/tmp`, calcula o delta local, tenta
aplica-lo no alvo e executa `compileall` e os marcadores obrigatorios. O
resultado fica em `/config/.storage/kia_uvo_safe_update` e e exibido por
`sensor.integracao_creta`.

Estados possiveis: `compatible`, `conflict`, `applying`, `applied` e
`rollback`. `conflict` nunca altera o componente em uso.

## Aplicacao explicita

Execute apenas depois de revisar o resultado `compatible`, o diff e os testes:

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

Depois, revise e versione separadamente a sincronizacao upstream e qualquer
adaptacao local. Nunca use force push.

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
