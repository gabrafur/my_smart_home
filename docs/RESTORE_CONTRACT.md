# Contrato determinístico de backup e restauração

[English](RESTORE_CONTRACT.en.md)

## Autoridade e limites

`restore/private-state-manifest.yaml` é a autoridade versionada sobre o estado
privado necessário para reconstruir a instalação. O arquivo usa o subconjunto
JSON compatível com YAML 1.2 para permitir parsing determinístico com Node.js
puro. Ele é validado por `restore/schema.json`.

O manifesto não contém valores privados. Para cada item ele registra nome
lógico, componente, módulo, origem/destino relativos ou externos, obrigação,
criticidade, owner, grupo, permissões, modo de consistência, serviços que
precisariam estar parados, dependências, ordem, comportamento de instalação
nova/restauração, checksum, validação e política Git.

O Git continua sendo a autoridade para código/configuração pública; o bundle
privado é externo, criptografado e nunca deve ficar no checkout. Os comandos
desta etapa não criam backup a partir do runtime nem iniciam containers.

## Estrutura do bundle

```text
bundle-externo/
├── bundle.json
├── manifest.yaml
├── checksums.json
└── components/
    └── <logical_name>/
        └── payload
```

`bundle.json`, validado por `restore/bundle.schema.json`, registra:

- versão do schema;
- commit e branch/release do repositório;
- criação UTC e arquitetura;
- versões de componentes e digests de imagens quando conhecidos;
- módulos habilitados e componentes incluídos;
- checksum do manifesto e referência a `checksums.json`;
- estado de verificação e método de criptografia externa.

Ele nunca registra chave de criptografia, senha, segredo ou token.
`checksums.json` usa SHA-256 por arquivo e preserva somente metadados necessários
à validação/aplicação. O diretório inteiro deve receber criptografia autenticada
antes de armazenamento ou transporte fora do host.

## Componentes e consistência

O manifesto separa o núcleo obrigatório de estado condicionado a módulos. O
núcleo inclui configuração privada, bindings, secrets/estado do Home Assistant,
credenciais do Node-RED e credenciais do Mosquitto. Banco do Recorder, contexto
Node-RED e persistência MQTT podem ser recriados, mas são preservados quando
necessários ao objetivo de recovery.

Zigbee exige que configuração, banco e backup do coordenador pertençam ao mesmo
snapshot parado. Matter e Portainer são diretórios indivisíveis. Volumes de
autenticação de agentes e identidade SSH são estado externo: aparecem no plano,
mas exigem procedimento separado e aprovação específica; a engine não os copia
silenciosamente.

`service_must_be_stopped` é requisito do plano, não autorização para parar um
serviço. A coordenação operacional ocorre fora destes comandos.

## Comandos sem escrita

```bash
make backup-plan
make backup-verify BACKUP_DIR=/caminho/externo
make restore-plan BACKUP_DIR=/caminho/externo
make restore-verify BACKUP_DIR=/caminho/externo
```

`backup-plan` não lê conteúdo privado nem copia dados. Ele mostra somente nomes
lógicos/mascarados, dependências, consistência, ordem e serviços envolvidos; o
tamanho fica como dependente da instalação porque o runtime não é inspecionado.

Os comandos `*-verify` validam schemas, checksum do manifesto, checksums de
payload, contagem de bytes, presença dos componentes obrigatórios, módulos,
estrutura e ausência de symlinks. `restore-plan` adiciona commit, arquitetura,
digests, espaço disponível, owner/grupo/permissões e conflitos de destino.

## Apply e rollback

`restore-apply` não faz parte do fluxo automático. Ele exige:

```bash
make restore-apply \
  BACKUP_DIR=/caminho/externo \
  DESTINATION=/destino/revisado \
  CONFIRM=RESTORE_PRIVATE_STATE
```

A engine sempre recusa `/`, o diretório home, a raiz do repositório e ancestrais
do repositório. Somente canários sob o diretório temporário são allowlisted.
Outro destino exige adicionalmente:

```text
ALLOW_NON_CANARY=I_UNDERSTAND_NON_CANARY_DESTINATION
```

Isso não substitui aprovação humana. Antes da primeira cópia, a engine verifica
bundle, compatibilidade e espaço. Cada conflito recebe snapshot em área de
rollback; no primeiro erro, itens já tocados voltam ao estado anterior. Logs e
saída contêm apenas metadados e nomes lógicos.

## Teste sintético

```bash
make restore-test
```

O teste cria bundle e destino exclusivamente em diretórios temporários. Ele
prova schema, ordem, checksums, permissões, restauração, rejeição de checksum
incorreto, componente obrigatório ausente, contrato de destino alterado,
destinos perigosos e rollback após falha injetada. Nenhum caminho residencial é
lido ou modificado.

## Recuperação do contexto da IA

Depois de infraestrutura e configuração validadas:

```bash
node scripts/ai-context-recovery.mjs --commit <commit-restaurado>
```

O checker confirma o commit, `AGENTS.md`, `MEMORY.md`, índice canônico e somente
as memórias temáticas selecionadas (por padrão, `restore`). Outros temas podem
ser passados por `--topics tema-1,tema-2`. Ele nunca lê `.agent-history/`, `.claude/`,
runtime privado de `.codex/` ou `.local-secrets/`. Conhecimento necessário que
exista somente ali deve ser reportado como `knowledge_not_versioned`.

O prompt coordenador é `prompts/restore-smart-home.prompt.md`. A sequência é:

```text
infraestrutura restaurada
→ configuração validada
→ commit identificado
→ arquivos de instruções e índices lidos pelo checker
→ arquivos de memória selecionados disponíveis no commit
→ recuperação e uso pelo agente ainda dependem da nova sessão
```

## CLI de agente

No ambiente em que este contrato foi validado, `codex`, `claude`, `openai` e
`chatgpt` não estavam instalados como comandos. Por isso o projeto não publica
uma flag não verificada. Use a interface oficial disponível e envie exatamente:

```text
Leia e execute integralmente prompts/restore-smart-home.prompt.md
```

Quando uma CLI for instalada, valide `--help` e `--version` no próprio ambiente
antes de documentar uma invocação de uma linha. Nunca passe secrets em argv.

## Limitações

- O backup externo real e a restauração estrutural isolada foram executados;
  serviços restaurados não foram iniciados e dispositivos não foram testados.
- A rotina diária está implantada e ativa para a próxima execução: a janela após o backup Git
  das 00:30 BRT foi aprovada com limite de 10 minutos, sem autorizar exclusão ou
  rotação de retenção. A recarga controlada e explicitamente autorizada do
  Node-RED ocorreu às 14:15 BRT em 32 segundos; nenhum outro serviço reiniciou e
  nenhum ciclo foi disparado na inicialização. A primeira execução diária ainda
  é futura. A decisão separada de retenção não
  é pré-requisito para implantar o modo sem exclusão.
- Volumes de autenticação dos agentes e identidade SSH continuam fora do bundle
  padrão e exigem procedimento separado.
- Compatibilidade marcada como diferente exige revisão; não há migração
  automática de banco, registry, fabric ou rede Zigbee.

## Evidência necessária para recuperação real

Um backup Git ou arquivo local do Home Assistant não comprova backup privado
fora do host. Verificar separadamente localização independente, data UTC da
cópia concluída, criptografia autenticada, disponibilidade da chave por canal
separado, cobertura de cada item do manifesto e recibo do último restore.
Metadados `protected`/senha configurada não provam decriptação bem-sucedida nem
integridade da cópia externa. Arquivo `.tar` do HA não é automaticamente bundle
`private-state-v1` e não cobre volumes dos demais containers.

Plano para ensaio real, sujeito a autorização antes de transferir dados:

1. Identificar backup externo e chave sem imprimi-los; mapear lacunas contra o
   manifesto, incluindo Recorder, credenciais/contexto Node-RED, MQTT, conjunto
   Zigbee, Matter e volumes externos. Não produzir snapshot inconsistente dos
   bancos em uso; qualquer parada exige janela aprovada.
2. Aprovar destino descartável fora da produção, com espaço e permissões
   restritas, sem rede residencial/Internet, USB, serial, Bluetooth, host network
   ou socket Docker da produção. Isolar antes de decriptar/copiar. Não ligar
   controladores restaurados a dispositivos reais.
3. Verificar decriptação e integridade no destino. Se o formato for nativo HA,
   validar por seu procedimento compatível e preparar, separadamente, a cobertura
   dos demais itens; não renomear o arquivo para fingir compatibilidade.
4. Para bundle compatível, executar `backup-verify`, `restore-plan` e
   `restore-verify`; revisar commit, digests, cobertura, espaço e conflitos.
   Executar `restore-apply` somente com autorização explícita para esse destino.
5. Validar bancos/registries e pares de credenciais offline. Inicialização de
   serviços, se necessária, somente no isolamento aprovado; não executar Compose
   residencial sem remover capacidades, rede e dispositivos físicos.
6. Registrar privadamente data, cobertura, checksums, resultado e limitações;
   publicar somente conclusão sanitizada. Definir descarte seguro das cópias de
   ensaio. Sucesso sintético e existência do arquivo nunca substituem esse recibo.

## Preparação de backup externo no OneDrive

O contrato público de preparação fica em
`restore/offsite-backup-policy.json`. Ele está com `active: true` e classifica
todos os 19 itens do manifesto em três superfícies. Os comandos `plan` e
`measure` não copiam conteúdo privado; somente o ciclo agendado realiza a captura
aprovada:

- Home Assistant: integração oficial **OneDrive** para `secrets.yaml`,
  `.storage` e Recorder. Ela pede `Files.ReadWrite.AppFolder`, `offline_access`
  e `openid`, grava somente na pasta de aplicativo e mantém criptografia de
  backup habilitada. A opção **Delete files permanently** deve continuar
  desligada; a proposta de retenção permanece inativa até aprovação específica.
- Demais serviços Compose: conjunto datado derivado dos nomes lógicos do
  `private-state-v1`, capturado por grupos consistentes. Cada grupo com
  `service_must_be_stopped` exige janela aprovada; a janela diária descrita
  abaixo fornece essa autorização, com teto de 10 minutos. Depois da captura e
  verificação, o conjunto é incluído em um
  backup nativo protegido do Home Assistant, remoto apenas, sem banco, usando o
  mesmo agente OneDrive e sem ampliar escopos.
- Volumes de autenticação dos agentes e identidade SSH: exportação e restore
  separados, com aprovação específica; não entram no bundle padrão.

Os comandos abaixo são somente leitura. `measure` percorre metadados de tamanho,
não imprime caminhos privados e marca componentes ausentes ou ilegíveis:

```bash
make offsite-backup-plan
make offsite-backup-measure
make offsite-backup-verify BACKUP_DIR=/caminho/do/bundle-compose
```

O verificador exige que o bundle contenha exatamente todo o subconjunto Compose
aprovado. O manifesto embarcado inclui também o fechamento de dependências que
será satisfeito pela superfície HA separada, e cada item conserva byte a byte o
contrato canônico; um manifesto parcial autocriado pelo backup não pode autorizar
a si próprio.

O transporte principal não instala `rclone`, não cria outro OAuth e permanece no
escopo `Files.ReadWrite.AppFolder` já concedido ao Home Assistant. A action
genérica `onedrive.upload` foi rejeitada porque não oferece download suportado
para o roundtrip. `rclone` permanece fallback não configurado e só pode ser
considerado com autorização separada; `sync`, exclusão automática e escopos
`Files.ReadWrite.All`/`Sites.Read.All` continuam proibidos.

`restic` sobre backend rclone permanece apenas alternativa se quota, tamanho ou
janela de upload tornarem bundles datados inviáveis. Ele reduz repetição entre
snapshots, mas acrescenta um repositório próprio: restore passa a exigir restic,
rclone, senha do repositório e configuração de acesso compatíveis. Não habilitar
essa dependência enquanto bundles simples forem pequenos e verificáveis.

O kit de emergência e a senha do backup do HA precisam permanecer fora do host
e do OneDrive protegido por eles. Perder a chave impede decriptar backups
compatíveis antigos. Nunca guardar esse material dentro do próprio bundle.

### Ponto exato de ação do responsável

Antes de qualquer transferência, confirmar cobertura, conta Microsoft pessoal,
pasta dedicada do bundle, quota e janela de parada. Em 13 de outubro de 2026,
às 12:12 BRT, uma consulta autenticada à API WebSocket do HA, sem exibir tokens,
chaves ou identificadores da conta, confirmou uma única integração pessoal
OneDrive carregada, sem reparo pendente, e seu agente de backup alcançável. O
destino não estava selecionado no agendamento e estava inicialmente como **não
protegido**. A API suportada alterou apenas `protected` para `true`; comparação
antes/depois confirmou que agenda, seleção automática e retenção não mudaram.

Às 12:15 BRT, uma cópia manual exclusiva para esse destino terminou e foi
relistada pelo próprio agente OneDrive com 549.232.640 bytes, `protected: true`,
configuração do Home Assistant e banco de dados incluídos. Os dois backups
locais anteriores permaneceram presentes.

Às 13:14 BRT, um segundo backup remoto protegido incorporou o bundle consistente
dos 13 componentes Compose. O agente registrou 426.147.840 bytes, sem banco de
dados e sem nova cópia local. O roundtrip baixou 426.137.600 bytes descriptografados,
validou 218 arquivos/3.199.322 bytes por checksum e restaurou os 13 componentes
somente em diretório temporário. O backup completo anterior também foi baixado:
549.222.400 bytes descriptografados, arquivo interno seguro, registros essenciais
válidos e `PRAGMA integrity_check = ok` no Recorder restaurado. Produção não foi
alterada e nenhum serviço restaurado foi iniciado; portanto o recibo prova
recuperação estrutural/de arquivos, não funcionamento residencial.

O banco persistente do MQTT ficou limitado a presença, checksum e captura
consistente com o broker parado, porque a imagem em execução não fornece
`mosquitto_db_dump`; ele não recebeu uma validação semântica independente.

Os dois backups locais e os dois remotos foram preservados; agenda, seleção
automática e retenção não mudaram. O próximo limite seguro é guardar o kit de
emergência fora do host/OneDrive. A árvore do Node-RED bloqueia updates até
receber recibo completo e está implantada com `active: true` para a próxima
execução agendada. Foi aprovada a mesma janela que começa após o
backup Git diário das 00:30 BRT, com interrupção esperada de aproximadamente 90 s,
limite de 10 minutos e prioridade absoluta para religar os serviços em caso de
falha. Nenhuma exclusão foi autorizada: cada ciclo acrescenta aproximadamente
426.147.840 bytes (cerca de 12,8 GB a cada 30 dias), e falta de quota deve falhar
fechada, preservar as cópias existentes e bloquear os updates seguintes. A
recarga controlada do Node-RED, concluída em 32 segundos às 14:15 BRT, ativou
a configuração sem reiniciar outro serviço nem disparar o ciclo; a
primeira execução diária ainda é futura. A definição futura de retenção não
bloqueia essa operação sem exclusão.

A revisão somente de metadados das 14:30 BRT encontrou 769.658.139.443 bytes
livres de 1.104.880.336.896 bytes, com dois backups protegidos ocupando
975.380.480 bytes. A proposta é manter no máximo 90 backups Compose diários ou
90 dias, o que ocorrer primeiro, limitada exclusivamente à série diária Compose.
Com 426.147.840 bytes medidos por ciclo, 90 cópias ocupam 38.353.305.600 bytes;
somadas a um backup completo de referência do Home Assistant, a estimativa é
38.902.538.240 bytes, cerca de 5,05% do espaço livre atual. A remoção só poderia
ocorrer depois de uma nova cópia totalmente verificada e sempre preservaria a
última cópia verificada. Isso é apenas uma proposta: exclusão continua
desabilitada até aprovação explícita separada.
