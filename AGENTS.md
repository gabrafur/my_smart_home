# Instruções do repositório Home Assistant

Este arquivo é a única fonte persistente de instruções para o Codex neste
repositório. Não mantenha uma segunda cópia em `~/.codex/AGENTS.md` ou em outro
diretório global da máquina.

# Políticas gerais do Codex

## Prompt processing and model routing

Execute each user request directly. On the first user request of a conversation, include a concise suggested title and a recommendation for the cheapest suitable GPT-5.6 model and reasoning level. Do not require an initial confirmation or automatically rewrite the prompt.

---

## Prompt Improvement Policy

When the user explicitly asks for prompt improvement, rewrite the original request while preserving its intent, scope, and supplied technical context.

Improve the prompt where useful by clarifying:

* objective;
* current or observed behavior;
* desired behavior;
* investigation expectations;
* scope;
* constraints;
* acceptance criteria;
* validation steps;
* regression checks;
* safety expectations;
* reversibility or rollback expectations;
* documentation expectations;
* expected final report.

For debugging or investigation tasks, prefer an execution flow such as:

1. understand the existing implementation and architecture;
2. confirm or reproduce the reported behavior;
3. trace the relevant data or execution path;
4. identify the root cause;
5. implement the smallest reliable correction;
6. validate the correction;
7. check for regressions;
8. document findings and changes.

For implementation tasks, make the desired result and validation criteria explicit.

For infrastructure, Home Assistant, Node-RED, data engineering, CI/CD, Git, integrations, networking, containers, operating systems, or production-adjacent work, favor:

* understanding the current architecture before modifying it;
* root-cause fixes instead of symptom masking;
* reuse of existing components and conventions;
* incremental and reversible changes;
* preservation of existing behavior unless explicitly requested otherwise;
* validation after modifications;
* testing the complete affected execution path when practical;
* avoiding destructive operations when a safer alternative exists.

Do not arbitrarily expand the task.

Do not invent repository structure, filenames, entity IDs, branches, APIs, services, credentials, architecture, business rules, tools, infrastructure, or technical requirements that are not provided or reasonably implied.

Do not convert optional ideas into mandatory requirements.

When useful improvements beyond the original request are identified, keep them clearly separated as optional suggestions.

Correct technical terminology when useful without changing the user's intended meaning.

If the original request is already precise, improve it lightly instead of making it unnecessarily verbose.

The improved prompt should be detailed enough that, after confirmation, it can be treated as the execution specification without needing to reinterpret the original request.

---

## Copy-Safe Improved Prompt Output Policy

The improved prompt must be easy to copy directly from the Codex response and paste into another Codex or ChatGPT conversation without losing its Markdown structure.

When providing an improved prompt, output it inside exactly one fenced code block.

The content inside that block must contain the actual Markdown source of the improved prompt, not rendered Markdown.

This means that Markdown syntax such as:

* `#` and `##` headings;
* numbered lists;
* bullet lists;
* checklists;
* indentation;
* inline code;
* paths;
* commands;
* code blocks;
* URLs;
* quoted values;

must remain visible literally inside the copyable block.

Do not use blockquotes (`>`) as the outer container for the improved prompt.

Do not split the improved prompt across multiple outer code blocks merely for presentation.

Do not put explanations, model recommendations, notes, or commentary inside the improved-prompt block unless they are intentionally part of the task specification.

Do not escape normal Markdown characters merely to make the rendered response look different.

Preserve meaningful blank lines and indentation.

### Fence safety

The outer fence used for the improved prompt must be longer than any consecutive backtick sequence contained inside the improved prompt.

Prefer four backticks for the outer fence:

````text
# Objective

Investigate the reported issue.

## Validation

Run the relevant tests.

```bash
pytest tests/
```
````

If the improved prompt itself contains a four-backtick sequence, use five backticks for the outer fence instead.

In general:

> outer fence length = longest internal backtick sequence + at least one

Use `markdown` or `text` as the outer code-block language when useful.

The content copied from the block must be immediately usable as a new chat prompt without cleanup.

### Prompt structure

For substantial engineering tasks, prefer a structure similar to:

# Objective

Describe the result that must be achieved.

# Context

Preserve relevant information supplied by the user.

# Current Behavior

Describe the observed issue when applicable.

# Desired Behavior

Describe the expected outcome.

# Investigation

Explain what should be inspected or verified before modifications.

# Implementation Requirements

Describe required changes and constraints.

# Validation

Describe tests and checks that must demonstrate correctness.

# Regression Checks

Describe existing behavior that must remain functional.

# Git / Delivery Requirements

Include branch, commit, PR, or repository requirements only when relevant or requested.

# Documentation

Describe documentation expectations when relevant.

# Final Report

Describe what the executing agent should report when finished.

Do not mechanically add every section.

Use only sections that make the task clearer.

For simple tasks, keep the improved prompt compact.

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

---

## Confirmation and Continuation Policy

Do not impose an initial confirmation gate. Treat `continue` as ordinary user input unless confirmation is independently needed for a risky action.

---

## Local AI / RTX Context Compression Policy

There is no global prompt hook and no Local AI pre-analysis before work starts.
Availability is checked lazily through the global `local-ai-rtx` MCP server
only when deterministic preprocessing identifies a large eligible candidate.
This requires no user confirmation or special follow-up message.

Do not run the full SSH/WSL/GPU availability check again in the same conversation unless:

* a Local AI request fails;
* it times out;
* the endpoint refuses a connection;
* the selected local model becomes unavailable.

At most once, revalidate and retry the failed local request.

After that, fall back normally without loops or repair attempts.

When available, machine-local configuration supplies the remote Ollama endpoint and default model.

Never silently use `127.0.0.1:11434` in this environment.

The configured endpoint is the only default, while explicit CLI options and `LOCAL_AI_ENDPOINT` / `LOCAL_AI_MODEL` remain overrides.

`LOCAL_AI_ENABLED=0` disables Local AI for a session.

`LOCAL_AI_FORCE=1` is diagnostic only and does not authorize unsuitable delegation.

`/home/gabriel/.local/bin/local-ai-preflight --json` is the manual health check.

Keep deterministic tools first, including:

* `rg`;
* Git;
* parsers;
* tests;
* linters;
* type checkers;
* SQL;
* project scripts.

The global `local-ai-rtx` MCP server is the canonical Local AI interface. Use
it as the default first-pass route only when bounded work will materially
compress context or cheaply classify it, such as:

* long logs or test output;
* large diffs;
* repetitive extraction;
* relevant-file triage;
* strict structured JSON generation.

### Automatic local delegation

Do not call `local_ai_status` at conversation start. At the first large,
non-sensitive eligible candidate, call it lazily and make the routing decision
automatically. Do not ask the user to enable Local AI, repeat a special prompt,
select a model, or run a helper command.

Before placing a large, non-sensitive body of text into the OpenAI/Codex context,
use deterministic preprocessing and select only the relevant material. For a
selected body of roughly 1,200 OpenAI tokens (about 4,800 ordinary text
characters) or more, call `local_ai_route` with metadata. When it returns an
eligible, materially beneficial route, call `local_ai_compress_context` and
give the primary model only its bounded structured result. Skip inference when
the material is already small or deterministic tools resolve it directly.

Choose the MCP `task_type` from the evidence at hand:

* `review-diff` for a substantial Git diff;
* `summarize-log` for long logs, stack traces, or command output;
* `analyze-tests` for substantial test failures;
* `inspect-files` for a bounded set of candidate source files;
* `classify-error` for repeated or noisy errors.
* `summarize-document` for extensive README, contracts, installation guides,
  and other public documentation;
* `summarize-memory` only after deterministic retrieval selects relevant
  public thematic memory.

Pass only the relevant bounded input to the MCP, consume its concise JSON result,
and continue the primary task from that result. Do not paste the full raw input
into the primary-model context when the local result is sufficient. This is the
default behavior for every eligible task and requires no extra wording from the
user.

When orchestrating `exec_command` through code mode, keep a potentially large
raw result inside the orchestration call until routing completes. Do not emit it
with `text(...)` first. Project-scoped `PostToolUse` hooks may enforce this as a
guardrail, but the primary agent must still validate that the structured result
preserved the needed facts.

For short requests or evidence that deterministic tools can answer directly,
skip inference. Never create dummy GPU work merely to change dashboard state.
The telemetry-backed dashboard is updated automatically whenever a local job is
actually useful and runs.

Use precise language for Local AI state. `local_ai_status`, RTX availability,
`local_ai_route` and `LOCAL_AI_ELIGIBLE` do not prove that local inference ran.
Say that the RTX was actually used only when `local_ai_compress_context`
completed successfully and returned a non-empty `job_id` with
`telemetry_recorded=true`, or when a canonical PostToolUse replacement carries
equivalent `executed=true` and `success=true` metadata. Otherwise say only that
the RTX was available, evaluated, eligible, skipped, unavailable or failed, as
the observed state warrants.

For the legacy MCP field `deterministic_preprocessing_available`, `true` means
that deterministic work completely resolves the result and no LLM
interpretation remains. Do not set it merely because deterministic collection
or filtering happened. A large textual result that still needs interpretation
may be eligible for Local AI post-processing after deterministic collection.

Return only concise, relevant, structured results to the selected GPT-5.6 model.

Treat Local AI as non-authoritative.

Do not delegate to Local AI:

* final architecture decisions;
* destructive or irreversible operations;
* production decisions;
* migrations;
* final RCA;
* final PR approval.

If Local AI is unavailable, keep the selected Luna/Terra/Sol routing unchanged and continue normally.

Never automatically:

* install;
* restart;
* wake;
* repair;
* reconfigure;

Local AI infrastructure.

The Local AI helper records metadata-only private telemetry when present.

It must not persist:

* prompts;
* source input;
* model output;
* secrets.

`OpenAI tokens avoided` means the measured or explicitly estimated reduction between input context processed locally and the concise result passed onward.

It is not a claim that local inference tokens equal OpenAI tokens or money saved.

<!-- BEGIN CODEX LOCAL AI RTX -->
## Global Local AI / RTX

The global `local-ai-rtx` MCP server is the canonical Local AI interface. Do
not classify Local AI as unavailable merely because a repository helper or
shell command is inaccessible.

For large non-sensitive logs, diffs, test output, documentation, file triage,
or retrieved public memory:

1. use deterministic preprocessing and select only relevant material;
2. use `local_ai_route` with metadata;
3. when its expected benefit is material, use `local_ai_compress_context`;
4. give the primary model only the condensed relevant result.

`local_ai_status` runs lazily at the first eligible candidate; call it again
only before declaring Local AI unavailable after an observed failure.
Local AI is optional and failures must fall back normally;
they never justify changing the selected GPT-5.6 model or repairing GPU/Ollama
infrastructure automatically.
<!-- END CODEX LOCAL AI RTX -->

# Contratos específicos deste repositório

## Início imediato

Em novas solicitações interativas, informe a recomendação de modelo prevista
pela política global e prossiga imediatamente. Não imponha confirmação, a
palavra `feito` ou qualquer pré-análise antes de começar o trabalho.

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

Prefira ferramentas determinísticas (`rg`, Git, parsers, testes, linters, type
checkers, SQL e scripts do projeto) a qualquer LLM. O MCP global
`local-ai-rtx` é a interface canônica e padrão para a primeira passagem local;
use `local_ai_status`, `local_ai_route` e, quando elegível,
`local_ai_compress_context`. O helper `./scripts/local-ai/local-ai` permanece
somente para diagnósticos e testes locais do projeto.

A skill canônica desse fluxo é
`.agents/skills/rtx-context-optimizer/SKILL.md`. Ela é versionada e descoberta
no escopo deste repositório; não mantenha outra cópia em
`~/.agents/skills/`.

Neste projeto, para documentação, memória pública, arquivos candidatos, diffs,
logs, saídas de teste ou scanner e erros repetidos, selecione primeiro o menor
material relevante. A partir de aproximadamente 1.200 tokens estimados, chame
`local_ai_route` antes de enviar texto ao contexto principal e comprima somente
rotas elegíveis, sempre sujeitas a compressibilidade e economia esperada. Use
`summarize-document`, `summarize-memory`, `inspect-files`, `review-diff`,
`analyze-tests`, `summarize-log` ou `classify-error`, conforme o material.

Não existe preflight global no envio do prompt. A primeira verificação de
disponibilidade é preguiçosa: ocorre automaticamente somente quando uma saída
grande e elegível aparece, antes de `local_ai_route`, e no máximo uma vez por
conversa enquanto as chamadas funcionarem. O hook `PostToolUse` deste projeto é
uma proteção complementar para saídas grandes de `Bash`; ele não exige ação do
usuário. Em chamadas por code mode, não exponha deliberadamente o corpo bruto
com `text(...)` antes de concluir o roteamento.

A revisão interativa do hook é uma etapa operacional obrigatória depois de um
novo clone ou instalação, da reconstrução do contêiner que executa o Codex e de
qualquer alteração em `.codex/hooks.json`. Abra o Codex CLI no diretório do
projeto, execute `/hooks` e não considere o roteamento habilitado até a tabela
mostrar `PostToolUse` com `Installed = 1` e `Active = 1`. Neste ambiente, abra o
CLI com `docker compose exec -w /workspace ai-bridge codex`. A aprovação não
pode ser automatizada nem substituída por opção de bypass; se estiver ausente,
instrua o usuário a revisar e habilitar o hook interativamente.

Para contratos, schemas, documentação bilíngue e mudanças que atravessam muitos
arquivos, gere primeiro um inventário determinístico derivado (arquivos, campos,
comandos, módulos, headings e nomes de testes) e roteie esse inventário com
`summarize-document` ou `inspect-files`. Esse formato também é elegível quando
o código bruto seria repetitivo: a saída local serve para crosswalk inicial,
checagem de cobertura documental e triagem de pendências.

Não considere uma compressão bem-sucedida apenas porque a inferência terminou.
Se o JSON omitir requisitos, arquivos ou riscos críticos esperados, descarte-o
e use a evidência determinística; registre a chamada, mas não alegue preservação
de informação. Prefira inventário derivado a blocos extensos de código, pois o
modelo local demonstrou retenção melhor nesse formato.

Não use a RTX para atualizar painel, descobrir palavra em arquivo, dados
estruturados que uma ferramenta resolve, segredos, decisões finais,
migrações, operações destrutivas ou ações de produção. Se Local AI falhar,
revalide e tente uma vez no máximo; depois siga pelo fallback normal sem loops.

Consulte `docs/LOCAL_AI_RTX_4070.md` antes de alterar helper, hook, telemetria
ou cards Codex/RTX. A publicação LAN tem porta proxy restrita e não deve ter
seu escopo ampliado sem confirmação.
