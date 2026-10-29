# Observação nativa de metadados MQTT

Esta é uma implementação candidata, desligada por padrão. Publicar as fontes
não instala o leitor, não carrega o plugin e não amplia permissões do MCP.
A instalação ainda exige pacote selado com aplicação, consulta, revogação e
reversão, além de aprovação específica do proprietário. A renovação de uma
autorização administrativa existente não concede esse novo acesso permanente.

## Escopo e arquitetura

O plugin acompanha sete classes: `publish_in`, `publish_out`, `connect`,
`disconnect`, `subscribe`, `unsubscribe` e `client_offline`. Os callbacks não
desreferenciam `event_data`: não coletam tópico, payload, identidade de cliente,
credenciais ou conteúdo doméstico. Um contador não cobre automaticamente todos
os eventos do Home Assistant, nem comprova entrega de notificação ou execução
do assistente.

```mermaid
flowchart LR
  B[Plugin no broker] -->|datagrama não bloqueante| S[Socket mantido pelo gerenciador]
  S --> R[Leitor Root: verificar e persistir]
  R -->|relatório sanitizado| N[Política visual no Node-RED]
  N --> C[Persistir estado do consumidor]
  C -->|ACK após fsync| R
```

O produtor usa `CLOCK_BOOTTIME`, sequência, contagens cumulativas e buffer
limitado. Perdas, falhas de envio e relógios desconhecidos permanecem explícitos.
O leitor verifica credenciais fornecidas pelo kernel, contêiner exato, processo,
executável, identidade do arquivo de plugin mapeado e domínio temporal.
Isso verifica arquivos e vínculos de processo; não atesta todas as instruções
executadas na memória do broker.

O leitor de produção exige `SO_PASSPIDFD` e um único `SCM_PIDFD` fornecido pelo
kernel junto das credenciais. Exige Linux de 64 bits com `pidfs`; um kernel
incompatível impede a partida, sem reduzir a verificação a um PID numérico.
Enquanto o remetente está vivo, cada mensagem repete a verificação de processo,
arquivos e relógio e compara o identificador do pidfd recebido com o do processo
aberto. O leitor conserva apenas um pidfd da última origem verificada.

Após a saída do remetente, uma mensagem já enfileirada pode usar esse vínculo
somente se o pidfd identificar a mesma tarefa previamente verificada, com as
mesmas credenciais e domínio temporal. Uma origem encerrada antes da primeira
verificação, outra tarefa, ausência do descritor ou troca do leitor deixam o
vínculo desconhecido. O cache é somente em memória e não reconstitui alterações
de código posteriores à última verificação. Uma falha de identidade descarta o
vínculo guardado; somente uma nova verificação com a origem viva pode recriá-lo.
Descritores recebidos são fechados também nas mensagens inválidas ou truncadas.
Essa identificação permite verificar uma mensagem terminal que permaneceu na
fila depois da saída do processo; a identidade sozinha não prova encerramento.

Referências primárias: [UAPI de sockets do Linux](https://github.com/torvalds/linux/blob/v6.18/include/uapi/asm-generic/socket.h),
[identidade de tarefas no pidfs](https://github.com/torvalds/linux/blob/v6.18/fs/pidfs.c)
e [entrega de SCM_PIDFD](https://github.com/torvalds/linux/blob/v6.18/net/core/scm.c).

O gerenciador conserva o socket enquanto o processo leitor é substituído.
O novo processo abre o mesmo SQLite, preserva a fila e acrescenta a falha
`reader_restart`; reiniciar não apaga incerteza histórica. A fila é finita:
esse mecanismo não promete ausência de perdas em uma parada arbitrariamente longa.

O booleano `final`, introduzido no protocolo de origem `v: 2`, permanece em
`v: 3`. O plugin só tenta
enviá-lo como verdadeiro depois de fechar a coleta, desregistrar todos os
callbacks, adquirir o lock sem esperar e confirmar que nenhum callback anterior
continua em andamento. Um contador atômico de entradas e a ordem do gate evitam
que um callback pausado antes do lock pareça ausente. Uma entrada posterior ao
fechamento não coleta eventos. Falha no desregistro, disputa, revogação, relógio
ausente ou datagrama perdido deixam o encerramento sem comprovação; o broker
nunca espera pelo leitor ou pelo ACK.

O protocolo `v: 3` acrescenta `covered_before_ns`. Esse marco afirma que os
callbacks com horário anterior ao seu valor já estão contabilizados. O horário
de envio sozinho não faz essa afirmação: outro callback pode ter obtido seu
horário e ainda estar pausado antes de registrar o evento. O produtor drena os
descartes pendentes após ler o relógio e confere o contador de entradas antes
dos acumuladores atômicos. Concorrência não resolvida emite um marco ausente,
sem esperar. No encerramento, o marco é lido antes de fechar a coleta, sem
estender a cobertura até o horário posterior de envio.

O estado contábil `version: 4` aceita os registros anteriores de versões 2 e 3 e
preserva contadores, falhas e caudas desconhecidas. `source_closed` registra
somente o fechamento aceito daquela origem. A próxima origem não acrescenta
uma cauda desconhecida quando a anterior foi comprovadamente encerrada; as
incertezas mais antigas permanecem. Uma duplicata exata do terminal é idempotente;
outra mensagem da mesma origem após o terminal é recusada. O leitor ainda aceita
os protocolos de origem `v: 1` e `v: 2`, sem inventar seus marcos de cobertura,
e recusa downgrade de versão dentro da mesma origem. O último marco conhecido
permanece válido quando outro quadro da mesma origem não traz avanço; ele
nunca atravessa a troca de origem. O fechamento cobre os callbacks da coleta, sem
estender a cobertura a todo o broker, ao Home Assistant ou ao assistente.

O fechamento não comprova ausência de perdas nem uma janela de 24 horas. Essas
decisões continuam dependendo dos contadores, domínios temporais, recibos
duráveis do consumidor e da política canônica no Node-RED.

O status do leitor de versão 2 publica a origem atual, seu marco de cobertura
e a existência da tarefa verificada pelo kernel. Depois de reiniciar o leitor,
os dados carregados do SQLite não são apresentados como origem atual até uma
nova entrada verificada. A versão anterior do status continua sendo aceita
com horizonte ausente. Os recibos do consumidor incluem o horário BOOTTIME do
ACK e seu domínio; a idade e os limiares continuam sendo decisões do canvas.

No [upstream fixado](https://github.com/eclipse-mosquitto/mosquitto/blob/99fa50f30e325609394c324c8ff71cfbbe95d8ab/src/mosquitto.c),
`post_shutdown_cleanup` limpa clientes e banco antes de descarregar os plugins.
Isso não estende a prova a reload em execução, outro binário ou processos que
possam ter existido entre duas origens. Uma troca sem recibo de manutenção
correlacionado continua sem comprovação de cobertura contínua.

O tab `observacao_mqtt_nativa` contém configuração, normalização, autorização,
idade do leitor, decisões de integridade e latência, dedupe e gate final.
O padrão é `enabled: false`, com limite de evento de 10.000 ms. O intervalo de
leitura é de 2 s. As comparações operacionais ficam nos switches do canvas;
Python e o CLI validam fatos, arquivos e protocolo. Nenhum dashboard recalcula
essa política.

## Contratos e caminhos fixos

| Componente | Caminho ou contrato |
| --- | --- |
| Código Root selado | `/opt/raspberry-mqtt-observation/` |
| Estado Root privado | `/var/lib/raspberry-mqtt-observation/`, `0:0`, modo `0700` |
| Socket | `/run/raspberry-mqtt-observation/source.sock`, `0:1883`, modo `0620` |
| Plugin carregado no broker | `/mosquitto/metadata/observer.so`, arquivo Root somente leitura |
| Relatório para o Node-RED | `/mnt/data/docker/nodered/.mqtt-source-observer-report/`, `0:1000`, modo `0750` |
| Estado e ACK do consumidor | `/mnt/data/docker/nodered/.mqtt-source-observer-consumer/`, `1000:1000`, modo `0700` |
| Adaptador do consumidor | `/data/tools/mqtt-source-observation/consumer-command.sh` |

Os IDs acima são papéis de execução do pacote candidato atual. Outro ambiente
precisa de nova revisão das identidades, imagem, binário e montagem; não basta
trocar um ID no MCP.

O relatório contém números inteiros como strings decimais para evitar perda de
precisão no JavaScript. Esquemas fechados recusam campos extras e formatos
ambíguos. O consumidor prepara uma proposta sem escrever ACK; o canvas observa
os fatos e solicita o commit exato. O CLI usa `flock` e comparação do estado-base,
persiste e sincroniza o estado antes de publicar o ACK. O leitor mede o limite
superior até observar esse ACK durável. O resultado não mede processamento da Eva.

O adaptador também aceita um checkpoint fechado produzido pelo canvas para a
janela de observação. Ele é gravado no mesmo `state.json` dos contadores,
com sincronização do arquivo e do diretório antes do ACK. A preparação devolve
o último checkpoint durável; ela não o reconstrói a partir do tempo decorrido.
O checkpoint se vincula à proposta exata, ao recibo e aos totais confirmados,
com sequência e hash do registro anterior. Contadores, violações, máximas e o
limite de encerramento de uma mesma janela não podem retroceder. Iniciar outra
janela preserva integralmente a anterior no histórico limitado a oito registros;
capacidade esgotada recusa o novo registro, sem descarte silencioso.

O estado do consumidor passa à versão 2 somente quando recebe esse checkpoint.
Uma confirmação legada de proposta em hexadecimal continua disponível no estado
de versão 1; ela é recusada depois da migração para evitar apagar o checkpoint.
O novo argumento `c1_…` contém JSON canônico em base64url, com alfabeto seguro
para o comando fixo e tamanho limitado. Não aceita caminhos, comandos, campos
extras ou texto livre. A instalação precisa incluir `canvas_checkpoint.mjs`
junto dos demais módulos do consumidor. Uma reversão que use código antigo
deve preservar o estado migrado; não o converta nem o substitua silenciosamente.

O grupo 7 do canvas decide a janela das sete classes nativas MQTT. O contrato
visível exige 86.400 segundos e latência de no máximo 10.000 ms; configurar um
limite local maior não satisfaz esse aceite. O início usa o horário de um ACK
verificado, no mesmo domínio e na origem atual. Os contadores completos nesse
instante formam a baseline: falhas anteriores permanecem no histórico, enquanto
os gates avaliam novos deltas, ordem dos recibos, relógio e latências.

Quando `covered_before_ns` alcança o início mais 24 horas, o canvas fixa o corte
`{accepted_frames: N, covered_before_ns: T}`. A janela fica em `draining` até os
contadores confirmados cobrirem os N quadros. O corte não avança enquanto se
espera; tempo decorrido ou `emitted_boottime_ns` sozinho não encerra a janela.
Cortes legados baseados somente em envio continuam legíveis, mas ficam sem
aceite de cobertura. Troca de origem sem manutenção correlacionada fica
`unknown`, mesmo quando a cauda anterior terminou sem perdas.

A projeção durável só recebe o resultado após o CLI confirmar o hash exato do
checkpoint da leitura ainda em andamento. Uma resposta atrasada ou outro hash
não publica uma janela aprovada. Resultados terminados ficam preservados;
`callback_window` representa aquela janela e seu escopo, enquanto a classificação
do recibo atual continua separada.

O grupo 9 recebe a intenção explícita de iniciar outra janela, sem apagar
contadores, falhas ou recibos do protocolo. Ele espera uma nova fronteira ACK
verificada da origem atual, arquiva integralmente o registro anterior e só
consome a intenção após a confirmação do checkpoint exato. Uma retomada após
fsync, antes de limpar a intenção local, não cria outra janela com o mesmo ID.
Com oito registros anteriores, a intenção fica em `capacity`, preservando
todos os dados. Sem fronteira válida, fica em `waiting` e pode ser atendida por
uma leitura posterior. O padrão desligado continua valendo para essa leitura.

O envelope de checkpoint de versão 2 acrescenta `reader_observation` e
`window_request`. Os registros de versão 1 continuam legíveis; uma confirmação
nova não pode rebaixar um envelope já migrado. A observação atual inclui o
relógio e a origem verificados pelo leitor, além de um identificador aleatório
do processo consumidor mantido somente em memória. Ela pode avançar sem
modificar o resultado congelado de uma janela. Quando a fonte não pôde ser
verificada, a observação é explicitamente `null`; não reutiliza o horário antigo
como sinal de funcionamento atual.

Um novo identificador ou uma sequência maior, isoladamente, não comprova
retomada. A coordenação de manutenção precisa correlacionar a parada e o início
reais do consumidor, a observação Root posterior ao início, o checkpoint durável
e o broker comprovadamente parado. Os recibos de manutenção, sua integração
com backup e atualização e a ativação desse pacote ainda precisam de aceite.
O adaptador mantém `full24h_proven: false`, inclusive quando armazena a decisão
do canvas. Uma janela do componente não comprova latência de todos os eventos
residenciais, execução da Eva, disponibilidade do provedor ou autonomia do PC.

Os modos fixos `checkpoint-prepare` e `checkpoint-commit` acessam somente o
estado do próprio consumidor. Eles permitem guardar uma decisão de incerteza
após revogação ou indisponibilidade, sem ler o relatório do produtor e sem
criar, repetir ou atualizar ACK. Suas propostas têm domínio e comparação de
estado-base separados da confirmação do produtor. Não criam histórico ausente.
Essa gravação de metadados não concede acesso novo à origem nem permissão para
um efeito residencial.

Se a preparação da fonte falhar, o CLI pode devolver uma proposta separada
do histórico do próprio consumidor, quando esse histórico ainda for válido.
Esse fallback não lê a fonte, não cria histórico ausente e não confirma dados
novos do produtor. Ele permite ao canvas persistir a incerteza em sua rota
de efeito final apropriada. Essa rota também passa pelo gate de `test_mode`;
em teste, o comando `checkpoint-commit` não é executado.

Para o replay manual, use `0 reset` antes de cada sequência. No grupo 8, execute
`start` → `pending` → `drain`: o segundo passo deve continuar aguardando, e o
terceiro conclui somente a janela sintética. Para cada falha, repita reset →
start → `source_unknown`, `epoch`, `clock`, `policy`, `gap`, `over`, `fault`
`legacy`, `missing`, `timing_unknown`, `reader_denied` ou `reader_stale`.
Os mesmos gates e a mesma codificação chegam ao terminal dry-run
compartilhado, com `simulated: true` e `dispatched: false`. Os fatos sintéticos
avançam 24 horas; o contrato de duração permanece intacto. O replay não constitui
uma observação real de 24 horas. A serialização usa somente o módulo nativo
`crypto` do Node.js, sem instalação npm ou chamada de rede.

Depois de reset → start → pending → drain, use `restart` para conferir o
arquivamento da janela concluída. Use `restart_wait` para deixar a intenção
pendente e depois `drain` para fornecer a próxima fronteira ACK. Use `capacity`
para simular o histórico completo e confirmar sua preservação. Esses controles
usam a mesma entrada de intenção do grupo 9 em namespace de teste.

`no_events`, `no_new_receipt`, `busy`, `disabled` e `unknown` são resultados
distintos. Silêncio não significa recuperação. A idade usa correlação explícita
entre o domínio de boot do leitor e `CLOCK_MONOTONIC` do Node.js; domínio
diferente, relógio futuro ou idade ausente continuam desconhecidos.

## Proveniência e build

O SDK está fixado no Mosquitto 2.1.2, commit
`99fa50f30e325609394c324c8ff71cfbbe95d8ab`, objeto de tag
`691eab38b43c16235251bf4a4c83b2b29195ba76`.
O [manifesto de origem](../scripts/raspberry-mcp/runtime-source/mqtt-observation/native/sdk-manifest.json)
registra os sete arquivos oficiais, tamanho, SHA-256 e objeto Git de cada um.
Headers não são reescritos nem embutidos no repositório; o preparador verifica
seus bytes antes de disponibilizar o contexto de compilação.
As licenças e notices do SDK são preservados, com a escolha
`EPL-2.0 OR BSD-3-Clause`; o código original do observador usa a licença do projeto.

Execute a preparação sem `sudo`, usando um diretório novo:

```sh
python3 scripts/raspberry-mcp/runtime-source/mqtt-observation/native/prepare_build.py \
  /tmp/mqtt-observer-build
```

Isso baixa somente os sete arquivos fixados e copia as fontes e licenças para
esse contexto. Não compila, instala, acessa o Docker ou reinicia serviços.
O Dockerfile exporta `observer.so`, o harness de falhas e as licenças. Sua base
ARM64 está fixada na imagem efetivamente usada nos testes isolados. O compilador
e os pacotes de build ainda precisam de registro de versão no recibo de build;
o processo não afirma que builds futuros serão byte a byte reproduzíveis.

Antes de instalar, execute o harness em contêiner próprio, sem rede, sem
montagens residenciais e com limites de processo. Revalide ABI, binário do broker,
licenças, SHA do plugin e comportamento do broker com o artefato que será instalado.
Uma compilação em outra arquitetura exige nova validação nativa.

## Instalação e atualização

O pacote selado deve tornar revisáveis estes passos antes da aprovação:

1. Conferir imagem e contêiner atuais, binário, plugin, owners, modos, montagens,
   baseline da configuração e arquivos existentes, usando comparação de hashes.
2. Instalar código Root imutável, diretórios e units revisadas. O serviço normal
   recusa um SQLite ausente; o bootstrap aprovado é uma ação separada e exclusiva.
3. Criar uma autorização fechada `mqtt_metadata_seven_classes_v1`, com aprovação
   correspondente ao vínculo de origem, validade explícita ou `null` aprovado.
   A política e o vínculo não vêm de parâmetros livres de ferramentas MCP.
4. Preparar a montagem IPC e a configuração do plugin, preservando dados,
   autenticação e ACLs existentes. O Mosquitto carrega plugins ao iniciar;
   `SIGHUP` não instala este plugin. A alteração da montagem exige recriação
   somente do broker, com backup e reversão já preparados.
5. Validar o socket e o leitor antes do broker, depois observar tráfego natural,
   consumidores, persistência e ACKs. Habilitar a política do canvas somente
   dentro da aprovação correspondente.
6. Expor ao MCP somente a projeção sanitizada aprovada e comprovar uma chamada
   real. As fontes atuais, o catálogo ou um contêiner saudável não cumprem esse passo.

As units candidatas usam `LimitAS=134217728`, `CPUQuota=10%`, prioridade reduzida,
`NoNewPrivileges` e somente `CHOWN`, `DAC_READ_SEARCH`, `SYS_PTRACE` no conjunto
de capacidades. A verificação isolada de capacidades não comprova todo o perfil
de isolamento do systemd. O limite Docker `--memory` também não comprova limite
efetivo quando o host não dispõe do controlador de memória. O heap máximo do
Node.js não é um limite rígido de RSS.

Recriar o contêiner muda seu vínculo. Atualizações detectáveis devem passar pelo
tab `atualizacoes_diarias`: auditar o candidato, preservar a configuração,
revalidar ABI e arquivo mapeado, aplicar o vínculo exato por comparação e observar
um ciclo nativo. O leitor não aceita outro contêiner por semelhança de nome nem
reconfigura automaticamente esse vínculo. A integração dessa etapa no atualizador
e o instalador selado ainda são pendências da ativação.

O componente `deployment_files.py` prepara a transação dos arquivos estáticos
do pacote. Seu catálogo fechado contém 49 destinos: 30 módulos Root, nove
módulos do consumidor e dez arquivos de units, configuração, plugin e licenças.
Não inclui credenciais, autorização, vínculo de origem
ou dados de aplicações. Ele registra a intenção durável antes de cada escrita,
confere os hashes anteriores e posteriores e recusa repetir uma aplicação
interrompida. Um recibo antigo é apresentado separadamente da conferência dos
arquivos atuais. A reversão preserva edições concorrentes e mantém os backups.
O handle de observação não cria lock ausente nem aceita mutações.

Esse componente não executa Docker ou systemd e não é um instalador completo.
A orquestração aprovada precisa fechar a coleta, parar o leitor novo e restaurar
o broker antes de reverter os arquivos estáticos. Montagens somente leitura,
recriação do broker, novo vínculo antes da partida, ativação do canvas e
projeção MCP ainda exigem integração e validação próprias no pacote.

### Recibos de manutenção

`maintenance_journal.py` mantém fatos tipados em um snapshot Root com modo
`0600`, protegido pelo mesmo lock de transação, escrita atômica e fsync.
Cada operação vincula aprovação, ID, domínio BOOTTIME, sequência e hash do
registro anterior. O conjunto ativo mantém até 16 operações. Ao precisar de
espaço, `maintenance_archive.py` preserva uma operação encerrada como
`complete`, `cancelled` ou `rescued` em arquivo Root imutável, confirma seus
bytes e publica o índice antes de retirá-la do conjunto ativo. Operações
incertas ou `failed` não são arquivadas para liberar outra manutenção.
O arquivo ativo v2 ancora o hash e o tamanho do prefixo do índice; ausência ou
regressão do índice bloqueia novos IDs. Um índice publicado antes de uma
interrupção só pode ser reconciliado com uma cópia ativa exatamente igual.

Os IDs e cadeias completas continuam consultáveis depois do reinício e de
rotação de aprovação. Um ID arquivado não pode iniciar outra operação. O limite
de 4.096 operações arquivadas bloqueia novas admissões quando atingido, sem
excluir histórico nem redefinir contadores. Cada arquivo arquivado tem limite
de 64 KiB. Uma repetição exata ativa devolve o mesmo recibo, sem repetir efeito.
Divergência, sequência fora de ordem ou continuação de operação terminada são
recusadas. Danos no arquivo histórico não devem impedir o registro de fatos de
uma operação ativa necessária para restaurar a disponibilidade da casa.

`Journal.history_files()` fornece o snapshot ativo, o índice, cada cadeia
arquivada e os recibos existentes de plano, recuperação, vínculo e política
ligados aos respectivos IDs. A leitura é incremental, sob o mesmo lock, sem
recarregar todo o histórico a cada arquivo. O consumidor precisa esgotar o
gerador e conferir seu sucesso antes de publicar o backup: uma lista parcial
não é snapshot verificado. Autorizações, políticas atuais, pedidos preparados,
locks e fontes livres ficam fora dessa saída. Recibos históricos podem conter
bytes de políticas antigas como evidência; esses bytes nunca são autorização
para restaurar uma política ou reabrir coleta. O transporte protegido e a
restauração em namespace histórico estão descritos abaixo; sua instalação
e autorização operacional continuam separadas da publicação do código.

O registro inclui a janela armada, intents anteriores aos efeitos, parada e
fechamento da origem, corte confirmado por ACK, parada e início do consumidor,
observação Root posterior ao início e a nova origem com seu vínculo e época.
O arquivo conserva intents após uma falha de retorno. Resultado incerto exige
reconciliação; uma autorização nova não permite continuar uma operação antiga.

`correlation_facts` expõe comparações de vínculos, épocas, relógios, contadores,
ACKs e observações do consumidor. Esses fatos não são um aceite de continuidade:
JSON e hashes, isoladamente, não atestam uma parada real nem autenticam a fonte.
O executor aprovado deve observar os processos e arquivos reais e registrar o
intent antes de enviar cada efeito. O Node-RED continua responsável pelos gates
operacionais. Esse módulo não contém CLI, Docker, controle de serviços, agenda
ou retries.

O controlador candidato `maintenance_controller.py` aceita somente quatro
comandos fixos: parar origem, parar consumidor, iniciar consumidor e iniciar
origem. Cada efeito exige intent durável, vínculo selado e releitura da
identidade/estado na fronteira final. Repetir uma solicitação com intent já
existente permite somente observar o resultado; trocar o ID não contorna uma
operação anterior inconclusiva. O controlador não oferece CLI ou agenda.

`maintenance_backend.py` verifica hashes do código Root e do consumidor,
aprovação e validade, processo vivo do leitor com PID/start ticks e identidades
dos dois contêineres. A inspeção seleciona campos de lifecycle antes de receber
os bytes; não solicita ambiente ou logs de healthcheck. O consumidor parado é
validado pelo codec offline fixo, sem iniciá-lo para obter um checkpoint.
O arquivo privado `maintenance-status.json` mantém fatos do leitor separados
do contrato público de observação. Inclui o identificador e os hashes do último
ACK. Como a persistência do consumidor e o ACK Root avançam separadamente,
o corte final aceita o mesmo recibo ou o prefixo durável comprovado pelo pacote
pendente exato já confirmado pelo Root. Nesse segundo caso, o hash do pacote,
o recibo anterior e o delta integral dos contadores precisam coincidir. Contadores
numericamente menores, sem essa prova, não bastam. O prefixo ainda precisa
cobrir a nova origem verificada; não se exige silêncio do tráfego para concluir.

`maintenance_rebind.py` registra a intenção e os bytes anteriores antes de
trocar somente o vínculo da origem. O leitor aceita a mudança em processo
apenas após conferir o journal, a mesma instância do leitor, o processo antigo
com saída comprovada e todos os ACKs do corte. O próximo emissor precisa de
atestado novo; a mudança não inicia contêiner, renova acesso ou zera histórico.
Resultado de escrita incerto é reconciliado por leitura, sem completar escritas
automaticamente nem iniciar outro leitor para contornar a prova.

`maintenance_policy.py` prepara a política do próximo vínculo a partir somente
de `/etc/raspberry-mqtt-maintenance/source-candidate.json`, privado e Root.
O candidato precisa de recibo de auditoria da imagem, binário e plugin,
vinculado à aprovação, operação, head do journal e domínio BOOTTIME atuais.
O preparador confere a imagem e identidade do contêiner parado, o encerramento
da origem anterior e a prontidão do consumidor. Ele altera somente a origem e
sua definição; aprovação, validade, código e consumidor ficam preservados.
Um recibo durável guarda os bytes anteriores antes da escrita. Conflitos de
política durante a inspeção final são preservados; repetir a solicitação
apenas observa a política, mesmo após falha anterior à escrita.

`source_image_audit.py` produz esse recibo a partir do job Root fixo
`/etc/raspberry-mqtt-maintenance/source-audit-job.json`. O job vincula imagem,
configuração e contêiner parado à mesma operação e ao head atual. O produtor
confere a origem oficial da imagem ARM64 já disponível, o binário ELF, o plugin,
as licenças/notices fixadas e os hashes e montagens da configuração. Não baixa
imagens nem executa a configuração residencial no teste.

A prova de ABI executa um broker próprio sem rede e sem dados residenciais,
com configuração sintética e um leitor Root limitado. Verifica as sete classes,
o fechamento da origem e o PIDFD após a saída do emissor. Cada efeito tem intent
anterior; o probe é removido antes da emissão do candidato. O Docker usa uma
configuração Root vazia e o socket local fixo. Um retorno de criação perdido só
permite reconciliar o nome, label, imagem e montagem exatos da operação. Recibos
incertos são preservados e não disparam uma segunda auditoria.

O atualizador aprovado ainda precisa emitir esse job a partir do candidato
real e preservar a configuração residencial. O chamador do controlador fornece
somente operação e head, sem caminhos, contêineres ou política arbitrária.

O [aceite isolado do controlador](../scripts/raspberry-mcp/mqtt-maintenance-controller.acceptance.json)
comprova os quatro efeitos em contêineres próprios, recriação do identificador
da origem, retomada do consumidor e preservação do leitor. Uma tentativa anterior
encerrou sem confirmar o corte final e permanece preservada. O teste integrado
posterior executou o produtor nativo, o preparador de política e o corte comum
comprovado por recibo. Isso não instala nem autoriza a superfície de produção.
Permanecem pendentes a emissão do job pelo atualizador real, sua coordenação
com o plano de manutenção e a recriação
do próprio consumidor, o pacote completo de implantação, revogação/reversão,
projeção MCP e a aprovação
específica de acesso permanente.

### Delegação finita do backup

`maintenance_plan.py` coordena o backup a partir da operação `backup_snapshot`
já observada pelo controlador. Antes de parar os serviços, sela um plano Root
ligado ao primeiro recibo, aprovação, código e domínio BOOTTIME. Seu perfil
privado `backup-plan-policy.json`, no diretório do journal, precisa declarar
`maximum_duration_ns` e `observation_interval_ns`; não há prazos implícitos.
O orçamento começa no recibo inicial e não é renovado quando o worker retoma.
Mudança no perfil ou esgotamento do prazo bloqueiam novos efeitos e preservam
o histórico para recuperação revisada.

Antes do primeiro efeito, o plano também sela a recuperação independente de
`backup_rescue.py`. O perfil Root `backup-rescue-policy.json` declara escopo,
aprovação, código, `maximum_recovery_ns` e `observation_interval_ns`. Seu prazo
é calculado uma única vez a partir do início do plano e dos dois orçamentos;
a autorização principal precisa cobrir essa duração. Nova chamada não amplia
o prazo nem renova a autorização de leitura.

O helper candidato `backup_cli.py` aceita somente `prepare`, `resume`,
`status`, `rescue`, `export`, `mode`, `prepare-closed`, `resume-closed` e
`export-closed`, com um ID de operação. Usa caminhos e alvos fixos e roda fora do
Node-RED. `prepare` para a origem, confirma fechamento e ACKs e só então para
o consumidor. `resume` inicia o consumidor, exige observação nova do mesmo
leitor com a origem ainda parada e então inicia e verifica a origem. As
consultas de espera são limitadas pelo plano; intents existentes nunca
autorizam repetir comandos de resultado incerto.

O worker existente `offsite-backup.mjs` usa essa fronteira por meio de
`mqtt-maintenance-backup.mjs`. Os demais serviços continuam no snapshot
consistente já existente. A retomada coordenada também é solicitada quando a
captura falha, e sua confirmação antecede o upload e a retenção. Nenhum restart
genérico inclui novamente os dois serviços coordenados. Sem observador
instalado, o worker conserva o caminho anterior. Observador instalado sem
contrato Root válido bloqueia o backup antes da parada.

O contrato Root público `/run/raspberry-mqtt-observation/backup-contract.json`
precisa ter modo `0444`, versão, escopo, `enabled`, SHA do helper e
`maximum_command_ms`; o código Root permanece `0644` e imutável para o worker.
A ponte valida diretórios, owners, modos, hashes e respostas vinculadas à
operação e invoca somente o helper Python fixo, sem ambiente herdado. Esse
contrato não concede acesso por si só: sudoers, perfil Root, autorização de
origem e política de manutenção precisam integrar o pacote aprovado.

O canvas `atualizacoes_diarias` conserva a decisão: só libera os updates após
backup protegido e remoto verificado e `mqtt_coordination=verified` ou
`not_installed`. Campo ausente, desconhecido ou falho bloqueia a sequência.
Para o replay manual, solicite o TESTE 0A do backup externo, depois execute
sucesso, falha ou adiamento e confira o terminal dry-run compartilhado. O teste
não invoca o helper nem para serviços reais.

### Retomada após falha ou vencimento do plano

Se a retomada normal falhar, a ponte solicita uma única recuperação do mesmo
plano. Esse caminho fecha a nova telemetria com o marcador Root persistente
`revoked` e remove o marcador positivo; não altera a autorização armazenada.
Confere a imagem/vínculo e as montagens originais, o SHA do plugin e os arquivos
de código antes de iniciar somente o consumidor e a origem. Não para serviços,
reconfigura contêineres, reinicia host/stack, escolhe novos alvos ou reabre a
telemetria. O trabalho não depende do leitor de metadados nem de sua autorização
de leitura ainda estar ativa; a autorização principal de manutenção continua
obrigatória e pode revogar a recuperação.

Cada partida tem intent durável e nova comparação do estado imediatamente
antes do efeito. Intents da retomada normal também são consumidos: criar outro
ator não permite repetir uma partida incerta. Um stop ainda incerto, com o
serviço em execução, exige observação posterior; não é tratado como retomada
confirmada. Esgotamento do orçamento, mudança de alvo/código ou resultado
irresolúvel exigem recuperação manual e continuam registrados.

O journal conserva o prefixo original e aceita dois terminais separados:
`cancelled`, somente antes de qualquer intent de efeito, e `rescued`, ligado
ao recibo de recuperação com telemetria fechada. Nenhum fornece as comparações
de uma manutenção normal concluída nem um aceite de 24 horas. O consumidor
preserva seus contadores/ACKs e publica integridade desconhecida. O worker
confere a saúde dos serviços restaurados e reporta
`house_restored_metadata_disabled`, bloqueando upload/retenção daquele ciclo.

O [aceite isolado da recuperação](../scripts/raspberry-mcp/mqtt-backup-rescue.acceptance.json)
inclui vencimento real do prazo, retomada dos dois contêineres, entrega MQTT
posterior e ausência de novos frames de telemetria após a revogação. Não ativa
essa superfície na casa nem comprova as permissões do helper instalado.

O [aceite isolado do plano de backup](../scripts/raspberry-mcp/mqtt-backup-plan.acceptance.json)
comprova os quatro comandos reais em dois contêineres próprios, preservação do
leitor e do vínculo, snapshot dos metadados e retomada após falha sintética na
captura da aplicação. Não comprova o restore dos sete serviços nem a execução
do helper com permissões instaladas em produção. Antes de ativar, faltam o
bootstrap da primeira cópia externa real de 14 componentes, a ativação do
restore histórico revisado, a validação operacional dos backups com telemetria
fechada, o acordo de prazos com o orçamento de indisponibilidade e o
pacote completo de instalação/revogação/reversão com aprovação específica.

### Backup de dados existentes com autorização fechada

O contrato candidato v3 consulta `mode` antes de qualquer parada. Com autorização
ativa, conserva o plano coordenado. Com autorização desabilitada, vencida ou
revogada, exige o perfil Root separado `closed-backup-policy.json`, ausente por
padrão, com modo `0600`. Esse perfil declara `schema_version: 1`, escopo
`mqtt_metadata_closed_backup_v1`, `enabled: true`, validade própria em
`expires_at`, aprovação e manifesto de código exatos em `approval_sha256` e
`code_manifest_sha256`, e duração finita em `maximum_duration_ns`. Ele precisa
integrar o pacote e a aprovação específica de instalação. Não renova nem
substitui a autorização de coleta.

`frozen_backup.py` verifica os arquivos instalados e registra `frozen_begin`
com o hash e o vencimento originais da autorização, o estado observado dos
marcadores e o prazo fixo da operação. Não executa comandos de serviço,
consulta ao protocolo, refresh do grant ou escrita de marcadores. O worker
residencial existente conserva a parada e retomada ordinárias dos sete serviços;
os helpers fechados só copiam dados já existentes e concluem o journal. A cópia
assíncrona termina antes da retomada ordinária, inclusive quando falha.

O snapshot declara `consistency: closed_metadata_unknown_cut` e
`metadata_integrity: unknown`, com `full24h_proven: false`. Verificar checksums
e SQLite não comprova fechamento do protocolo, entrega integral ou cobertura.
Um marcador positivo residual é registrado e preservado: autorização fechada
sozinha não prova que o produtor já parou. Alteração de grant, perfil, marcadores
ou domínio de relógio durante a captura bloqueia sua conclusão normal. O modo
do transporte precisa coincidir com o manifesto recebido antes da publicação.

O worker também devolve `mqtt_coordination=unknown` nesse modo, mesmo quando a
captura e os recibos de backup foram verificados. Assim o gate existente do
Node-RED não libera updates como se houvesse coordenação ativa comprovada.
`capture_verified` descreve a integridade do artefato; não transforma o corte
desconhecido em cobertura do protocolo. O contrato residencial atual de 13
componentes permanece preservado; a transição revisada para 14 e o bootstrap
da primeira cópia real precisam de pacote e aprovação específicos, sem
reescrever um recibo histórico de 13 como se já comprovasse 14.

Uma captura parcial permanece preservada e nunca é recopiada com o mesmo ID.
Após perda de retorno, `resume-closed` pode conferir um artefato completo e
registrar `frozen_complete`; repetições posteriores só conferem os mesmos bytes.
Não chama o rescue ativo. Operação residencial anterior inconclusiva bloqueia
nova admissão. Os IDs fechados continuam consumidos no arquivo histórico e
após restore; nenhuma permissão anterior é restaurada. O
[aceite isolado](../scripts/raspberry-mcp/mqtt-closed-backup.acceptance.json)
registra testes de código e dados sintéticos. Esse modo ainda não está instalado
e não comprova o ciclo residencial nem a primeira cópia externa de 14 componentes.

O ensaio adicional executou o CLI fixo e os checks Root reais com bindings de
fixture, nos três estados de autorização. O corpo original do worker rodou em
VM: parada/retomada alcançaram sete contêineres próprios de processos de guarda,
e a captura/restauração de 14 componentes usou arquivos sintéticos. O helper
ficou sem rede e sem socket Docker. Cada caso preservou grants, recusou nova
captura com ID consumido e restaurou o histórico com a nova autorização
desabilitada. Os oito contêineres foram removidos e os sete contêineres
residenciais mantiveram estado e `StartedAt`. Geração, envio e recibos externos
foram simulados; processos de guarda não comprovam restore funcional das
aplicações. Falhas anteriores de montagem da fixture foram preservadas sem
relaxar os gates existentes de manifesto e diretório de saída.

### Snapshot protegido do observador no backup

`backup_snapshot.py` combina a cópia consistente de SQLite e estado/ACK do
consumidor com `Journal.history_files()`. O helper fixo aceita `export` e o
mesmo ID do plano, sem caminhos recebidos do chamador. Confirma a fronteira
`consumer_stopped` antes e depois da captura e mantém os locks necessários.
A cópia SQLite usa a API de backup online, consolida seu próprio journal e é
relida como imutável: nenhum WAL/SHM auxiliar pode ficar fora do inventário.
O ledger vivo mantém seu próprio modo de journal e contadores.

A saída é um fluxo de quadros limitados, com chunks de até 32 KiB, SHA-256 de
cada arquivo, papéis explícitos de dados e manifesto final. O limite total é
64 MiB e 41.136 arquivos, incluindo histórico restaurado; o manifesto tem
limite de 16 MiB. O receptor exige inventário exato, EOF e saída zero
do produtor antes de publicar o manifesto local. Truncamento, campos extras,
caminhos não revisados, mudança do contrato ou divergência de hash recusam a
captura. O worker aguarda essa captura assíncrona terminar antes de retomar os
serviços; uma falha segue pelo caminho normal de recuperação.

O exportador tem prazo de 30 segundos, limite de CPU de 20 segundos e espaço
virtual de 2 GiB. Este último permite executar o validador Node de checkpoint
com heap de 64 MiB; não é um limite de RSS. O leitor contínuo mantém seu limite
separado de 128 MiB. Os arquivos são transmitidos incrementalmente. O acordo
entre esses prazos e o orçamento total de indisponibilidade ainda pertence ao
pacote de ativação.

O contrato Root v2 fixa os hashes do helper e da definição de componente em
`restore/mqtt-observation-private-state.json`, além do escopo e prazo do
snapshot. A política privada precisa declarar explicitamente a inclusão
opcional; sem ela, o manifesto atual continua com seus 13 componentes de
Compose. Com ela, `mqtt_observation_metadata` entra como 14º componente no
manifesto e na mesma lista completa de checksums. Um observador instalado sem
esse contrato completo é bloqueado antes de qualquer parada. A fonte declarada
desse componente representa o export gerado na captura, nunca um fallback para
copiar arquivos atuais de autoridade. Recibos históricos não devem ser
reescritos para fingir uma cópia externa anterior de 14 componentes: o primeiro
bootstrap real desse novo conjunto ainda precisa de procedimento próprio.

O restore genérico confere novamente o snapshot e grava somente o artefato em
`.local-state/mqtt-observation-restored-data`. Ele não instala arquivos no
journal ativo, restaura autorização, aplica políticas antigas ou inicia coleta.
Recuperar o histórico sob uma nova autoridade exige a etapa separada abaixo,
com destino vazio e autorização atual desabilitada.

O ensaio nativo usou somente broker e Node-RED próprios, sem rede ou dados da
casa. Exercitou o CLI real com caminhos de fixture, saída zero do produtor,
transporte, pacote de 14 componentes, restore em staging e igualdade do ledger
copiado. Os demais payloads de aplicações eram sintéticos. A retomada preservou
leitor, CIDs, ACKs e comparações do controlador; isso não comprova o restore
funcional das sete aplicações nem continuidade de 24 horas em produção.
O [aceite do snapshot e transporte](../scripts/raspberry-mcp/mqtt-backup-snapshot.acceptance.json)
separa essas provas das pendências de ativação e da primeira cópia externa real.

### Restauração histórica sem reutilizar permissões

`restored_history.py` valida o artefato completo, o inventário interno de dados,
as cadeias ativas/arquivadas e seus recibos antes de escrever no destino.
Ele recusa arquivos históricos não associados às operações declaradas. Não
existe uma ferramenta MCP que aceite caminhos livres para esse procedimento:
a ligação a um executor fixo ainda pertence ao pacote de ativação revisado.

O destino precisa estar vazio, com diretórios e proprietários esperados e
autorização atual desabilitada. Antes de copiar dados, a restauração publica
um journal v3 com `history_restore_state=pending`, hash do artefato e hash da
autorização atual. Esse bloqueio impede admissão, continuação e exportação de
operações enquanto a cópia estiver incompleta. Os dados e sua autorização
permanecem separados; não são instalados grants, políticas de origem ou pedidos
preparados vindos do backup.

As cadeias antigas ficam em `restored-operation-<id>.json` e seus recibos em
`restored-receipt-<tipo>-<id>.json`, nunca sob os nomes usados pelo controlador
ativo. `restored-history.json` ancora até 4.112 IDs consumidos e 64 gerações de
proveniência. O journal v3 ancora esse índice; ID importado é recusado antes
de acessar o executor de efeitos. Índice ausente, alterado ou inseguro bloqueia
novas operações. Uma operação atual já admitida pode continuar seu registro
de recuperação se o índice histórico ficar indisponível. A rotação do conjunto
ativo preserva os campos v3. Um backup posterior inclui o histórico importado,
sem substituir sua aprovação original pela atual.

Somente depois da conferência dos arquivos, do SQLite e do estado/ACK do
consumidor o bloqueio passa a `complete`. Após falha ou perda de retorno,
`reconcile=True` confere os bytes já existentes: não recopia arquivos, não
sobrescreve destino, não executa intents e não reabre coleta. Se a cópia está
incompleta, o bloqueio permanece. Se todos os dados estão duráveis, pode apenas
concluir o bloqueio; se já concluído, a reconciliação é somente leitura.
Autorização alterada ou ativada durante esse processo impede a conclusão.

O [aceite da restauração histórica](../scripts/raspberry-mcp/mqtt-history-restore.acceptance.json)
separa a prova em fixtures da implantação. A recuperação não transforma
hashes em prova de origem autenticada e não comprova as sete aplicações, a
continuidade residencial de 24 horas nem a primeira cópia externa real.

## Revogação, reversão e recuperação

Revogação fecha a autorização e remove o marcador positivo. O plugin verifica
autorização e revogação antes de enviar, inclusive no encerramento. A perda de
autorização desabilita sua telemetria sem alterar o resultado dos callbacks do
broker; rearmar exige uma ação deliberada revisada. Não há renovação automática.

Reversão deve primeiro fechar a coleta, registrar o resultado e só então restaurar
a configuração e montagens do broker por comparação com o baseline. Preserve
dados, entidades, histórico, contagens, recibos e backups. Não reinicie o host ou
a stack para remover o observador. Não apague SQLite para obter um estado saudável.

`recovery_data.py` copia somente os dados do novo coletor: bloqueia o consumidor,
usa a API de backup online do SQLite e registra checksums. A restauração recusa
destino existente e exige autorização atual desabilitada. Ela preserva a política
e o vínculo atuais; não copia grants, propostas preparadas ou configuração de
origem do backup. O relatório é regenerado. Falhas de snapshot são preservadas.

Esse restore de metadados não comprova recuperação de Home Assistant, Node-RED,
Mosquitto, Zigbee2MQTT, Matter Server, AppDaemon ou Portainer. Cada aplicação
precisa de teste funcional isolado com sua própria evidência.

## Testes e aceite

O tab prevê reset e cenários nominal, duplicata, acima do limite, relógio
desconhecido, perda, zero eventos, fonte ausente, ocupado, formato inválido,
desabilitado, autorização fechada, domínio diferente, relógio futuro, leitor
antigo e metadados ausentes. Execute reset antes de uma sequência nova; a
duplicata usa o estado do cenário nominal. Todos atravessam a política real
até o terminal `simulated: true`, `dispatched: false`, sem exec, ACK, push ou
efeitos residenciais. Falha e indisponibilidade também usam o replay global.

Os testes do projeto descobrem o canvas e o consumidor por seus agregadores.
Fixtures Python portáveis rodam sem privilégios; fixtures de ownership só rodam
em executor Root isolado e mostram skips explicitamente em conta comum.
Execute `make validate-public` pelo wrapper canônico, sem suítes amplas paralelas.

O aceite de produção permanece separado: carga efetiva do plugin e leitor,
chamada MCP real, políticas e valores canônicos, ausência de perda, latência
medida por classe, atualizações e reversão, recursos e cobertura contínua de
24 horas. Preserve lacunas anteriores e interrupções de manutenção. Não gere
eventos domésticos nem antecipe o ciclo natural para fechar o aceite.
