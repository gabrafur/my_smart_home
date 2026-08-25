# Auditoria de armazenamento do Raspberry Pi

Auditoria executada em 2026-08-25 no host `DietPi`, repositório
`/mnt/data/docker`, branch `main`, a partir do SHA
`602922b3680b2566a027f9a661f098e2737c2ddc`. O remoto foi registrado de forma
sanitizada como `origin` no GitHub. O checkout estava limpo no snapshot inicial.
Nenhuma credencial, variável de ambiente, IP privado, secret ou conteúdo de
backup foi incluído neste documento.

## Estado inicial e método

O primeiro snapshot em bytes, antes de qualquer limpeza desta auditoria, foi:

| Métrica | Bytes | Unidade legível |
| --- | ---: | ---: |
| Filesystem raiz, tamanho | 62.477.467.648 | 58,18 GiB |
| Filesystem raiz, usado | 39.091.097.600 | 36,41 GiB (66%) |
| Filesystem raiz, disponível ao usuário | 20.815.089.664 | 19,38 GiB |
| Inodes usados | 710.079 de 3.800.000 | 18,69% |
| `/tmp`, em tmpfs separado | 1.642.823.680 | 1,53 GiB |

Foram usados `df -hT`, `df -i`, `findmnt`, `lsblk`, `du -x`, `find -xdev`,
`docker system df -v`, `docker builder du`, inspeções Docker e consultas SQLite
somente leitura. `/proc`, `/sys`, `/dev` e `/run` não foram percorridos como
filesystems de dados. Como o usuário operacional não lê os diretórios privados
do daemon, dois containers efêmeros sem rede, sem capabilities, com filesystem
read-only e mounts `ro` mediram `/var/lib/docker` e `/var/lib/containerd`; eles
foram removidos automaticamente e nenhum serviço residencial foi reiniciado.

## Ranking e diagnóstico

| Caminho ou componente | Tamanho atual | Motivo provável do crescimento | Necessário em runtime? | Pode ser recriado? | Ação segura proposta | Espaço recuperável | Risco |
| --- | ---: | --- | --- | --- | --- | ---: | --- |
| Docker: imagens | 16.930.000.000 B (15,77 GiB), lógico | Atualizações preservaram imagem anterior do HA e imagens de ferramentas/builds | Parcialmente | Sim, por pull/build; rollback local seria perdido | Remover somente imagem sem tag, antiga, sem container ou outra referência | 2.948.000.000 B (2,75 GiB), estimativa exclusiva do daemon | baixo a médio |
| `/var/lib/containerd` | 18.751.598.592 B (17,46 GiB), medido | Store físico do snapshotter usado pelo Docker atual | Sim | Gerenciado pelo daemon | Nunca manipular diretamente; usar apenas comandos Docker | incluído nas ações Docker | crítico se manual |
| Docker: build cache | 1.866.000.000 B (1,74 GiB), 1.786.000.000 B recuperáveis | Builds repetidos das imagens locais | Não | Sim | `docker builder prune --max-used-space`, com teto configurável | até 866.000.000 B (825,88 MiB) ao usar teto de 1 GB | baixo |
| `/home/gabriel/.vscode-server` | 6.375.444.480 B (5,94 GiB) | Seis versões de servidor, extensões duplicadas e VSIX em cache | Só versões/sessões atuais | Sim | Revisão manual fora de sessão remota; não automatizar | vários GiB, não quantificados com segurança | médio |
| `homeassistant/` | 4.568.322.048 B (4,25 GiB) | Recorder e backups locais | Sim, exceto backups redundantes comprovados | Parcialmente | Preservar; revisar recorder e cópia externa | 0 B automaticamente | alto |
| Backups locais do Home Assistant | 3.309.324.288 B (3,08 GiB), 7 arquivos | 3 backups automáticos diários e 4 snapshots pré-migração | Não em runtime | Não sem cópia externa | Somente relatório até comprovar backup externo restaurável | 0 B autorizado | alto |
| `home-assistant_v2.db` | 1.191.411.712 B (1,11 GiB) + WAL | 2.577.067 estados em cerca de 28 dias; retenção de 30 dias e histórico/backfills recentes | Sim | Não | Purge oficial do HA; nenhuma exclusão/compactação direta | não estimado | crítico |
| `/home/gabriel/.cursor-server` | 1.368.195.072 B (1,27 GiB) | Duas versões do servidor e extensões | Só versão ativa | Sim | Revisão manual fora de sessão | não quantificado | médio |
| `/home/gabriel/.cache` | 1.364.627.456 B (1,27 GiB) | Dois Chromium/Puppeteer e caches Python | Parcialmente | Em geral | Limpeza por ferramenta e confirmação de uso | até ~1 GiB, não autorizado | médio |
| `/home/gabriel/.npm` | 859.803.648 B (819,97 MiB) | Cache de pacotes | Não | Sim | `npm cache verify/clean` manual fora do script do projeto | até 859.803.648 B | baixo a médio |
| `/tmp` (tmpfs) | 1.642.823.680 B (1,53 GiB) | Análise APK e fixtures de testes acumuladas | Não, salvo processos ativos | Sim | Automático apenas para prefixos de teste conhecidos, owner atual, idade e ausência de referência em `/proc` | libera RAM, não a raiz | baixo |
| Node-RED persistente | 149.106.688 B (142,20 MiB) | 91.348.992 B de cache npm e 53.989.376 B de módulos | Contexto/flows sim; cache não | Cache sim | Só logs npm e backups de flow allowlisted por retenção | pequeno no estado atual | baixo |
| Logs PM2 fora do repositório | 210.190.336 B (200,45 MiB) | Logs sem rotação; dois arquivos somam ~210 MB | Não | Não se histórico necessário | Configurar `pm2-logrotate` ou logrotate após revisar o bot | ~210 MB | médio |
| Docker: logs JSON | 6.255.054 B (5,97 MiB) | Saída normal dos containers | Não | Não | Manter rotação de 10 MB × 3 já aplicada | desprezível agora | baixo |
| Zigbee2MQTT logs | 2.768.896 B (2,64 MiB) | `log_level: info`, diretórios por execução | Não | Não | Monitorar; não remover coordinator/database | pequeno | baixo |
| `/var/log` | 98.304 B (96 KiB), tmpfs | Política DietPi volátil | Não | Não | Nenhuma ação | desprezível | baixo |
| `/.journal` | 268.435.456 B (256 MiB) | Arquivo root-only não classificável sem privilégio | Desconhecido | Desconhecido | Revisão administrativa; não remover | 0 B autorizado | alto |
| `.git` do checkout | 43.753.472 B (41,73 MiB) | 31,78 MiB de objetos soltos e 3,20 MiB em packs | Sim para Git | Clone novamente | Não executar GC: ganho pequeno e há 2.048 objetos não alcançáveis a revisar | < 43.753.472 B | médio |

Os valores Docker de `system df` são lógicos e podem compartilhar camadas. O
`du` do store containerd mede alocação aparente, mas snapshots montados podem
aparecer novamente em `/var/lib/docker/rootfs`; esses números não devem ser
somados. A diferença explica por que `du /var/lib/docker` sozinho não descreve
este host.

### Resultado da aplicação segura

Depois de validar sintaxe, testes, dry-run e referências Docker, a execução
`--apply --max-build-cache 1GB` removeu somente a imagem anterior sem tag do
Home Assistant e registros recuperáveis do build cache:

| Categoria | Antes | Depois | Recuperado no filesystem |
| --- | ---: | ---: | ---: |
| Imagem HA sem tag e sem referências | 16,93 GB lógicos em imagens | 13,99 GB lógicos | 2.948.206.592 B (2,75 GiB) |
| Build cache | 1,866 GB lógicos | 414,9 MB lógicos | 1.366.536.192 B (1,27 GiB) |
| Total da execução | 39.095.754.752 B usados | 34.781.016.064 B usados | 4.314.738.688 B (4,02 GiB) |

As duas janelas por categoria somaram 4.314.742.784 B, 4.096 B acima do
delta global. A revisão da implementação comprovou que não houve mistura com
`du` nem arredondamento de unidades: os três valores vieram de `df -B1`, mas
cada categoria coletou seu próprio par antes/depois. Uma alocação concorrente
de um bloco ext4 de 4.096 B ocorreu entre essas janelas e entrou no delta
global sem pertencer aos deltas individuais. Assim, 4.314.738.688 B é o delta
líquido da execução; os valores por categoria são observações independentes e
não devem ser somados como total exato. O script agora grava o delta líquido
separadamente e força categorias report-only a 0 B recuperados.

Uma segunda execução idêntica encontrou zero candidatos, removeu zero itens e
recuperou 0 B. A fotografia final, após o restart controlado do Home Assistant
e a atividade normal dos serviços, ficou em 34.782.593.024 B usados (32,39 GiB),
25.123.594.240 B disponíveis (23,39 GiB), 59% de uso e 545.521 de 3.800.000
inodes usados (14,36%). A variação de 1.576.960 B após a limpeza é escrita
normal de runtime, não regressão da manutenção.

O Home Assistant foi o único container reiniciado, depois de `check_config`
passar. Voltou `healthy`, o endpoint HTTP respondeu, e Node-RED e Zigbee2MQTT
também responderam dentro dos próprios containers. Os dois registros de erro do
Node-RED ocorreram exatamente durante a janela de indisponibilidade planejada
do Home Assistant; não apareceram novos erros depois que o HA ficou saudável.

### Home Assistant, Node-RED e Zigbee2MQTT

O Recorder já usa `purge_keep_days: 30`. O SQLite foi aberto com `mode=ro`:
`page_size=4096`, `page_count=290.934`, `freelist_count=0`, 2.577.067 linhas em
`states`, 220.180 em `events`, 50.681 em `statistics` e 390.964 em
`statistics_short_term`. Não há páginas livres que justifiquem repack, e um
repack concorrente seria inseguro. O banco cresceu materialmente em relação à
auditoria de 2026-08-13 e requer investigação funcional das entidades com alta
frequência antes de reduzir a retenção.

Os sete backups do HA vão de 2026-08-17 a 2026-08-25. Como nenhuma cópia externa
restaurável foi comprovada, todos foram preservados. Os snapshots pré-migração
são históricos; os três TAR recentes são operacionais. Só depois de validar um
bundle externo e um restore canário faz sentido manter, por exemplo, os últimos
3 operacionais e 1 marco histórico.

O contexto persistente do Node-RED mede 155.648 B alocados (17 arquivos e 77.629
B de conteúdo) e não apresenta crescimento relevante. Flows, credenciais,
contexto e `node_modules` nunca entram na limpeza host. O Zigbee2MQTT mantém
`configuration.yaml`, `database.db`, `state.json` e
`coordinator_backup.json`; nenhum desses arquivos é candidato. Seus logs são
pequenos e permanecem apenas monitorados.

## Política permanente

`scripts/storage-maintenance.sh` usa `set -Eeuo pipefail`, tratamento central de
erro, timestamps, `flock` sem criar arquivo em dry-run, allowlists, validação de
caminhos/symlinks, `find -xdev`, limites de RAM/disco, categorias e métricas
atômicas. O padrão continua sendo `--dry-run`.

Categorias automáticas de baixo risco:

- `report`;
- `logs`: somente logs rotacionados em diretórios explícitos e fora da retenção;
- `temporary-files`: somente prefixos conhecidos de fixtures, owner atual,
  antigos e sem `cwd`, `root` ou file descriptor ativo em `/proc`;
- `docker-images`: somente imagens sem tag, antigas e sem referências;
- `docker-build-cache`: teto configurável, sem tocar imagens/containers ativos;
- `project-artifacts`: somente logs npm e backups de flows em duas allowlists.
- `pm2-logs`: `copytruncate`, compressão e sete rotações para logs explícitos
  que atingirem 10 MiB;
- `npm-cache` e `python-cache`: somente mecanismos oficiais dos gerenciadores;
- `vscode-versions`: preserva todas as versões ativas e as duas mais recentes;
- `vscode-cache`: somente pacotes VSIX já baixados, nunca extensões instaladas.

Categorias report-only: `stopped-containers`, `git`, `developer-tools`,
`user-caches`, `docker-tagged-images`, `deleted-open-files`,
`home-assistant-recorder` e `home-assistant-backups`. `journald` e `apt-cache` só alteram algo quando a
categoria é escolhida com `--apply`, a opção adicional
`--allow-privileged-cleanup` está presente e o processo já é root; o script
nunca usa `sudo`. Volumes, overlay/containerd, bancos e dados persistentes não
têm código de remoção.

Exemplos:

```bash
scripts/storage-maintenance.sh --dry-run
scripts/storage-maintenance.sh --dry-run --category all
scripts/storage-maintenance.sh --apply
scripts/storage-maintenance.sh --apply --category docker-build-cache --max-build-cache 1GB
scripts/storage-maintenance.sh --apply --category project-artifacts --project-retention-days 30
```

Os limites podem ser passados por argumentos ou pelas variáveis
`STORAGE_MAINTENANCE_*` declaradas no início do script. O apply grava
atomicamente homeassistant/storage-maintenance-status.json, ignorado pelo Git,
com bytes totais/livres/usados, percentual, inodes, Docker lógico, logs
conhecidos, checkout, ferramentas de desenvolvimento, caches, PM2, recorder,
backups, arquivos apagados ainda abertos, última execução, resultado, delta
líquido e janelas por categoria. O coletor
do Home Assistant lê apenas esse schema allowlisted. O Compose já aplica
`json-file` com `max-size=10m` e `max-file=3` aos containers ativos.

## Checkout enxuto e conteúdo mantido no GitHub

O conteúdo versionado atual mede apenas cerca de 7,3 MB; `docs/` representa
1.789.448 B e `.git` 43.753.472 B. Além disso, `docs/`, `.codex/`, scripts e
ferramentas são usados pelo scheduler de revisão e pelo ai-bridge. Portanto, um
sparse agressivo no checkout ativo economizaria pouco e poderia quebrar
automação. A auditoria não o ativou no host em produção.

`bootstrap/configure-raspberry-checkout.sh` oferece um perfil cone conservador,
idempotente e dry-run por padrão. Ele exclui conteúdo exclusivamente de CI/demo
(`.github`, `demo`, `prompts`, `validation` e metadados de editor), mas preserva
todos os diretórios necessários à stack e à automação local. O script recusa
working tree suja e nunca remove dados ignorados, portanto bancos, backups e
secrets permanecem no disco.

Para um Raspberry novo, o ganho real no histórico vem de clone parcial:

```bash
git clone --filter=blob:none --no-checkout <remote> my_smart_home
cd my_smart_home
git sparse-checkout init --cone
bootstrap/configure-raspberry-checkout.sh --apply
git checkout main
```

Sparse checkout só tira arquivos rastreados do working tree. Ativá-lo em clone
completo não remove blobs já presentes em `.git`. Um arquivo criado no Raspberry
precisa existir localmente pelo menos até ser adicionado e enviado; a alternativa
é criá-lo em outra máquina ou no GitHub Actions. Após push, apagá-lo do working
tree não purga o histórico. Git LFS não é vantajoso para os arquivos atuais (o
maior blob é inferior a 1 MB); Releases/Actions são preferíveis se artefatos
grandes surgirem. Substituir o clone ativo exigiria validar clone parcial,
permissões, arquivos ignorados, binds, rollback e espaço temporário; não foi
justificado por um `.git` de apenas 41,73 MiB.

Commit e push funcionam normalmente em sparse checkout para os caminhos
materializados. Alterar arquivo fora do perfil exige incluí-lo temporariamente
com `git sparse-checkout add`. `git pull` atualiza todo o índice, mas materializa
somente o perfil.

## Restauração e limitações

Antes de qualquer retenção agressiva, execute `make backup-plan`, produza o
bundle privado fora deste checkout, rode `make backup-verify BACKUP_DIR=...` e
faça um restore canário conforme `docs/INSTALACAO_RESTAURACAO_SMART_HOME.md`.
Não envie bancos, backups, `.env`, `.storage`, secrets, flows de credenciais ou
dados pessoais ao GitHub.

Pendências manuais:

- comprovar backup externo e restore antes de reduzir os 3,08 GiB locais;
- aplicar a recomendação de frequência do recorder somente após decisão
  funcional baseada na segunda fase;
- revisar o `_npx` preservado e os navegadores Puppeteer antes de qualquer
  limpeza adicional;
- classificar `/.journal` e medir journald com privilégio administrativo;
- revisar as imagens tagged sem containers (ferramentas e rollback) antes de
  qualquer remoção;
- não executar `git gc` enquanto o ganho continuar desprezível e sem margem
  adicional para repack.

Os resultados e evidências posteriores estão em
[`storage-audit-phase-2.md`](storage-audit-phase-2.md).
