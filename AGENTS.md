# Instruções do repositório Home Assistant

Este arquivo é a única fonte persistente de instruções para o Codex neste
repositório. Não mantenha uma segunda cópia em `~/.codex/AGENTS.md` ou em outro
diretório global da máquina.

# Políticas gerais do Codex

## Prompt processing and model routing

Execute each user request directly. On the first user request of a conversation, include a concise suggested title and a recommendation for the cheapest suitable GPT-5.6 model and reasoning level. Do not require an initial confirmation or automatically rewrite the prompt.

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

---

## Confirmation and Continuation Policy

Do not impose an initial confirmation gate. Treat `continue` as ordinary user input unless confirmation is independently needed for a risky action.

---

## Local AI / RTX context compression

Use deterministic tools first. Do not run Local AI pre-analysis or status at
conversation startup. When deterministic preprocessing leaves a large,
non-sensitive, compressible candidate of roughly 1,200 tokens or more, use the
repository skill `.agents/skills/rtx-context-optimizer/SKILL.md` and the global
`local-ai-rtx` MCP server. Do not ask for confirmation merely to route eligible
context.

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

# Contratos específicos deste repositório

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

A revisão interativa do hook é uma etapa operacional obrigatória depois de um
novo clone ou instalação, da reconstrução do contêiner que executa o Codex e de
qualquer alteração em `.codex/hooks.json`. Abra o Codex CLI no diretório do
projeto, execute `/hooks` e não considere o roteamento habilitado até a tabela
mostrar `PostToolUse` com `Installed = 1` e `Active = 1`. Neste ambiente, abra o
CLI com `docker compose exec -w /workspace ai-bridge codex`. A aprovação não
pode ser automatizada nem substituída por opção de bypass; se estiver ausente,
instrua o usuário a revisar e habilitar o hook interativamente.

Consulte `docs/LOCAL_AI_RTX_4070.md` antes de alterar helper, hook, telemetria
ou cards Codex/RTX. A publicação LAN tem porta proxy restrita e não deve ter
seu escopo ampliado sem confirmação.
