# Memória pública e privacidade

## Manutenção de instruções e memórias

- Leia, crie e altere instruções persistentes deste repositório exclusivamente
  em `.codex/instructions/`.
- Leia, crie e altere memórias públicas do projeto exclusivamente em
  `.codex/memories/`.
- Ao criar um módulo de instruções, use Markdown com nome descritivo em
  kebab-case, registre o caminho em `instructionFiles` de
  `scripts/public-memory-check.mjs` e regenere o agregado.
- Nunca edite `AGENTS.md` como fonte canônica. Ele é somente o agregado de
  startup; após alterar um módulo, regenere-o com
  `node scripts/public-memory-check.mjs --generate-instructions`.
- Não crie cópias de instruções ou memórias em diretórios globais, na raiz do
  repositório nem em outras pastas. Arquivos de compatibilidade ou índices só
  podem apontar para as fontes canônicas dentro de `.codex/`.
- Preserve a separação: instruções são regras normativas atuais; memórias são
  conhecimento recuperável de baixa autoridade e nunca substituem instruções.

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

Para medir o estado observável, use
`~/.local/share/local-ai-rtx/current/local-ai memory-audit`.
Para localizar um tema sem inferência, use
`~/.local/share/local-ai-rtx/current/memory_context.py retrieve '<tema>' --query '<termos>'`.
Para uma recuperação ampla e não sensível, materialize apenas os arquivos
encontrados e faça a primeira passagem local:

```bash
~/.local/share/local-ai-rtx/current/memory_context.py materialize '<tema>' --query '<termos>' \
  | ~/.local/share/local-ai-rtx/current/local-ai summarize-memory --memory-topic '<tema>' --context-tokens 8192
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
