# Instruções do repositório Home Assistant

Este arquivo é a única fonte persistente de instruções para o Codex neste
repositório. Não mantenha uma segunda cópia em `~/.codex/AGENTS.md` ou em outro
diretório global da máquina.

# Políticas gerais do Codex

## Prompt processing and model routing

Execute each user request directly. Do not require an initial confirmation or automatically rewrite the prompt.

---

## Prompt improvement

Do not rewrite prompts automatically. When the user explicitly asks to improve,
rewrite, structure, or make a prompt copy-safe, use the repository skill
`.agents/skills/prompt-improver/SKILL.md`. Preserve the request's intent, scope,
constraints, technical context, and optionality.

---

## Chat Title Policy

Suggest one concise title only when the user explicitly asks for one.

The title should:

* describe the actual task;
* normally use 3 to 8 words;
* be easy to identify later in conversation history;
* use the same language as the user's request unless there is a strong reason not to.

Prefer specific titles such as:

* `Corrigir bateria e consumo do Creta`
* `Refatorar contexto de segurança Node-RED`
* `Investigar crescimento de storage Raspberry`
* `Adicionar observabilidade ao pipeline Grow`

Avoid generic titles such as:

* `Fix issue`
* `New task`
* `Code changes`
* `Investigation`

Do not attempt to rename the conversation automatically.

The title is only a suggestion so the user can rename the Codex chat manually.

---

## Model Routing Policy

Use the cheapest option with a high probability of completing the task correctly, considering deterministic tools and local scripts before model escalation.

### GPT-5.6 Luna (`gpt-5.6-luna`)

Use for:

* clear and small tasks;
* localized changes;
* repetitive or mechanical work;
* easily validated transformations;
* extraction;
* simple documentation;
* small code changes;
* boilerplate;
* simple tests.

Prefer `low`.

Use `medium` for ordinary bounded work.

Use `high` only with concrete justification.

### GPT-5.6 Terra (`gpt-5.6-terra`)

Use for:

* substantial engineering;
* multi-file changes;
* debugging;
* implementation plus tests;
* refactoring;
* repository exploration;
* Git;
* CI/CD;
* infrastructure;
* integrations;
* moderate architecture;
* PR analysis.

Prefer `medium`.

Use `high` for multi-step debugging or architecture.

Use `xhigh` only for unusually difficult problems.

### GPT-5.6 Sol (`gpt-5.6-sol`)

Use for:

* materially difficult or ambiguous work;
* unresolved complex debugging;
* broad repository analysis;
* high-risk migrations;
* security-sensitive reasoning;
* complex architecture;
* multi-system root-cause investigation;
* cases where Terra has demonstrated limitations.

Prefer `medium` for substantial but clear work.

Use `high` for complex work.

Use `xhigh` for very difficult work.

Use `max` only exceptionally.

Do not select a stronger model merely because a task:

* involves code;
* has a long prompt;
* references a large repository;
* may touch many files.

For large but deterministic extraction or transformation, keep the cheapest sufficient option.

Consider deterministic tools, local scripts, and local AI/Ollama when available before Luna, Terra, or Sol.

Do not create, repair, install, restart, or reconfigure Ollama infrastructure as part of model routing.

The reviewed `scripts/local-ai/recover-endpoint.mjs` is the only exception. If
machine-private configuration enables it, an MCP invocation may send
Wake-on-LAN and perform at most two idempotent attempts to start the existing
WSL/Ollama service and reconcile the exact configured `11435` portproxy. It
must preserve strict SSH host verification and the existing firewall scope;
it never installs software, binds a wildcard listener, reboots the host or
runs for passive dashboard health polling. After two failures, use the normal
OpenAI fallback. Do not reproduce these recovery mutations manually as part of
ordinary model routing.

---

## Confirmation and Continuation Policy

Do not impose an initial confirmation gate. Treat `continue` as ordinary user input unless confirmation is independently needed for a risky action.

---

## Commit message policy

Use Conventional Commits in English for every commit created by Codex, following
the style of `fix: make Codex card loading deterministic`:

```text
<type>[(optional-scope)][!]: <imperative description>
```

- Use one of `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`,
  `perf`, or `revert`.
- Start the description with a lowercase word, use the imperative mood, keep the
  complete subject to at most 72 characters, and do not end it with punctuation.
- Add a lowercase scope only when it makes the affected subsystem materially
  clearer. Use `!` and a `BREAKING CHANGE:` footer for breaking changes.
- Keep the subject focused on one change. Put motivation, migration notes, and
  verification details in the body when they are useful.
- Before committing, run `node scripts/commit-message-check.mjs --subject
  '<subject>'`. After committing, `make validate-commit-message` validates
  `HEAD` and `make validate-public` includes the same check.
- Keep the versioned hooks enabled with `make install-git-hooks`. Never bypass
  the `commit-msg` hook with `--no-verify` for a commit created by Codex.

Do not imitate legacy commit subjects that predate this policy. Automated
commits made by repository scripts must follow the same format.

---

## Local AI / RTX context compression

Use deterministic tools first. Do not run Local AI pre-analysis or status at
conversation startup. When deterministic preprocessing leaves a large,
non-sensitive, compressible candidate of roughly 1,200 tokens or more, use the
repository skill `.agents/skills/rtx-context-optimizer/SKILL.md` and the global
`local-ai-rtx` MCP server. Do not ask for confirmation merely to route eligible
context.

Apply this decision to every user request. Isolate the smallest candidate.
No generative context-compression profile is promoted. For logs, use the
versioned deterministic fact extractor; send raw context if it cannot preserve
critical signals or reduce safely. All MCP compression profiles fail closed
until versioned evidence and routing promote one. `PostToolUse` may replace
large `Bash` logs deterministically, but not prompts or nested Code Mode calls.

The residual `structured_extraction` canary is not context compression. It is
off by default; requires `LOCAL_AI_QUALITY_PIPELINE_ENABLED` and
`LOCAL_AI_STRUCTURED_EXTRACTION_ENABLED`; runs only on parser residuals in its
stable 10% bucket; validates source-anchored fields; and otherwise uses GPT.

Never send secrets or private runtime to Local AI and never delegate final
architecture, security, production, migration, destructive-operation, RCA, or
PR approval decisions. Use only the configured endpoint; never silently use
`127.0.0.1:11434`. On failure, revalidate and retry at most once, then continue
with the selected primary model without repairing, restarting, installing, or
reconfiguring Local AI infrastructure.

Do not expose a large raw tool result before routing finishes. Claim actual RTX
use only after successful compression returns the required execution and
telemetry metadata. Local telemetry is metadata-only and must never persist
prompts, source input, model output, or secrets.

MCP/CLI success proves only inference. Historical operational claims require a
`PostToolUse` replacement or `code-mode-orchestrator-v1` receipt bound to the
same job and input size and matched by `job_id`.
Do not create compression receipts while every generative profile is unpromoted.

Count context reduction as useful only when the task-specific fidelity gate
accepts the result. A rejected or discarded Local AI result must fall back to
the original context and record zero useful tokens avoided, regardless of how
small the rejected JSON was.

# Contratos específicos deste repositório

## Proteção obrigatória do host residencial

Este checkout roda no servidor ativo da casa inteligente. Disponibilidade de
SSH, Home Assistant, Node-RED, MQTT e automações residenciais tem prioridade
sobre auditorias, builds e testes.

- Nunca execute duas validações pesadas, instalações NPM, clean-rooms ou suítes
  amplas em paralelo neste host.
- Antes de uma validação ampla, confira `uptime`, `free -h` e `df -h /`; não a
  inicie com menos de 2 GiB disponíveis, filesystem acima de 85% ou pressão já
  elevada.
- Use o alvo canônico, que reduz prioridade de CPU e I/O. Não contorne
  `scripts/run-resource-safe.sh` para acelerar a tarefa.
- Faça checks direcionados primeiro. Execute no máximo uma validação ampla no
  host por ciclo de mudança; repetições e clean-room devem ir para CI ou máquina
  isolada com limites de recursos.
- Interrompa imediatamente a carga iniciada pelo agente se SSH, dashboard ou
  serviços residenciais degradarem. Nunca reinicie o host ou a stack para
  concluir uma tarefa de repositório.
- Não use `make -j`, concorrência de testes ou múltiplos agentes neste host.

Essas regras também valem quando o usuário pede persistência ou validação
completa: persistência não autoriza sacrificar a disponibilidade residencial.

## Formatação numérica dos dashboards

Todo número apresentado ao usuário em dashboards deve seguir a convenção
pt-BR: `.` como separador de milhar e `,` como separador decimal. Preserve os
estados canônicos como números para cálculos, histórico e automações; não grave
valores pré-formatados como estado de sensor. Sensores numéricos usados por
cards nativos devem declarar `unit_of_measurement` e `state_class` adequados
para que o frontend aplique a localização. Valores numéricos renderizados em
Markdown/Jinja devem importar e usar
`custom_templates/formatting.jinja::format_number_ptbr`. Ao criar ou alterar
um dashboard, atualize os testes de regressão que verificam esse contrato.

## Exceção de revisão documental semanal sem supervisão

O prompt versionado `scripts/weekly-docs-review.prompt.md` contém o marcador
exato `CODEX_UNATTENDED_WEEKLY_DOCS_REVIEW`. Quando ele aparecer na primeira
solicitação, é uma invocação não interativa pré-autorizada de
`scripts/weekly-docs-review.mjs`: execute o prompt e registre o resultado sem
interação. Solicitações interativas também começam imediatamente, mas não
herdam outras autorizações específicas dessa revisão semanal.

## Memória pública do projeto: retrieval, não preload

`.codex/memories/<assunto>/<nome-descritivo>.md` é o local canônico para
memória pública, durável e versionada. O índice canônico é
`.codex/memories/projeto/indice.md`; `MEMORY.md` é somente um índice curto de
compatibilidade. Documentação operacional atual continua sendo a fonte de
verdade para comportamento corrente.

Ao haver divergência, aplique esta ordem de autoridade:

1. código e configuração executável atual;
2. testes e contratos executáveis;
3. documentação operacional atual;
4. decisões arquiteturais vigentes;
5. memória versionada dos agentes.

Corrija memória obsoleta em vez de mudar o sistema para confirmá-la. Uma
decisão histórica só permanece quando é explicitamente histórica e aponta para
a fonte que a substituiu. O contrato completo está em
`docs/MEMORIA_VERSIONADA_AGENTES.md`.

Para cada tarefa, antes de carregar documentação ou memória de projeto:

1. determine se ela realmente depende de histórico do repositório;
2. se não depender, registre `memory-route <topico> --outcome skipped` somente
   quando a telemetria for apropriada e siga sem recuperar memória;
3. se depender, consulte primeiro o índice e use `rg`, nomes de arquivo,
   headings, `find` e metadados para localizar somente o tema necessário;
4. leia apenas os arquivos/seções necessários, preferindo a documentação
   canônica atual a notas duplicadas ou históricas;
5. para recuperação grande, não coloque o corpo bruto no contexto principal:
   use a RTX com `summarize-memory` e passe adiante apenas o JSON estruturado;
6. não carregue RCAs, arquitetura, histórico ou memória de outros subsistemas
   em tarefas simples e não leia `.agent-history/`, `.claude/`, conteúdo de
   runtime não público de `.codex/` ou `.local-secrets/` como fonte automática.

O fluxo determinístico é:

```text
tarefa -> índice/rg -> memória temática mínima -> Local AI se grande -> JSON estruturado -> modelo principal
```

Para medir o estado observável, use `./scripts/local-ai/local-ai memory-audit`.
Para localizar um tema sem inferência, use
`./scripts/local-ai/memory_context.py retrieve '<tema>' --query '<termos>'`.
Para uma recuperação ampla e não sensível, materialize apenas os arquivos
encontrados e faça a primeira passagem local:

```bash
./scripts/local-ai/memory_context.py materialize '<tema>' --query '<termos>' \
  | ./scripts/local-ai/local-ai summarize-memory --memory-topic '<tema>' --context-tokens 8192
```

`summarize-memory` deve preservar estado atual, decisões, restrições, bugs,
causas-raiz, valores de configuração, pendências, avisos e referências de
origem. Seu resultado é evidência não autoritativa; decisões de arquitetura,
segurança, produção e revisão final continuam no modelo principal. Não crie
cache ou uma segunda cópia resumida da memória. A telemetria registra apenas
contagens e decisões, nunca conteúdo, caminhos de fonte, prompts ou saídas.

O limite direto de recuperação segue o perfil já validado de `summarize-memory`
(1.200 tokens estimados e 700 de economia prevista). Uma sobrecarga de memória
é um sinal de candidato grande enviado diretamente ao modelo principal; não é
uma alegação de relevância semântica não mensurada.

## Manutenção de memória e privacidade

- Nomeie cada arquivo temático de modo descritivo em kebab-case; nunca use
  `memoria.md` genérico. Todo novo tema deve constar nos dois índices.
- Registre somente decisões reutilizáveis, invariantes, riscos recorrentes,
  recovery e razões para comportamento não óbvio; mantenha notas concisas e
  verificadas contra código, testes ou documentação atual.
- Use somente papéis lógicos, como `resident_primary`, `mobile_primary`,
  `vehicle_primary`, `garage_gate`, `exterior_light` e `security_panel`.
  Nunca registre nomes, identificadores privados, rotinas, logs, transcripts,
  localizações, credenciais ou autorizações temporárias.
- Prompts e conversas do bridge ficam em `.agent-history/turns.jsonl`: são
  dados privados, não devem ser versionados nem usados como documentação
  automática. Se um conhecimento só existir ali, responda
  `knowledge_not_versioned` e exija uma decisão pública sanitizada.
- Ao revisar ou continuar uma conversa Home Assistant explicitamente pedida,
  localize-a com `node scripts/agent-history.mjs list`, carregue-a com
  `node scripts/agent-history.mjs show <conversation_id> [claude|codex]` e não
  reproduza segredos.
- Após alterar instruções, índices ou memórias, execute
  `make validate-public`.

## Local AI do projeto

O procedimento canônico fica em
`.agents/skills/rtx-context-optimizer/SKILL.md`; não mantenha cópia em
`~/.agents/skills/`. O MCP global `local-ai-rtx` é a interface de inferência e
`./scripts/local-ai/local-ai` permanece somente para diagnóstico e testes do
projeto.

Revise o hook interativamente após clone, instalação, reconstrução do cliente
Codex ou mudança em `.codex/hooks.json`. A confiança é específica por cliente:
aprovar pelo CLI do `ai-bridge` não ativa o hook na extensão do VS Code, nem o
inverso. Execute `/hooks` no cliente que recebe os prompts e exija
`PostToolUse` com `Installed = 1` e `Active = 1`. No bridge, use
`docker compose exec -w /workspace ai-bridge codex`. Na extensão, use
`./scripts/local-ai/review-vscode-hooks.sh` no host; após aprovar ou atualizar,
execute `Developer: Reload Window` e abra uma conversa nova. Nunca automatize
nem contorne essa aprovação.

Consulte `docs/LOCAL_AI_RTX_4070.md` antes de alterar helper, hook, telemetria
ou cards Codex/RTX. A publicação LAN tem porta proxy restrita e não deve ter
seu escopo ampliado sem confirmação.
