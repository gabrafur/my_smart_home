# Instruções específicas do repositório Home Assistant

As políticas globais de modelo, primeira resposta, segurança e Local AI em
`~/.codex/AGENTS.md` já fazem parte desta conversa. Este arquivo contém somente
os desvios e contratos deste repositório para não duplicar contexto no startup.

## Pausa para troca manual do modelo

Em novas solicitações interativas, depois de informar o modelo e o nível de
reasoning recomendados, o Codex deve interromper o fluxo antes de executar a
tarefa. Ele deve aguardar o usuário trocar o modelo, se desejar, e enviar uma
mensagem contendo exatamente `feito`. Somente depois desse sinal pode continuar
a análise, usar ferramentas ou alterar arquivos.

Essa pausa é um gate de seleção do modelo, não uma aprovação genérica para
ações posteriores. O marcador `CODEX_UNATTENDED_WEEKLY_DOCS_REVIEW` continua
sujeito à exceção de revisão documental semanal descrita abaixo.

## Exceção de revisão documental semanal sem supervisão

O prompt versionado `scripts/weekly-docs-review.prompt.md` contém o marcador
exato `CODEX_UNATTENDED_WEEKLY_DOCS_REVIEW`. Quando ele aparecer na primeira
solicitação, é uma invocação não interativa pré-autorizada de
`scripts/weekly-docs-review.mjs`: ignore apenas o gate inicial de título,
melhoria de prompt, roteamento de modelo e `continue`; execute o prompt e
registre o resultado. Esta exceção não vale para solicitações interativas.

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

Neste projeto, para documentação, memória pública, arquivos candidatos, diffs,
logs, saídas de teste ou scanner e erros repetidos, selecione primeiro o menor
material relevante. A partir de aproximadamente 1.200 tokens estimados, chame
`local_ai_route` antes de enviar texto ao contexto principal e comprima somente
rotas elegíveis, sempre sujeitas a compressibilidade e economia esperada. Use
`summarize-document`, `summarize-memory`, `inspect-files`, `review-diff`,
`analyze-tests`, `summarize-log` ou `classify-error`, conforme o material.

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
