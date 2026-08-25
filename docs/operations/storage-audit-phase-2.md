# Auditoria de armazenamento — fase 2

Segunda fase executada em 2026-08-25 no Raspberry Pi, branch `main`, a partir
do SHA `4f55133cfbc4fe12a85bd85001cfed57a4574350`. O snapshot inicial foi coletado
às 14:12:43 UTC antes de alterações. O repositório estava alinhado com
`origin/main`, mas continha mudanças concorrentes de benchmark e frontend; elas
foram preservadas e excluídas desta tarefa.

Este documento não contém credenciais, IPs privados, conteúdo de backups,
variáveis de ambiente nem identificadores privados de entidades.

## Estado inicial e metodologia

| Métrica | Valor inicial |
| --- | ---: |
| Filesystem raiz, total | 62.477.467.648 B (58,18 GiB) |
| Filesystem raiz, usado | 34.792.087.552 B (32,41 GiB), 59% |
| Filesystem raiz, disponível | 25.114.099.712 B (23,39 GiB) |
| Inodes usados | 545.610 de 3.800.000 (14,36%) |
| Containers esperados ativos | 9 de 9 |
| Arquivos apagados ainda abertos, varredura acessível | 0 B; 163 processos sem permissão de inspeção |

Foram mantidas três medidas distintas:

- tamanho lógico: `du -sb` ou tamanho informado pela aplicação;
- espaço alocado: `du -B1`, blocos de `stat` ou diferença de alocação;
- ganho líquido: pares de `df -B1` no mesmo filesystem.

Tamanhos de conteúdo Docker, camadas compartilhadas e deltas de `df` não são
somados entre si. A janela global da aplicação começou com 34.805.538.816 B
usados e terminou, imediatamente após a última imagem Docker, com
27.233.161.216 B usados: ganho líquido de 7.572.377.600 B (7,05 GiB).

## Divergência de 4.096 bytes da fase 1

Na primeira fase, as janelas das categorias Docker somaram 4.314.742.784 B,
enquanto a janela global mediu 4.314.738.688 B. A diferença de 4.096 B é um
bloco ext4.

O código original coletava `df -B1` antes e depois de cada categoria e repetia
uma nova coleta antes da categoria seguinte. Uma alocação de runtime entre duas
janelas não entrou nos deltas das categorias, mas entrou no delta global. Não
houve mistura de `du`, tamanho lógico ou arredondamento de GB nessa diferença.
O arquivo individual que recebeu o bloco não é recuperável retrospectivamente,
mas a causa contábil é conclusiva.

O script passou a:

- registrar o delta líquido global separadamente;
- publicar as janelas por categoria em um objeto próprio;
- atribuir sempre 0 B a categorias somente de relatório;
- documentar que janelas independentes não formam um total exato.

## Cursor Server aposentado

Inventário anterior à remoção:

| Medida | Valor |
| --- | ---: |
| Tamanho lógico | 1.302.721.242 B (1,21 GiB) |
| Espaço alocado | 1.368.195.072 B (1,27 GiB) |
| Arquivos | 18.753 |
| Diretórios | 3.691 |
| Symlinks internos | 2 |
| Modificação mais recente | 2026-08-03 09:25:25 UTC |

O alvo resolveu exatamente para `/home/gabriel/.cursor-server`, pertencia ao
usuário operacional, estava no filesystem raiz, não era symlink nem mount
point. Não havia executável, diretório de trabalho, descritor aberto, processo,
serviço systemd, cron ou processo PM2 associado. A árvore ancestral da sessão
atual apontava para o VS Code Server, não para Cursor.

O diretório foi removido em profundidade com `find -P -xdev -depth -delete`,
sem seguir symlinks. Nenhum outro caminho contendo `cursor` foi alterado. O
filesystem liberou 1.368.190.976 B e 22.446 inodes durante a janela. O caminho
permanece ausente. Essa foi uma ação única e não existe exclusão recorrente de
`.cursor-server` no script.

## VS Code Server

O inventário inicial media 6.256.633.487 B lógicos e 6.376.259.584 B alocados.
Foram preservadas:

- `110a328ea54b42367b803ec53ee0bf52ef26b419`, usada pela sessão atual;
- `a5b500951314efd502d07465bd138dfbd714a960`, referenciada por outro processo
  e mantida também como rollback.

Quatro versões isoladas, sem processo, descritor aberto ou ancestralidade,
foram removidas:

| Commit de servidor | Lógico | Alocado |
| --- | ---: | ---: |
| `c2d1b13fdc4a77628e5f3bb70173351c8f2fbad1` | 677.314.882 B | 687.718.400 B |
| `df53daabb18cd157bdb08c7f01c34df936cf12f4` | 677.303.658 B | 687.714.304 B |
| `e4c7e7b1d6d060162f4aa7f8225271b67ce1df75` | 654.680.948 B | 665.071.616 B |
| `6a44c352bd24569c417e530095901b649960f9f8` | 483.220.904 B | 493.322.240 B |

Launchers e logs CLI correspondentes também foram removidos. A janela
`vscode-versions` liberou 2.588.340.224 B. Duas versões de extensão listadas
pelo próprio arquivo `.obsolete`, sem processo aberto, liberaram mais
354.775.040 B. Extensões ativas, configurações e dados compartilhados foram
preservados.

O cache `data/CachedExtensionVSIXs` continha 11 downloads, 455.985.788 B
lógicos. Somente esses pacotes de download foram excluídos; as extensões
instaladas permaneceram. A janela liberou 455.991.296 B.

O perfil padrão do script agora preserva todas as versões ativas e pelo menos
as duas versões mais recentes, remove somente diretórios `Stable-<commit>`
isolados e pacotes VSIX em cache. `--apply` é necessário, mas não existe prompt
ou autorização adicional: isso permite a execução periódica já instalada.

## Caches de usuário

| Caminho | Aplicação | Lógico inicial | Alocado inicial | Em uso | Ação |
| --- | --- | ---: | ---: | --- | --- |
| `~/.npm` | npm | 747.065.655 B | 859.832.320 B | não pelos serviços | `npm cache verify`, `npm cache clean --force`, nova verificação |
| `~/.cache/pip` | pip | 16.638.993 B | 18.382.848 B | não | `python3 -m pip cache purge` |
| `~/.cache/puppeteer` | Puppeteer | 1.272.231.178 B | 1.274.875.904 B | nenhum processo no snapshot | preservado |
| `~/.cache/chromium-headless` | ferramenta não confirmada | 40.007.296 B | 41.156.608 B | nenhum processo no snapshot | somente relatório |
| `~/.cache/typescript` | TypeScript | 15.199.563 B | 29.622.272 B | não comprovado | somente relatório |

O cache oficial npm ficou vazio e a janela liberou 397.529.088 B alocados. O
diretório `_npx`, 375.127.174 B lógicos, foi preservado porque não faz parte do
mecanismo `npm cache clean`. O pip removeu 160 arquivos e liberou 17.051.648 B.
Nenhum `node_modules`, ambiente virtual, `.npmrc` ou instalação global foi
alterado.

Puppeteer mantém revisões 131 e 148. A revisão 131 corresponde à dependência
`puppeteer-core` de uma extensão instalada; a origem da revisão 148 não foi
comprovada com segurança e ela pode apoiar ferramentas ativas/offline. Ambas
permanecem somente reportadas.

## Logs PM2

O PM2 mantém o daemon, mas não havia aplicação gerenciada ativa. Foram
preservados `dump.pm2`, backup do dump, PID, sockets e configuração.
`logrotate` e `pm2-logrotate` não estavam disponíveis, portanto não foi
introduzida dependência npm global.

O script implementa `copytruncate` seguro e allowlisted para `~/.pm2/pm2.log`
e `~/.pm2/logs/*.log`, com os seguintes padrões configuráveis:

- rotação ao atingir 10.485.760 B (10 MiB);
- compressão gzip;
- retenção de sete arquivos por log;
- preservação do arquivo ativo e das estruturas de restauração.

Os dois logs grandes, 121.993.411 B e 88.038.979 B, foram preservados em
arquivos comprimidos de 920.872 B e 4.347.243 B. A janela do filesystem liberou
204.738.560 B. Uma segunda execução não encontrou log acima do limite.

## Imagens Docker etiquetadas

Todas as imagens foram relacionadas a containers e ao Compose atual. Três
imagens tinham zero containers, nenhuma referência Compose, origem pública
reprodutível e não eram rollback de serviço crítico:

| Imagem | ID abreviado | Motivo | Ganho líquido |
| --- | --- | --- | ---: |
| Mermaid CLI 11.12.0 | `bad64c9d9ad9` | geração documental; disponível no registry | 1.978.150.912 B |
| bpftrace `latest` | `ceeff3fb27b6` | diagnóstico amd64, sem uso no host arm64 | 186.474.496 B |
| Watchtower 1.7.1 | `6dd50763bbd6` | legado, ausente do Compose | 21.549.056 B |

A remoção usou somente os IDs completos via Docker. Não houve prune amplo,
acesso manual a overlay/containerd ou remoção de volume.

Foram preservadas as imagens locais dos bridges como rollback, as bases
referenciadas pelos Dockerfiles, pequenas bases de diagnóstico e todas as nove
imagens de runtime. Depois da ação, Docker reportou 15 imagens, nove ativas,
11,8 GB lógicos e 2,928 GB recuperáveis ainda sujeitos a revisão.

## Recorder do Home Assistant

O banco foi aberto somente com URI SQLite `mode=ro`, timeout e WAL ativo. Não
houve `DELETE`, purge, `VACUUM`, mudança de schema ou de `purge_keep_days`.
Durante a auditoria ele media aproximadamente 1,20 GB, com 2.588.286 estados,
1.022.019 conjuntos de atributos, 221.556 eventos e `freelist_count=0`.

Nos sete dias analisados, o domínio `sensor` gerou 1.336.718 estados,
`binary_sensor` 148.950 e `notify` 60.288. O volume diário completo recente
ficou próximo de 220 mil estados e chegou a 259.487 em 2026-08-24.

| Entidade ou domínio sanitizado | Estados em 7 dias | Frequência aproximada | Impacto | Recomendação |
| --- | ---: | ---: | --- | --- |
| Diagnóstico de limites Codex 1 | 286.676 | 2,1 s | muito alto | elevar intervalo na fonte ou excluir do recorder após decisão funcional |
| Diagnóstico de limites Codex 2 | 286.210 | 2,1 s | muito alto | mesma ação |
| Previsão de esgotamento Codex | 262.437 | 2,3 s | muito alto | registrar somente mudanças úteis |
| Coordenador do veículo | 120.942 | 5,0 s | alto | reduzir frequência do sensor auxiliar |
| Diagnóstico Zigbee, sensor | 60.544 | 10,0 s | alto | manter alerta, reduzir persistência/frequência |
| Diagnóstico Zigbee, binário | 60.544 | 10,0 s | alto | registrar somente transições |
| Diagnóstico de internet, dois sensores | ~20.223 cada | 29,9 s | moderado | registrar somente transições |
| Saúde do Raspberry | 10.208 | 59,2 s | esperado | manter ou excluir métricas derivadas redundantes |

A configuração pública confirma `scan_interval: 2` no coletor Codex e sensores
derivados que atualizam junto. A recomendação é elevar o intervalo e/ou excluir
do recorder diagnósticos de contagem regressiva, mas essa mudança não foi
aplicada nesta fase.

## Backups do Home Assistant

Os sete arquivos continuam com 3.309.324.288 B lógicos e 3.309.359.104 B
alocados:

- três backups parciais comprimidos, de 2026-08-23 a 2026-08-25, com recorder
  incluído pela metadata;
- quatro snapshots de banco anteriores à migração, todos de 2026-08-17.

Não existe mount externo nem evidência de cópia restaurável fora do Raspberry.
Nada foi removido. A retenção sugerida, somente depois de cópia externa e
restore canário, é três backups operacionais recentes e um marco histórico. O
teste deve seguir o contrato de backup/restore do projeto, nunca usar o
checkout Git para dados privados.

## Automação, métricas e uso

O perfil padrão permanece dry-run. A execução real não faz perguntas e exige
somente `--apply`:

```bash
scripts/storage-maintenance.sh --dry-run
scripts/storage-maintenance.sh --apply
scripts/storage-maintenance.sh --dry-run --category all
```

O `--apply` padrão inclui agora caches npm/pip, versões obsoletas do VS Code,
cache VSIX e rotação PM2, além das categorias seguras da primeira fase. O
Node-RED agenda esse perfil a cada seis horas e cria uma solicitação coalescente;
o cron de um minuto apenas consome a solicitação no host com prioridade
reduzida. Imagens Docker etiquetadas, backups, recorder, arquivos apagados abertos, containers
parados, Git e volumes continuam somente reportados.

O JSON compatível com schema 1 foi estendido com tamanhos de VS Code, Cursor,
npm, caches allowlisted, PM2, imagens Docker, recorder, backups e arquivos
apagados abertos. Também registra `phase2_last_maintenance_at`, delta líquido e
deltas por categoria. O coletor do Home Assistant aceita somente campos e
categorias allowlisted; nenhum nome de backup, caminho privado ou conteúdo de
arquivo entra nas métricas.

## Resultado e pendências

As janelas individuais de ação observaram 7.572.791.296 B liberados. O delta
global contínuo foi 7.572.377.600 B; os 413.696 B de diferença são atividade
normal do filesystem entre as janelas. O delta global, e não a soma das
categorias, é o total operacional da fase.

Às 14:44:06 UTC o filesystem apresentava 27.234.074.624 B usados (25,36 GiB),
32.672.112.640 B disponíveis (30,42 GiB), 46% de uso e 467.566 inodes usados
(12,30%). Essa fotografia já inclui escrita normal posterior à limpeza.

Pendências:

- copiar backups para destino externo, validar integridade e executar restore
  canário antes de qualquer retenção;
- decidir funcionalmente a redução dos sensores ruidosos do recorder;
- revisar os 375 MB de `_npx` e os navegadores Puppeteer sem comprometer uso
  offline;
- manter as imagens de rollback locais enquanto sua reconstrução não estiver
  formalmente comprovada;
- a varredura de arquivos apagados abertos é parcial sem `lsof`/privilégios;
- executar a validação pública ampla quando o lock canônico estiver livre.
