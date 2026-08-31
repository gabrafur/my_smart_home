# Runbook de atualizacao segura Hyundai / Kia Connect

## Objetivo

Atualizar `custom_components/kia_uvo` sem permitir que o HACS sobrescreva o
delta local do vehicle_primary. A base upstream e registrada em
`scripts/kia-uvo-upstream.json`; as customizacoes permanecem nos commits deste
repositorio, sem manter uma copia manual de patch que possa ficar stale.

## Deteccao

O tab Node-RED `atualizacoes_diarias` agenda a analise a cada 30 minutos e ao
subir. Ele usa uma ponte coalescente sem Docker socket, token ou checkout no
container; o worker do host executa o watcher HA existente, que para a entidade
protegida executa somente:

```bash
node scripts/kia-uvo-safe-update.mjs check
```

O alvo vem do atributo `latest_version` da entidade oficial `update.*` do HACS,
consultada pelo worker com o token host-only. O check baixa base e alvo oficiais
em `/tmp`, calcula o delta local, tenta
aplica-lo no alvo e executa `compileall` e os marcadores obrigatorios. O
resultado fica em `/config/.storage/kia_uvo_safe_update` e e exibido por
`sensor.integracao_vehicle_primary`.

O mesmo ciclo preserva a política anterior para outras entidades HA consideradas
seguras. O instalador `scripts/install-daily-update-nodered-bridge.sh` remove o
antigo cron direto `docker-auto-update.mjs ha-updates`. Para Kia/Hyundai, o
Node-RED nunca chama `update.install`; `compatible` apenas informa que a
aplicacao explicita pode ser revisada.

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
