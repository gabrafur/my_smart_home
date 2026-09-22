# Memória versionada dos agentes

Este contrato define como o repositório mantém conhecimento reutilizável para
Codex, Claude Code e outros agentes sem transformar histórico privado em
documentação pública.

## Arquitetura e autoridade

A memória é uma camada documental de baixa autoridade. Em caso de divergência,
vale esta ordem:

1. código e configuração executável atual;
2. testes e contratos executáveis;
3. documentação operacional atual;
4. decisões arquiteturais vigentes;
5. memória versionada dos agentes.

Uma divergência deve ser resolvida corrigindo ou removendo a memória obsoleta.
Código não deve ser alterado apenas para confirmar uma anotação. Decisões
substituídas só permanecem quando marcadas como históricas e ligadas à fonte
vigente.

## Estrutura pública

| Componente | Papel |
| --- | --- |
| `AGENTS.md` | agregado gerado que o Codex carrega ao iniciar uma sessão |
| `.codex/instructions/*.md` | fontes canônicas das instruções normativas atuais |
| `MEMORY.md` | índice de compatibilidade curto para ferramentas e pessoas |
| `.codex/memories/projeto/indice.md` | índice canônico dos assuntos |
| `.codex/memories/<assunto>/<nome-descritivo>.md` | decisões temáticas reutilizáveis |

`.codex/instructions/` e `.codex/memories/` são exceções públicas, explícitas e
limitadas dentro de `.codex/`. Instruções e memórias não se misturam: instruções
são regras normativas atuais, enquanto memórias são conhecimento recuperável de
baixa autoridade. Os demais conteúdos de `.codex/` continuam sendo runtime
privado. Cada memória temática deve ser Markdown, ter nome descritivo em
kebab-case e estar listada nos dois índices.

## Contexto de startup e retrieval

Memória do repositório é armazenamento de conhecimento, não payload automático
do prompt. A única peça sempre pequena o bastante para consulta inicial é o
índice canônico `.codex/memories/projeto/indice.md`; `MEMORY.md` existe para
compatibilidade e é conceitualmente redundante, não outra fonte canônica.

Regras que precisam valer antes de qualquer recuperação ficam nos módulos de
`.codex/instructions/`. Como o Codex não expande links Markdown ao descobrir
instruções, `AGENTS.md` é regenerado deterministicamente com o conteúdo integral
desses módulos e não deve ser editado diretamente. Procedimentos especializados
e acionados sob demanda ficam nas skills públicas explicitamente autorizadas em
`.agents/skills/`; nenhum desses conteúdos deve ser duplicado como memória
temática. Assim, memória continua sendo conhecimento recuperável, enquanto
instruções obrigatórias e workflows mantêm seus próprios mecanismos de
descoberta.

Para cada tarefa, o agente deve primeiro decidir se histórico do repositório é
necessário. Em caso negativo, não carrega memória temática. Em caso positivo,
usa primeiro busca determinística (`rg`, índice, nomes, headings e metadados),
recupera apenas os arquivos ou seções relevantes e prefere a documentação
operacional atual a uma anotação histórica duplicada.

Recuperações grandes seguem `.agents/skills/rtx-context-optimizer/SKILL.md`.
Nenhum perfil generativo de compressão está promovido: selecione e reduza
fontes deterministicamente e siga no modelo principal. A orientação antiga de
executar `summarize-memory` operacionalmente foi substituída pelo pivot
restrito, documentado em `docs/LOCAL_AI_RTX_4070.md`.

`local-ai memory-audit` mede somente o contexto observável. O índice é
`ROUTING_ONLY`; sua presença não prova leitura do conteúdo temático.
`memory_context.py retrieve` seleciona arquivos públicos pelo índice, sem
inferência. Nenhum desses comandos extrai novas descobertas dos chats.

`scripts/ai-context-recovery.mjs` verifica disponibilidade e estrutura dos
arquivos selecionados, em worktree ou commit. `agent_context_ready` é mantido
por compatibilidade e significa arquivos disponíveis. O resultado declara
`evidence_scope: public-files-only`, e os campos de captura automática,
consistência semântica e recuperação/uso por Codex independente são `false`.
Uma leitura pelo checker não é uma execução do Codex e não prova aprendizado.

## O que registrar

Registre somente conhecimento durável que um agente futuro precisará para não
repetir um erro ou violar um contrato:

- decisões arquiteturais e invariantes;
- convenções de trabalho;
- riscos e armadilhas recorrentes;
- razões para comportamentos não óbvios;
- procedimentos de recovery;
- limitações confirmadas;
- relação com a documentação operacional que continua sendo a fonte atual.

Não use a memória como changelog, inventário de versões ou cópia dos guias.
Resultados isolados, autorizações temporárias, hipóteses não confirmadas e
detalhes substituídos devem ser removidos. Versões correntes pertencem ao código
ou ao guia operacional correspondente, salvo quando a versão em si for um
contrato arquitetural.

## Privacidade e runtime

Use somente papéis lógicos, por exemplo:

```text
resident_primary
resident_secondary
mobile_primary
mobile_secondary
vehicle_primary
garage_gate
exterior_light
security_panel
```

Não registre nomes de moradores, relações familiares, endereços, coordenadas,
IPs privados, MACs, IDs físicos ou de contas, rotinas, trajetos, credenciais,
tokens, logs, payloads ou transcripts reais.

As rotinas automáticas não podem ler ou indexar `.agent-history/`, `.claude/`,
conteúdo não público de `.codex/`, `.local-secrets/` nem equivalentes. Se uma
decisão reutilizável existir somente nesses locais, registre apenas:

```text
knowledge_not_versioned
```

O conteúdo deve ser transformado manualmente em uma decisão pública sanitizada.

## Fluxo de manutenção

1. Confirme a informação em código, testes ou documentação vigente.
2. Atualize o arquivo temático existente; crie outro somente para um assunto
   realmente novo.
3. Ao criar um tema, atualize `MEMORY.md` e o índice canônico.
4. Remova versões, caminhos, comandos e conclusões que deixaram de ser atuais.
5. Execute a validação pública completa.

```bash
make validate-public
```

## Validação automática

`scripts/public-memory-check.mjs` usa a lista pública fornecida pelo Git e não
varre diretórios privados. O checker verifica:

- presença e simetria dos dois índices;
- inexistência de memórias temáticas órfãs;
- links relativos e caminhos públicos referenciados;
- existência dos targets `make` citados pela memória;
- padrões mecanicamente detectáveis de IP, MAC, coordenada, chave e token;
- sincronização do agregado `AGENTS.md` com todos os módulos canônicos;
- ordem de autoridade no conjunto de instruções do Codex;
- uso dos caminhos canônicos de instruções e memória no prompt semanal;
- headings duplicados nas instruções de agente;
- ausência de arquivos rastreados nos diretórios privados de runtime, com a
  exceção dos módulos canônicos sob `.codex/instructions/` e de Markdown sob
  `.codex/memories/`.

Os testes negativos ficam em `scripts/public-memory-check.test.mjs`. O target
`make validate-public` também executa o checker documental, o self-test da
rotina semanal e `scripts/security-scan.sh`.

Detecção automática não prova ausência de toda informação pessoal em linguagem
natural. Por isso a revisão humana e o uso obrigatório de papéis lógicos
continuam fazendo parte do contrato.

## Candidatos incrementais com evidência

O agente da tarefa continua responsável por selecionar e verificar decisões.
Não há extrator autônomo de transcripts. O hook de encerramento descrito abaixo
exige revisão pelo próprio agente quando estiver aprovado e ativo no cliente.
A revisão semanal é outro agente, acionado pelo Node-RED, limitado a
fontes públicas e dependente de disponibilidade/cota. Nenhum fluxo transforma
histórico privado em memória pública automaticamente.

`scripts/memory-candidate.mjs` recebe um candidato JSON sanitizado pelo stdin.
Sem `--apply`, valida e informa se haveria mudança; com `--apply`, atualiza
somente uma memória temática existente e indexada. Não cria índice, base paralela,
commit, push, notificação nem agenda. Exemplo de chamada:

```bash
node scripts/memory-candidate.mjs < /tmp/public-memory-candidate.json
node scripts/memory-candidate.mjs --apply < /tmp/public-memory-candidate.json
```

O candidato contém `file`, `expected_memory_sha256` do Markdown atual, `id`
estável em kebab-case, `title`, `body`, `category`, `kind`, `last_verified`
(AAAA-MM-DD) e `evidence` com objetos `{file, sha256}`. Hashes SHA-256 são dos
bytes atuais das fontes públicas versionadas. Categorias aceitas:
`LONG_LIVED_DECISION`, `ARCHITECTURE`, `CONSTRAINT`, `IMPORTANT_DISCOVERY`,
`OPERATING_PROCEDURE`, `KNOWN_FAILURE_MODE`, `PROJECT_CONVENTION`. Somente
`VERIFIED_FACT` e `PROJECT_DECISION` podem ser promovidos; pedidos, observações
não confirmadas e hipóteses precisam primeiro de avaliação pelo agente.

A nota é persistida no próprio Markdown entre marcadores `memory-record`, com
metadados de proveniência e data. O mesmo `id` atualiza a nota; conteúdo/evidência
iguais não geram escrita nem renovação artificial da data. A atualização
preserva o restante do arquivo. Hash do alvo, lock exclusivo e comparação antes
da troca detectam alterações concorrentes observadas. Editores que não usam o
lock ainda exigem coordenação; o sistema de arquivos não oferece CAS geral.

O checker público valida a proposta antes da gravação. Rejeita fontes privadas,
simbólicas ou não versionadas, IDs duplicados, evidência divergente e padrões
conhecidos de segredo. A gravação usa arquivo temporário e troca por rename.
O processo não copia conteúdo de evidências para a nota nem lê conversas.

Alteração de fonte produz `evidence_changed` no gate obrigatório. Isso significa
**revalidar**, não que a memória necessariamente esteja falsa. O hash detecta
mudança de bytes, não contradição semântica: o agente deve comparar a afirmação
com código/testes antes de atualizar hash/data. A idade sozinha não invalida uma
decisão. Notas legadas sem marcador continuam com os checks estruturais; não
alegue cobertura semântica de todo o corpus. Os scanners também não detectam
todos os segredos ou dados pessoais possíveis em linguagem natural.

A sequência comprovável é descoberta pública -> seleção pelo agente -> candidato
verificado -> validação -> Markdown canônico -> índice/busca em nova sessão ->
uso com citação. Os testes em `scripts/memory-candidate.test.mjs` cobrem escrita,
deduplicação, atualização, drift, recuperação em novo processo, privacidade,
idempotência e concorrência. Processo Node.js não equivale a sessão Codex;
a auditoria em `docs/CODEX_PROJECT_MEMORY_AUDIT.md` registra separadamente o
teste de sessões independentes e a falha da captura automática.

## Revisão obrigatória ao encerrar novas tarefas

Os hooks `UserPromptSubmit` e `Stop` em `.codex/hooks.json` chamam
`scripts/memory-review.mjs hook`. `UserPromptSubmit` prepara um checkpoint por
turno e entrega a orientação e o token em `hookSpecificOutput.additionalContext`,
como contexto interno para o agente. A tarefa começa normalmente, sem confirmação
inicial. Antes de responder ao usuário, o agente avalia as descobertas, persiste
somente fatos públicos verificados e conclui o checkpoint. `Stop` apenas verifica
o recibo do mesmo turno e o fingerprint atual; sucesso retorna `{}`.

Nenhum desses hooks retorna `decision: block` ou `reason`: no evento `Stop`,
esses campos criam um novo prompt visível no chat. Pedir silêncio dentro desse
prompt não o oculta. Não use `suppressOutput`, ainda sem implementação segundo a
[documentação oficial](https://learn.chatgpt.com/docs/hooks). A interface pode
continuar mostrando indicadores de execução próprios do cliente.

A revisão não anuncia início, progresso ou sucesso, nem publica token ou resultado
técnico. Uma pendência real (`unverified`, recibo ausente/obsoleto ou falha de
validação) retorna `continue: false`, `stopReason` e `systemMessage`; não inicia
uma continuação automática nem declara sucesso silenciosamente. O agente deve
concluir a revisão antes da resposta final: o aviso no `Stop` não desfaz uma
resposta já enviada. Os hooks não leem `prompt`, `last_assistant_message` nem
`transcript_path`, não chamam outro modelo, rede, dispositivos ou revisão semanal.
A seleção semântica continua pertencendo ao agente.

O contexto interno fornece a chamada de conclusão:

```text
node scripts/memory-review.mjs complete <token> <outcome>
```

Resultados possíveis:

- `updated`: exige mudança persistida na memória desde o checkpoint.
- `already_current`: a decisão útil já está representada; não duplique.
- `no_durable_discovery`: conversa sem conhecimento novo durável; não force nota.
- `unverified`: não foi possível confirmar; o encerramento sinaliza pendência.

Todos os resultados passam pelo checker público. O recibo fica somente em
`.local-state/memory-review/`, fora do Git, com hashes de sessão/turno/corpus,
resultado e status da revisão. Não contém identificação bruta, prompts,
respostas, caminhos de transcript, fatos residenciais ou conteúdo da memória.
O diretório deve existir com modo `0700` e pertencer ao usuário que executa o
cliente. Se `.local-state/` for administrado por outro usuário, provisione
somente esse subdiretório; não altere permissões do restante do runtime.
Cada sessão tem somente seu checkpoint mais recente. Um turno novo precisa
revisar novamente. Reentrega do mesmo evento preserva o checkpoint, e recibos
de outros turnos não autorizam o encerramento. Alteração de memória após a revisão
exige nova conclusão do checkpoint. Revisão ausente ou inválida sinaliza
`MEMORY_REVIEW_FAILED`, sem loop de continuação ou sucesso silencioso. Interrupção explícita do usuário não é impedida.

O gate garante a exigência de um resultado de revisão no cliente onde roda;
não prova por código que toda seleção semântica é perfeita ou que `already_current`
foi avaliado corretamente. Não garante uma nota nova em cada conversa, nem deve.
O objetivo é guardar conhecimento útil confirmado e evitar lixo ou poisoning.

### Ativação por cliente

A instalação tem uma etapa interativa obrigatória: abra `/hooks`, revise a
nova definição e confirme `UserPromptSubmit` e `Stop` com `Installed = 1` e
`Active = 1`. Preserve
`PostToolUse` também aprovado. Não automatize nem altere os registros de confiança.
O CLI do bridge, CLI do host, extensão e aplicativo podem ter estados diferentes;
revisão no cliente errado não ativa o cliente que recebe as conversas.
Recarregue o cliente/App Server por seu procedimento de interface e abra uma
nova tarefa se ele ainda mantiver a definição anterior. Não reinicie serviços
residenciais para isso. Consulte `docs/LOCAL_AI_RTX_4070.md` para a revisão por
cliente e a [documentação oficial dos hooks](https://learn.chatgpt.com/docs/hooks).

Sem evidência dessa ativação, o estado é `IMPLEMENTED_NOT_ACTIVATED`, nunca
captura automática comprovada. `scripts/memory-review.test.mjs` valida o contrato
com eventos sintéticos; o teste de aceitação no cliente deve observar o contexto
interno, a conclusão antes da resposta final, ausência de prompt de continuação
no chat, nota útil persistida quando cabível e recuperação em outra sessão. A mera
execução manual do script não comprova entrega do evento `Stop` pelo cliente.

Historicamente, na aceitação de 2026-09-21 do fluxo antigo com continuação, o CLI do host foi aprovado pelo usuário correto:
ambos os hooks retornaram `enabled: true` e `trust: trusted`. Uma execução nova
em `workspace-write` acionou `Stop`, continuou automaticamente e registrou
`reviewed / no_durable_discovery`, encerrando sem inventar uma nota. A consulta
interna ao Git usa stdin ignorado: criar um pipe de entrada desnecessário
produzia `EPERM` nesse sandbox. Essa comprovação é específica do cliente
testado e não substitui a aprovação na extensão ou no bridge.

Essa aceitação histórica não comprova ativação do fluxo atual com
`UserPromptSubmit`; a nova definição precisa de revisão no cliente utilizado.
