# Auditoria da memória persistente do projeto

Verificação em 2026-09-21, baseline `24ae93e`. Este relatório é evidência datada,
não inventário de runtime para preload. O contrato vigente é
[Memória versionada dos agentes](MEMORIA_VERSIONADA_AGENTES.md).

## A. Estado encontrado antes das melhorias

| Componente | Estado | Evidência e limite |
| --- | --- | --- |
| Memory storage | PASS | Markdown temático em `.codex/memories/`, indexado e versionado; escrita/recuperação positiva verificadas em fixture isolada |
| Memory writer | PARTIAL | Agente interativo ou semanal edita; novo `scripts/memory-candidate.mjs` valida/reconcilia notas selecionadas; não extrai conhecimento sozinho |
| Memory reader | PARTIAL | Índice/busca por instrução; sessão independente recuperou nota sintética, mas nenhum leitor obrigatório injeta todo o corpus em cada prompt |
| Automatic capture | NOT IMPLEMENTED | No baseline, nenhum gatilho por descoberta/fim de prompt promovia chats; teste negativo não produziu memória |
| Automatic reconciliation | PARTIAL | Agora há atualização por ID e checagem de evidência, acionadas explicitamente pelo agente; sem dedupe semântico automático de paráfrases |
| Scheduled review | PARTIAL | Agenda Node-RED habilitada, worker ativo; última tentativa falhou antes da revisão por limite de uso do Codex |
| Cross-validation | PARTIAL | Checker estrutural + hashes de fontes nas novas notas; drift detectável, mas consistência semântica depende de revisão |
| Privacy protection | PARTIAL | Fontes públicas, denylist, scanner e testes negativos; padrões conhecidos não provam ausência de todo dado pessoal em prosa |

No baseline, não havia evidência de um ciclo automático completo por interação.
A aceitação posterior do hook de revisão está registrada na seção H. A leitura de
arquivos pelo checker anteriormente apresentada como contexto pronto não era
prova de recuperação/uso pelo Codex. O resultado agora explicita esse limite.

## B. Arquitetura e gatilhos comprovados

| Etapa | Executor e gatilho | Entrada -> saída/persistência | Falha e prova |
| --- | --- | --- | --- |
| Instruções de startup | CLI/cliente descobre `AGENTS.md` ao iniciar tarefa | Agregado de `.codex/instructions/` -> contexto normativo | `public-memory-check.mjs` verifica sincronização/limite; descoberta do cliente não expande links temáticos |
| Registro de conversa HA | `ia-bridge/server.js`, ao receber/concluir `/chat` | Prompt/resposta -> `SharedHistoryStore` em `ia-bridge/history.js` -> histórico privado | Erro de escrita no log do bridge; `history.test.js` testa armazenamento; não há chamada para writer de memória pública |
| Continuação HA | `codexExecArgs` em `ia-bridge/codex-options.js` | ID da conversa -> `exec resume` ou execução nova | Continuação de sessão não é consolidação temática nem compartilhamento automático entre tarefas |
| Seleção de descoberta | Agente interativo; agora instrução explícita de avaliar ao concluir trabalho durável | Código/teste/decisão sanitizada -> candidato | Hipótese/pedido não confirmado não pode ser promovido; cumprimento depende do agente |
| Validação e persistência | `memory-candidate.mjs`, invocação explícita | JSON sanitizado + hash do alvo + fontes -> nota no Markdown existente | Checker antes da escrita, lock, comparação e rename; testes de privacidade, concorrência e idempotência |
| Deduplicação/atualização | `reconcileRecord` em `memory-evidence.mjs` | Mesmo ID -> substituição apenas da nota | IDs duplicados falham; repetir conteúdo/evidência gera zero mudança |
| Verificação posterior | `public-memory-check.mjs` em `make validate-public`/pre-push/CI/revisão | Índices, notas, fontes -> PASS ou erro | `evidence_changed` quando fonte de nota registrada muda; não é prova semântica de contradição |
| Recuperação temática | Agente segue índice e busca quando a tarefa requer histórico | Memória selecionada -> contexto de nova execução | Teste real independente encontrou a nota; `memory_context.py retrieve` só seleciona arquivos |
| Restore de contexto | `ai-context-recovery.mjs`, comando do operador | Commit/worktree + tema -> verificação de arquivos | `evidence_scope: public-files-only`; campos de prova de uso pelo Codex são falsos |
| Revisão periódica | Tab `revisao_documental_semanal` -> trigger -> `weekly-docs-review.mjs` -> agente | Fontes públicas + prompt semanal -> worktree isolada + recibo -> validação -> commit/push | Worker rejeita ausência de recibo, escopo indevido, validação falha ou baseline alterado |
| Local AI/hook | `.codex/hooks.json`, `PostToolUse` de `Bash` quando ativado no cliente | Saída elegível -> redução determinística/metadata | Não é hook de fim de prompt nem writer; compressão generativa não promovida |

```text
prompt -> instruções do projeto -> agente seleciona evidência pública
       -> candidato sanitizado -> checker -> Markdown canônico -> Git
nova sessão -> instruções -> índice/busca -> nota relevante -> uso com fonte

prompt HA -> bridge -> histórico privado/continuação da conversa
                      [sem ligação automática ao writer público]

agenda Node-RED -> worker semanal -> revisão de fontes públicas -> validação
               -> commit/push somente com recibo e baseline estável
```

`AGENTS.md` é GENERATED; módulos de instruções e memórias temáticas são
CANONICAL; índice temático é INDEX; `MEMORY.md` é COMPATIBILITY; históricos,
configuração nativa do cliente e estado dos jobs são RUNTIME privado.
Não foi criada outra base de fatos, embeddings ou cópia global de memória.

A descoberta de `AGENTS.md` é mecanismo do cliente documentado pela
[OpenAI](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
No host auditado, geração e uso de memória nativa estavam explicitamente
desativados. A configuração do bridge não tinha esses overrides explícitos;
seus defaults nativos não foram usados como prova de persistência pública.
Memória nativa e `.codex/memories/` são mecanismos diferentes.

## Revisão semanal e disponibilidade

O inject de runtime estava habilitado com `00 03 * * 1` e timezone
`America/Sao_Paulo`, equivalente a segunda-feira às 06:00 UTC. Worker ativo,
agenda controlada pelo Node-RED, próximo pedido esperado em 2026-09-28 às
06:00 UTC. `next_run` é previsão de agenda, não garantia de execução bem-sucedida.

A última tentativa iniciou às 06:00:03 UTC de 2026-09-21 e terminou às
06:00:07 UTC com `process_failed`. A janela correspondente do log mostrou
limite de uso do Codex; o agente não concluiu revisão nem publicou memória.
O estado agregado mostrava 8 execuções, 3 sucessos, 5 falhas e 8 skips
(contadores de eventos distintos, não uma soma de execuções concluídas).
Não reproduzimos conteúdo de prompts/logs privados neste relatório.

O worker usa lock `.git-backup.lock`, worktree isolada, timeout, allowlist,
recibo obrigatório, validação pública e checagem do baseline antes de integrar.
Seu status e erros chegam ao observador por rotas de falha/ação necessária.
A inspeção de timers/cron não identificou outro writer de memória. Não foi
executada revisão semanal real para contornar cota ou disputar a worktree.

O Compose declara limites de CPU/memória para o worker. A inspeção do container
ativo confirmou limite de CPU, mas `HostConfig.Memory` era zero: a limitação de
memória declarada não estava aplicada ao runtime observado. Isso é uma
pendência de reconciliação operacional, não evidência de perda de memória do
projeto; nenhum serviço foi recriado por esta auditoria.

## Chats e fontes recentes disponíveis

| Fonte | Disponibilidade observada | Uso nesta auditoria |
| --- | --- | --- |
| Sessão atual | Disponível nesta tarefa; inclui decisões recentes sobre notificações/canvases | Comparada aos commits, fontes e testes; nenhum transcript publicado |
| Histórico HA compartilhado | Persistido localmente; `agent-history.mjs list` retornou registros até 2026-08-25 | Metadados mostraram que não era uma sincronização das tarefas recentes; conversas antigas não relacionadas não foram importadas |
| Sessões locais do cliente | Metadados de sessões de 2026-09-21 disponíveis para esta tarefa | Configuração nativa e experimentos isolados; não indexadas automaticamente |
| Outras tarefas do aplicativo | Consulta de listagem não retornou nesta auditoria | Cobertura UNVERIFIED; não presumimos acesso a conteúdo ausente |
| Chats do ChatGPT externos | Nenhuma sincronização para o writer público encontrada | Não utilizados; exigem seleção explícita de decisões sanitizadas e confirmação nas fontes |
| Git, testes e docs atuais | Disponíveis e versionados | Fonte de confirmação das mudanças recentes; comportamento em edição concorrente não certificado |

Histórico privado pode orientar uma revisão explicitamente solicitada, mas não
é prova suficiente para promover uma frase a fato. A incorporação correta é uma
nota curta, confirmada em código/testes ou decisão explícita, no tema existente.

## C. Problemas encontrados

| Prioridade | Achado | Tratamento |
| --- | --- | --- |
| P0 | Nenhum identificado no mecanismo inspecionado | Não equivale a auditoria completa de segurança residencial |
| P1 | Ausência de captura automática e falsa equivalência entre checker e uso pelo Codex | Limite comprovado no teste negativo; resultado do checker corrigido; instrução de avaliação por tarefa e reconciliador adicionados |
| P1 | Revisão semanal falhou por cota, deixando lacuna de atualização | Causa evidenciada; não ocultada nem tratada como sucesso; próxima agenda preservada |
| P2 | Orientação de `summarize-memory` operacional contradizia pivot vigente | Corrigida em instruções, contrato e memória; histórico de benchmarks reduzido a fontes |
| P2 | Memória de refresh combinava polling antigo e recovery exclusivo | Removidas afirmações obsoletas; separados recovery seletivo e sondas por referências atuais |
| P2 | Não havia proveniência verificável nem detecção de drift por nota | Registros opcionais com ID, categoria, data e hashes, integrados ao gate existente |
| P2 | Worker ativo sem limite de memória declarado no Compose | Divergência registrada; reconciliação de container fora desta mudança de memória |
| P3 | Histórico extenso de benchmarks duplicado na memória | Consolidado sem apagar fontes documentais |
| P3 | Evidência de arquivos disponíveis descrita como agente apto a operar | Corrigida nos contratos de restore português/inglês e memória de restore |

## D. Melhorias realizadas

- `memory-candidate.mjs` e `memory-evidence.mjs`: reconciliação incremental no
  armazenamento canônico, validação antes de escrever e detecção de drift.
- `public-memory-check.mjs`: valida registros/proveniência no gate já existente.
- `ai-context-recovery.mjs`: declara somente o que o checker realmente prova,
  mantendo `agent_context_ready` por compatibilidade.
- Instrução de memória e agregado `AGENTS.md`: política de compressão vigente e
  avaliação de conhecimento durável ao encerrar trabalho.
- Prompt semanal: exige revalidar a afirmação antes de renovar hashes/data.
- Contrato de memória/restore e notas temáticas: limites, fontes atuais e
  distinção entre histórico, memória pública e memória nativa.

O agente continua responsável pela relação semântica entre texto e evidência.
Hash correto não torna verdadeira uma afirmação inventada. IDs deduplicam notas
identificadas; não detectam automaticamente duas paráfrases do mesmo conceito.

## E. Testes e evidências

Teste de três execuções independentes do CLI, sequenciais, em diretório
sintético descartável, sem resume, usando `--ephemeral`. Nenhum dispositivo,
entidade, serviço residencial ou notificação foi acionado:

1. Execução A leu descoberta artificial e a explicou. Zero alterações nos
   arquivos de instruções/índices/memória copiados; marcador ausente na memória.
2. A fonte transitória foi removida. Execução B, sem receber o fato no prompt,
   respondeu `knowledge_not_versioned`.
3. O reconciliador validou e persistiu a nota na memória da fixture. Execução C,
   sem receber adaptador/marcador no prompt e sem ler scripts, leu índice e nota,
   identificou o adaptador correto e citou o arquivo temático.
4. Diretório, saídas sintéticas e registro temporário desse projeto no cliente
   foram removidos. Nenhum marcador foi inserido na memória de produção.

| Propriedade | Captura espontânea A/B | Candidato validado + sessão C |
| --- | --- | --- |
| CAPTURA AUTOMÁTICA | FAIL | Não implementada; candidato preparado pelo auditor |
| PERSISTÊNCIA | FAIL | PASS |
| RECUPERAÇÃO | FAIL | PASS |
| USO PELO CODEX | FAIL | PASS |
| LIMPEZA DO TESTE | PASS | PASS |

O teste prova a quebra da cadeia na captura e a viabilidade do caminho curado;
não prova que todo cliente/execução seguirá a instrução de seleção. `--ephemeral`
evita contaminar memória nativa e não impede escrita no workspace sintético.
O controle negativo de captura refere-se ao mecanismo público com geração
nativa desativada no cliente auditado.

Comandos de regressão:

```bash
node --test --test-concurrency=1 scripts/memory-candidate.test.mjs scripts/memory-review.test.mjs scripts/ai-context-recovery.test.mjs scripts/public-memory-check.test.mjs
node scripts/public-memory-check.mjs
node scripts/ai-context-recovery.mjs --worktree --topics projeto,automacoes,codex-local-ai,restore
make validate-public
```

Os 31 testes direcionados passaram, assim como o checker público e a
verificação dos quatro temas selecionados. A execução de `make validate-public` passou por documentação, segurança,
privacidade e memória, e parou no gate de estabilidade do gerador Node-RED:
`vehicle_visual_refresh_facts.func` diferia do flow gerado durante uma edição
concorrente do veículo. Essa foi a única diferença entre os nós comparados;
a auditoria não a sobrescreveu. O restante da suíte ampla não foi executado
nessa tentativa. Uma nova validação depende da reconciliação dessa alteração. Os testes
usam fixtures públicas e temporárias, sem registrar segredos. A validação ampla
usa o limitador canônico de recursos e deve ocorrer uma única vez por ciclo,
com coordenação da outra tarefa que edita a worktree.

## F. Memórias revisadas

| Tema/entrada | Classificação encontrada | Ação |
| --- | --- | --- |
| Governança e existência de aprendizado automático | MISSING / UNVERIFIED | ADDED: fronteira comprovada, proveniência e limites dos checks |
| Notificações e retenção de sete dias | CURRENT | Preservadas; evidência nos commits `272259d`, `d53b263` e testes dos hubs |
| Alertas somente por falha/ação | CURRENT | Preservados; `test-operational-alerts.mjs` e contrato dos hubs |
| Preservação de canvases, ELK e snapshots concorrentes | MISSING | ADDED: invariantes e referências aos testes/guia atuais |
| Frequência de refresh dos telefones | STALE / CONTRADICTORY | UPDATED: eliminadas combinações de políticas antigas; fontes atuais explícitas |
| Codex/Local AI: compressão e benchmarks | STALE / DUPLICATED | UPDATED/MERGED: comportamento atual e referências; removida narrativa numérica histórica da memória, documentos preservados |
| Restore: checker versus uso do agente | UNVERIFIED | UPDATED: disponibilidade de arquivos não prova uso em sessão |
| Práticas de trabalho/revisão semanal | CURRENT no contrato inspecionado | Preservadas; falha transitória registrada somente neste relatório |
| Integrações, segurança e bindings | CURRENT na estrutura pública; semântica integral UNVERIFIED | Sem mudança; não houve reteste de todas as integrações ou exposição de runtime residencial |

Nenhum arquivo do usuário foi apagado. Nenhuma hipótese foi promovida
automaticamente. O baseline não foi alterado para fazer memória antiga parecer
correta. Não foi adicionado um changelog de chats à memória temática.

## G. Respostas sobre o baseline e o caminho curado

**A memória é alimentada automaticamente a cada descoberta relevante? NÃO.**
Há orientação ao agente e revisão periódica; faltam captura e seleção garantidas
por interação. O teste negativo confirma a lacuna no cliente auditado.

**Uma nova execução independente recupera essas descobertas automaticamente?
PARCIALMENTE.** Recuperou a nota previamente persistida seguindo índice/busca,
sem o fato no prompt. Descobertas não persistidas continuaram ausentes.

**O sistema melhora sua compreensão persistente ao longo do tempo?
PARCIALMENTE.** Atualizações curadas e revisão semanal podem melhorar o corpus;
agora há reconciliação/testes melhores, mas não aprendizado autônomo garantido.

O critério de conclusão da auditoria foi atendido pela prova do ponto de falha
(captura) e pela prova positiva do caminho validado até uso em nova sessão.

## H. Exigência posterior de revisão em novas conversas

Foi implementado um hook `Stop` no mesmo arquivo de hooks do projeto, sem
alterar o roteamento Local AI existente. `scripts/memory-review.mjs` impede
encerramento silencioso sem checkpoint e pede ao próprio agente para registrar
conhecimento útil ou declarar ausência de descoberta durável. Não importa
transcripts e não promove automaticamente prosa privada a fato.

Testes de `memory-review.test.mjs` cobrem continuação obrigatória, mudança
persistida, conversa sem descoberta, novo turno, recibo vencido, alteração
concorrente, privacidade, falha de evidência, pendência e limite de tentativas.
O hook não confunde aprovação do candidato com publicação no Git.

A ativação foi realizada interativamente pelo usuário em `/hooks`, no CLI do
host e na conta que executa novas sessões. Consulta posterior ao App Server
confirmou `enabled: true` e `trust: trusted` para `Stop` e `PostToolUse`.
Não foi falsificada nem automatizada confiança de hooks.

O teste real revelou duas condições que os eventos sintéticos não cobriam:
o diretório privado precisava pertencer ao usuário do cliente, e o sandbox
retornava `EPERM` ao criar stdin em pipe para o subprocesso Git. Foi provisionado
somente `.local-state/memory-review/`, com modo `0700`; writer e checkpoint
passaram a ignorar stdin na consulta ao Git, como já fazia o checker público.
Os erros do checkpoint agora expõem somente um código diagnóstico, sem entrada
ou conteúdo privado. Uma regressão adicional percorre writer e checkpoint com
índice Git real, sem manifesto de arquivos injetado.

Após a correção, uma execução independente, efêmera e em `workspace-write`
recebeu apenas uma solicitação sem descoberta durável. O próprio evento `Stop`
continuou a sessão, o agente consultou o contrato e executou a conclusão;
o recibo ficou `reviewed / no_durable_discovery` e o processo encerrou com
código zero. Nenhuma nota artificial foi criada, nenhum arquivo versionado
foi alterado pelo teste e não houve efeito residencial.

Estado final dessa aceitação: `ACTIVE_REVIEW_VERIFIED` no CLI do host. A prova
positiva de persistência e recuperação de uma nota em outra sessão continua
sendo o experimento isolado da seção E; o smoke test de `Stop` comprova a
exigência automática da revisão, não a perfeição da seleção semântica.
Extensão e bridge exigem sua própria aprovação/verificação. Conversas sem
conhecimento novo não devem criar notas artificiais.
