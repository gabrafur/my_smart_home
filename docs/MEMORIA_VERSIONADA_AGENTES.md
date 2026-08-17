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
| `AGENTS.md` | instruções obrigatórias para agentes e política de manutenção |
| `MEMORY.md` | índice de compatibilidade curto para ferramentas e pessoas |
| `.codex/memories/projeto/indice.md` | índice canônico dos assuntos |
| `.codex/memories/<assunto>/<nome-descritivo>.md` | decisões temáticas reutilizáveis |

`.codex/memories/` é uma exceção pública, explícita e limitada dentro de
`.codex/`. Os demais conteúdos desse diretório continuam sendo runtime privado.
Cada memória temática deve ser Markdown, ter nome descritivo em kebab-case e
estar listada nos dois índices.

## Contexto de startup e retrieval

Memória do repositório é armazenamento de conhecimento, não payload automático
do prompt. A única peça sempre pequena o bastante para consulta inicial é o
índice canônico `.codex/memories/projeto/indice.md`; `MEMORY.md` existe para
compatibilidade e é conceitualmente redundante, não outra fonte canônica.

Para cada tarefa, o agente deve primeiro decidir se histórico do repositório é
necessário. Em caso negativo, não carrega memória temática. Em caso positivo,
usa primeiro busca determinística (`rg`, índice, nomes, headings e metadados),
recupera apenas os arquivos ou seções relevantes e prefere a documentação
operacional atual a uma anotação histórica duplicada.

Quando a recuperação relevante excede o orçamento direto já validado para
memória (1.200 tokens estimados com economia prevista de 700), a primeira
passagem é `summarize-memory` no Local AI. A saída estruturada deve preservar:
estado atual, decisões, restrições, bugs conhecidos, causas-raiz, valores de
configuração, pendências, avisos e referência à fonte. Não crie um cache ou
resumo persistente separado sem hash, referência de origem e detecção de
staleness; a implementação atual não cria esse cache.

`./scripts/local-ai/local-ai memory-audit` mede somente o startup observável:
arquivos `AGENTS.md` realmente incluídos, limite configurado, memória pública
do repositório e configuração de memória local. Tokens de instruções internas,
envelope da plataforma e conteúdo de memória privada não são expostos pelo
Codex e ficam como `null`, nunca como zero. O método de contagem acompanha cada
resultado; sem `tiktoken`, os valores são marcados como estimativa. No
inventário, o índice canônico é classificado como `ROUTING_ONLY`: ele orienta a
recuperação quando o histórico é necessário, mas não é payload automático de
startup.

Use `./scripts/local-ai/memory_context.py retrieve '<tema>' --query '<termos>'`
para selecionar arquivos pelo índice sem inferência. `materialize` só deve ser
usado em pipe para `summarize-memory`, nunca para despejar memória bruta no
contexto principal. Temas e consultas ignoram diferenças entre maiúsculas,
minúsculas e acentos; `all`, `project`, `projeto`, `repository` e `repositório`
selecionam o corpus público indexado antes do filtro de consulta. As decisões e
métricas resultantes contêm apenas contagens e tópicos; não guardam conteúdo,
caminhos de fonte, prompts ou resultados.

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
- ordem de autoridade em `AGENTS.md`;
- uso do caminho canônico no prompt semanal;
- headings duplicados nas instruções de agente;
- ausência de arquivos rastreados nos diretórios privados de runtime, com a
  única exceção de Markdown sob `.codex/memories/`.

Os testes negativos ficam em `scripts/public-memory-check.test.mjs`. O target
`make validate-public` também executa o checker documental, o self-test da
rotina semanal e `scripts/security-scan.sh`.

Detecção automática não prova ausência de toda informação pessoal em linguagem
natural. Por isso a revisão humana e o uso obrigatório de papéis lógicos
continuam fazendo parte do contrato.
