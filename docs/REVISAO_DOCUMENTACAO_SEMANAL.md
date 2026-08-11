# Revisão semanal da documentação

[Português (principal)](REVISAO_DOCUMENTACAO_SEMANAL.md) · [English](WEEKLY_DOCUMENTATION_REVIEW.en.md)

O serviço Compose `docs-review-scheduler` executa uma revisão profunda do
repositório toda segunda-feira às **06:00 UTC** (03:00 em
`America/Sao_Paulo`). Ele usa o Codex já autenticado no volume do bridge,
atualiza documentação e os ajustes mínimos necessários para mantê-la verdadeira,
valida o resultado, cria um commit somente quando houver mudança e envia para
`origin/main` sem force push.

O horário é deliberadamente definido em UTC, portanto não muda com horário de
verão. A próxima execução aparece no log do serviço.

## O que a rotina revisa

O prompt versionado em `scripts/weekly-docs-review.prompt.md` exige:

- comparar os commits novos com código, Compose, scripts e documentação;
- manter português do Brasil como idioma principal e paridade com o inglês;
- remover instruções obsoletas, preencher lacunas de clone/build/restore e
  nunca inserir segredos ou dados físicos da residência;
- consultar fontes oficiais quando versões ou procedimentos puderem ter mudado;
- validar Compose com e sem o arquivo de exemplo, documentação, scanner de
  segurança, fluxos Node-RED e bridge;
- revisar o diff final e o conteúdo staged antes de um commit com prefixo
  `docs: weekly documentation review`;
- não reiniciar a stack residencial, não chamar endpoints, não enviar
  notificações e não acionar dispositivos físicos.

Não há commit vazio. Se uma validação falhar, o push não ocorre.

## Barreiras de segurança

O agendador recebe o workspace gravável e credenciais capazes de enviar ao
remoto Git, portanto deve ser tratado como serviço administrativo. Ele não
recebe o socket Docker e não deve ser publicado nem exposto.

As barreiras adicionais são:

- nenhuma porta publicada;
- autenticação Codex e chave SSH montadas como somente leitura na origem e
  copiadas para um diretório temporário privado;
- bootstrap curto como `root`, seguido de execução com o UID/GID não-root que
  possui o checkout e sem grupos suplementares; se esse UID ainda não existir
  na imagem, uma identidade local sem shell é criada apenas no container;
- branch obrigatória, árvore Git limpa e autenticação remota verificadas antes
  de iniciar;
- lock compartilhado `.git-backup.lock`, evitando concorrência com os scripts
  de atualização/backup;
- fast-forward obrigatório, sem rebase destrutivo, force push ou reescrita de
  histórico;
- tempo máximo padrão de três horas; o grupo inteiro de processos é encerrado
  quando o limite é excedido.

A chave SSH precisa ter permissão de push, mas deve ser exclusiva deste
repositório e ter o menor escopo disponível. O sufixo `:ro` no Compose protege
o arquivo original contra escrita pelo container; ele não transforma uma
credencial Git de escrita em credencial de leitura.

## Pré-requisitos e configuração

Antes de ativar:

1. autentique o Codex no `claude-bridge`, de modo que o volume
   `codex-bridge-auth` contenha `auth.json`;
2. crie uma chave SSH exclusiva com acesso de push ao repositório remoto;
3. registre a chave pública no provedor Git e mantenha a privada fora do Git;
4. tenha um arquivo `known_hosts` para o host Git;
5. rode o preparador, que preserva valores existentes e preenche UID/GID do
   checkout e caminhos SSH padrão quando encontrados:

```bash
node scripts/setup-node-red-security.mjs
```

Variáveis privadas em `.env`:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `WEEKLY_DOCS_REVIEW_DAY_UTC` | `1` | dia UTC, de 0 (domingo) a 6 (sábado) |
| `WEEKLY_DOCS_REVIEW_HOUR_UTC` | `6` | hora UTC |
| `WEEKLY_DOCS_REVIEW_MINUTE_UTC` | `0` | minuto UTC |
| `WEEKLY_DOCS_REVIEW_BRANCH` | `main` | branch permitida |
| `WEEKLY_DOCS_REVIEW_REMOTE` | `origin` | remoto usado no preflight e push |
| `WEEKLY_DOCS_REVIEW_TIMEOUT_MS` | `10800000` | limite de execução, em milissegundos |
| `REPO_UID` / `REPO_GID` | proprietário do checkout | identidade não-root de execução |
| `WEEKLY_DOCS_REVIEW_SSH_KEY` | sem padrão útil | caminho absoluto da chave privada |
| `WEEKLY_DOCS_REVIEW_KNOWN_HOSTS` | sem padrão útil | caminho absoluto de `known_hosts` |

Os valores de `.env` e o conteúdo das credenciais nunca devem ser impressos
em logs ou incluídos em chamados de suporte.

## Ativação e validação

```bash
node scripts/weekly-docs-review.mjs --self-test
docker compose --profile automation build docs-review-scheduler
docker compose --profile automation up -d docs-review-scheduler
docker compose --profile automation logs --tail=50 docs-review-scheduler
```

O log deve mostrar `next weekly documentation review` e uma data ISO. Teste o
checkout, a branch e a autenticação Git sem executar uma revisão:

```bash
docker compose --profile automation run --rm docs-review-scheduler \
  node scripts/weekly-docs-review.mjs --check
```

Esse preflight só passa com árvore limpa. Para solicitar uma execução manual
completa, sabendo que ela pode editar, commitar e enviar mudanças:

```bash
docker compose --profile automation run --rm docs-review-scheduler \
  node scripts/weekly-docs-review.mjs --run-now
```

Para parar ou remover apenas o agendador:

```bash
docker compose --profile automation stop docs-review-scheduler
docker compose --profile automation rm -f docs-review-scheduler
```

## Falhas e recuperação

Consulte primeiro:

```bash
docker compose --profile automation ps docs-review-scheduler
docker compose --profile automation logs --tail=200 docs-review-scheduler
git status --short
```

Uma árvore suja, branch diferente ou falha de autenticação faz a semana ser
ignorada com uma mensagem explícita. Se uma revisão falhar depois de editar,
as mudanças ficam no checkout para inspeção humana; as semanas seguintes
continuarão recusando execução até a árvore voltar a ficar limpa. Nunca descarte
essas mudanças automaticamente.

O agendamento é local e depende de o host Docker estar ligado. A documentação
oficial de [Scheduled tasks](https://learn.chatgpt.com/docs/automations)
também explica essa limitação para tarefas locais do Codex e informa que a
interface de gerenciamento fica no app/web, não na CLI ou extensão de IDE. Este
repositório usa um serviço Compose para que o horário e o prompt permaneçam
versionados e operáveis no Raspberry Pi.
