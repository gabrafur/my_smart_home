# Codex + Local AI com RTX 4070

## Finalidade e escopo

Esta integração acrescenta inferência local como **primeira passagem limitada**
para o Codex. Ela resume material grande e não sensível, classifica falhas e
faz revisão estruturada de diffs antes que o modelo principal receba contexto.
O Codex/OpenAI continua responsável por decisões, integração de evidências,
segurança, mudanças destrutivas e revisão final.

O guia descreve o estado operacional validado em 2026-08-16 e também permite
recriá-lo em um fork. Endereços, usuários e caminhos de chaves reais ficam na
configuração privada de cada máquina, nunca neste repositório.

## Arquitetura validada

```text
Host Codex / DietPi
  └─ MCP local-ai-rtx + roteamento preguiçoso + telemetria privada
       │ LAN, TCP 11435
       ▼
Host Windows com GPU
  └─ portproxy do Windows (GPU_HOST:11435)
       │ loopback, TCP 11434
       ▼
WSL2 Ubuntu com systemd
  └─ Ollama
       ▼
NVIDIA GeForce RTX 4070
```

O caminho publicado é somente `http://GPU_HOST:11435`. A porta `11434` é
interna ao host Windows/WSL e não deve ser usada como endpoint do cliente LAN.
Tailscale e ZeroTier não participam desse fluxo.

### Evidência de inferência

Uma geração real com `qwen2.5-coder:7b` registrou:

| Medida | Baseline | Durante a inferência |
| --- | ---: | ---: |
| GPU | NVIDIA GeForce RTX 4070 | NVIDIA GeForce RTX 4070 |
| Utilização da GPU | 14% | 99% (amostras posteriores: até 89%) |
| VRAM usada | 1.378 MiB | 6.434 MiB (amostra posterior: 6.342 MiB) |
| VRAM adicional aproximada | — | 5.056 MiB / 4,94 GiB |
| VRAM física | 12.282 MiB | cerca de 52% ocupada na maior amostra |
| `ollama ps` | sem modelo ativo | `100% GPU` |
| CPU offload | — | não observado |

A primeira execução levou 11,623 s a 86,46 tok/s; uma validação posterior
registrou 92,64 tok/s. Isso confirma o encadeamento **Codex/local-ai → Ollama
remoto → WSL2 → RTX 4070**, e não apenas a presença de CUDA ou do binário
Ollama.

## Componentes e responsabilidades

| Camada | Responsabilidade | Arquivo/configuração |
| --- | --- | --- |
| Windows + WSL2 | manter Ollama e a GPU disponíveis | configuração privada do host de GPU |
| Portproxy e firewall | publicar somente a porta LAN restrita | regras privadas do Windows |
| `local-ai` | executar tarefas limitadas e emitir JSON/telemetria | `scripts/local-ai/` |
| Política do Codex | decidir quando uma primeira passagem agrega valor | `AGENTS.md` e hook de projeto `.codex/hooks.json` |
| Bridge | expor somente resumo de uso e estado de job | `ia-bridge/server.js`, `ia-bridge/usage.js` |
| Home Assistant | mostrar uso do Codex e RTX separadamente | `homeassistant/packages/codex_usage.yaml` e dashboard |

Os modelos disponíveis podem mudar por instalação. O modelo padrão selecionado
após o A/B com gate de qualidade é `qwen2.5-coder:14b`: cumpriu os quatro
schemas e não exibiu CPU offload. A primeira leitura foi 51,5% bruta do custo
do verificador; a rodada líquida com autoavaliação aprovou 1/4 casos e mediu
23,2%. Em 2026-08-24, o benchmark v3 repetiu as quatro fixtures três vezes com
`qwen3:8b` como verificador independente e rejeitou 12/12 resultados, medindo
0,0% de redução útil ponderada e mediana. Assim, 23,2% permanece histórico e
não é previsão operacional nem evidência independente. O registro comparativo e a
reavaliação operacional estão em
[`LOCAL_AI_BENCHMARK_2026-08-16.md`](LOCAL_AI_BENCHMARK_2026-08-16.md). A
reavaliação restaurou o endpoint e comparou 7B, 14B e `qwen3.5:9b` com o mesmo
critério conservador. Outros modelos já instalados podem ser avaliados quando
uma tarefa justificar; instalação ou troca não faz parte do roteamento
automático.

## Rede, segurança e inicialização

No host de GPU, configure o Ollama no WSL para aceitar a interface desejada
(`OLLAMA_HOST=0.0.0.0:11434` no ambiente validado), mas publique para a LAN
apenas uma porta distinta com portproxy:

```text
GPU_HOST:11435 -> 127.0.0.1:11434 -> Ollama no WSL2
```

O firewall do Windows deve permitir TCP em `GPU_HOST:11435` somente a partir
do host Codex (`CODEX_HOST`). Regras LAN diretas para `11434`, ou regras que
aceitem qualquer origem, devem permanecer desativadas. Não exponha a porta em
um roteador, VPN pública ou internet.

O WSL validado usa `networkingMode=mirrored`, firewall ativo, DNS tunneling,
auto-proxy e `hostAddressLoopback`. O `ollama.service` fica habilitado no
systemd do WSL. Quando a máquina está ligada ou responde ao Wake-on-LAN, uma
chamada MCP pode iniciar o WSL/Ollama e restaurar a publicação restrita sem
depender de logon interativo.

## Configuração do cliente Codex

Cada máquina que executa Codex mantém sua configuração fora do Git, por
exemplo em `~/.config/codex/local-ai.json`:

```json
{
  "enabled": true,
  "endpoint": "http://GPU_HOST:11435",
  "model": "qwen2.5-coder:14b",
  "medium_analysis_min_tokens": 800,
  "preflight_command": "/caminho/privado/local-ai-preflight",
  "recovery_command": "/workspace/scripts/local-ai/recover-endpoint.mjs",
  "recovery": {
    "enabled": true,
    "attempts": 2,
    "boot_wait_seconds": 20,
    "endpoint_wait_seconds": 12,
    "wake_on_lan": {
      "mac": "MAC_PRIVADO",
      "broadcast": "BROADCAST_PRIVADO",
      "port": 9
    }
  }
}
```

O polling passivo só confirma disponibilidade e, quando configurado, sonda a
GPU por SSH/WSL; ele nunca desperta a máquina. Somente uma invocação identificada
como MCP pode acionar o helper revisado: Wake-on-LAN seguido de no máximo duas
tentativas de iniciar o serviço já instalado e reconciliar o portproxy do
endereço exato. Se ambas falharem, o fluxo usa o modelo principal. O helper não
instala software, amplia firewall/listener nem reinicia o host. As
variáveis `LOCAL_AI_ENABLED=0`, `LOCAL_AI_ENDPOINT`, `LOCAL_AI_MODEL` e
`LOCAL_AI_FORCE` permitem controle local; `LOCAL_AI_FORCE` é diagnóstico e não
autoriza delegação inadequada.

Não há hook global nem preflight no envio do prompt. O Codex começa a trabalhar
imediatamente. Quando o pré-processamento determinístico encontra pela primeira
vez na conversa material elegível de cerca de 1.200 tokens ou mais, a política
consulta `local_ai_status` de forma preguiçosa e usa o MCP global
`local-ai-rtx`: primeiro `local_ai_route` e, somente para uma rota elegível e
benéfica, `local_ai_compress_context`. Os tipos são
`summarize-document`, `summarize-memory`, `inspect-files`, `review-diff`,
`analyze-tests`, `summarize-log` e `classify-error`. O helper
`./scripts/local-ai/local-ai` continua disponível apenas para diagnósticos e
testes locais. Dados secretos, decisões de segurança, migrações, operações
destrutivas e revisão final nunca são enviados ao modelo local.

Contratos, schemas, documentação bilíngue e mudanças multiarquivo também podem
usar a RTX depois de uma derivação determinística: envie um inventário com
arquivos, campos, comandos, módulos, headings e nomes de testes, não o código
bruto inteiro. Esse crosswalk é adequado para cobertura documental e triagem;
arquitetura, segurança e aprovação final permanecem no modelo principal.

O hook `PostToolUse` é versionado apenas neste projeto e precisa ser aprovado no
Codex em `/hooks` depois de sua instalação ou de qualquer alteração. Ele atua
somente quando uma saída grande já foi produzida; não analisa o prompt nem cria
uma etapa de confirmação. A aprovação é vinculada ao conteúdo do hook; uma
alteração exige nova revisão. Consulte a documentação oficial de
[hooks do Codex](https://learn.chatgpt.com/docs/hooks).

### Aprovação obrigatória do hook

Esta verificação interativa faz parte da instalação e manutenção, não é uma
etapa opcional. Repita-a depois de um novo clone ou instalação, da reconstrução
do contêiner que executa o Codex e sempre que `.codex/hooks.json` mudar. No host
do projeto, abra o CLI já instalado no bridge:

```bash
cd /mnt/data/docker
docker compose exec -w /workspace ai-bridge codex
```

Dentro do Codex CLI, execute `/hooks`, revise o hook do projeto e habilite-o.
O estado esperado é:

```text
Event          Installed   Active
PostToolUse    1           1
```

`PreToolUse = 0` é esperado porque este projeto não usa preflight de prompt. A
mera presença de `.codex/hooks.json` não comprova que o hook está ativo. Não use
opções de bypass de trust; se a tabela não mostrar `PostToolUse` como instalado
e ativo, conclua a revisão pela própria interface antes de validar o roteamento.

Quando a compressão é útil, o hook retorna `continue: false` com contexto
adicional limitado. Assim o resultado bruto é substituído também em code mode
sem rejeitar a promise da ferramenta. Uma falha mantém o resultado original e
é registrada pelo helper como `LOCAL_AI_FAILED`; o hook não cria uma segunda
decisão `skipped`, evitando contabilizar a mesma tentativa também como perda.

## Política de roteamento e auditoria

O objetivo não é ocupar a RTX em todos os prompts. A decisão é positiva somente
quando uma primeira passagem local, limitada e não sensível, tem previsão
material de reduzir o contexto que chegaria ao modelo principal. A ordem é:

```text
ferramenta determinística -> decisão de roteamento -> Local AI quando útil -> Codex/OpenAI
```

`scripts/local-ai/routing.py` torna a decisão reproduzível sem inferência. Ele
usa tamanho estimado, tipo da tarefa, compressibilidade esperada, helper
compatível, disponibilidade verificada de forma preguiçosa e suficiência de uma
ferramenta determinística. Os valores iniciais vêm do helper com contexto
efetivo mínimo de 8.192 tokens e do benchmark local validado; a suíte de
workloads os protege contra regressão.

| Tipo | Mínimo estimado | Máximo bruto confiável | Economia mínima | Compressão |
| --- | ---: | ---: | ---: | --- |
| `classify-error` | 800 tokens | sem máximo após filtro de sinais | 500 tokens | alta |
| `analyze-tests` / `summarize-log` | 900 tokens | sem máximo após filtro de sinais | 600 tokens | alta |
| `review-diff` / `inspect-files` | 1.200 tokens | 3.000 tokens | 700 tokens | média |
| `summarize-document` | 1.200 tokens | 3.000 tokens | 700 tokens | média |
| `summarize-memory` pelo MCP | 1.200 tokens | 6.000 tokens | 700 tokens | média |

Com o modelo operacional `qwen2.5-coder:14b`, `review-diff`, `inspect-files` e
`analyze-tests` ficam temporariamente em `LOCAL_AI_NOT_BENEFICIAL` porque não
passaram o A/B líquido de qualidade. Eles só rodam com `LOCAL_AI_FORCE=1` em
benchmark diagnóstico e não formam oportunidades perdidas. `summarize-log` é o
perfil com redução útil comprovada; documentos e memória mantêm seus gates e
limites próprios.

JSON grande, busca, listagem de arquivos, parsing e outros dados estruturados
continuam determinísticos quando a ferramenta aplicável resolve o caso. Por
isso, tamanho isolado nunca aciona a RTX.

"Determinístico" descreve o resultado final, não apenas a coleta. Um valor
escalar, uma resposta curta ou JSON já estruturado permanecem
`DETERMINISTIC`. Uma saída textual ainda pode seguir para pós-processamento
local quando precisa ser interpretada e satisfaz os limites mínimo e máximo da
tarefa. Diffs, inventários e documentos acima de aproximadamente 12.000
caracteres precisam ser particionados deterministicamente antes da RTX;
tratá-los apenas pelo início e pelo fim não autoriza reivindicar economia sobre
o miolo não analisado. Testes, erros e logs podem ser maiores porque o helper
filtra o corpo bruto e preserva deterministicamente as vizinhanças de sinais
antes de aplicar o limite. A RTX não substitui `rg`, `find`, Git ou `jq`; ela
recebe somente o resultado selecionado dessas ferramentas. No campo MCP legado
`deterministic_preprocessing_available`, `true` significa que o processamento
determinístico é final e suficiente, não apenas que ele foi executado.

Uma inferência concluída não prova retenção. Se o JSON condensado omitir
requisitos, arquivos ou riscos críticos conhecidos, ele é descartado e o fluxo
volta à evidência determinística sem alegar economia útil. A validação P1
confirmou melhor retenção para inventários derivados de schemas, módulos,
comandos e testes do que para blocos longos de código bruto; essa preferência é
parte da política atual.

As decisões terminais são `DETERMINISTIC`, `LOCAL_AI_USED`, `LOCAL_AI_FAILED`,
`LOCAL_AI_UNAVAILABLE`, `LOCAL_AI_NOT_BENEFICIAL`, `LOCAL_AI_SKIPPED`,
`LOCAL_AI_UNNECESSARY_CALL` e `ROUTING_MISSED_OPPORTUNITY`. Uma oportunidade é
perdida somente quando a tarefa era elegível, a RTX estava disponível, a
economia esperada era material e o helper não foi chamado. Uma chamada com
entrada pequena, economia real insuficiente ou delta não positivo é marcada
como desnecessária; uma falha continua contabilizada nas métricas de falha
existentes, sem alegar economia.

Para pré-visualizar uma decisão sem registrar uma inferência, use:

```bash
./scripts/local-ai/local-ai route analyze-tests --input-chars 32000
```

O resultado `LOCAL_AI_ELIGIBLE` é apenas uma prévia: a chamada normal ao helper
registra o resultado final como `LOCAL_AI_USED` ou
`LOCAL_AI_UNNECESSARY_CALL`. Se uma oportunidade clara for conscientemente
ignorada, registre-a sem fornecer o conteúdo bruto:

```bash
./scripts/local-ai/local-ai route review-diff --input-chars 24000 --outcome skipped
```

Para testar uma indisponibilidade sem desligar a GPU, use uma avaliação
controlada e sem chamada de rede:

```bash
./scripts/local-ai/local-ai route analyze-tests --input-chars 32000 --availability unavailable
```

Não existe `UserPromptSubmit`: o envio do prompt não bloqueia, não chama a RTX e
não exige a palavra `feito`. O hook de projeto `PostToolUse` trata somente
saídas grandes de `Bash`: detecta padrões de credenciais em memória, consulta o MCP
na primeira candidata elegível da conversa e substitui o corpo pelo JSON
limitado somente quando a rota e a compressão têm sucesso. Saídas pequenas,
consultas determinísticas, histórico privado e comandos que apontem para
credenciais são ignorados; código proprietário, logs e configuração privada sem
segredos podem seguir para a RTX. Falha ou indisponibilidade preserva o fallback para
o modelo principal. Anexos já incluídos no prompt continuam fora desse ponto de
interceptação, portanto nunca devem ser enviados integralmente apenas para
provocar roteamento.

O hook falha fechado quando detecta um padrão de segredo: nesse caso não cria o
cliente MCP e mantém o resultado original para o fluxo principal. Ele não
intercepta automaticamente outputs de outros MCPs, pois esses resultados podem
pertencer a conectores privados e não carregam o mesmo contrato de comando do
`Bash`; chamadas em code mode devem selecionar e rotear explicitamente apenas o
trecho não sensível.

A detecção cobre atribuições em texto ou JSON para senhas, chaves, cookies,
tokens genéricos, `access_token`, `refresh_token`, `client_secret` e IDs/tokens
de sessão. Comandos que apontem para `.env`, chaves privadas, armazenamento de
autenticação ou histórico privado são rejeitados antes da criação do cliente
MCP.

Chamar MCP não equivale a usar a RTX. `local_ai_status` comprova somente
disponibilidade; `local_ai_route` comprova avaliação; `LOCAL_AI_ELIGIBLE`
comprova elegibilidade. Uso real exige `local_ai_compress_context` concluído,
`job_id` não vazio, telemetria registrada e job terminal bem-sucedido. O
contexto substituto do hook inclui essa metadata canônica para que a resposta
final não confunda disponibilidade ou roteamento com inferência executada. A
auditoria aceita esse marcador como evidência do job do hook e deduplica o
mesmo `job_id` caso uma chamada MCP equivalente também esteja visível.

## Contexto de memória do repositório

`AGENTS.md` é carregado pelo Codex antes do trabalho; memória versionada do
repositório não é descoberta como instrução automaticamente. O projeto mantém
somente o índice canônico `.codex/memories/projeto/indice.md` como ponto leve
de entrada e seleciona memória temática depois que a tarefa justifica histórico.
`MEMORY.md` permanece um índice de compatibilidade, não outra fonte canônica.
As políticas gerais e específicas desta instalação ficam juntas no
`AGENTS.md` do Git root. Não mantenha outra cópia em `~/.codex/AGENTS.md` nem
monte esse arquivo no `CODEX_HOME` do bridge; `/workspace/AGENTS.md` já é
descoberto como instrução do projeto.

O auditor reproduzível é:

```bash
./scripts/local-ai/local-ai memory-audit
```

Ele informa apenas tokens observáveis: AGENTS global (esperado como zero nesta
instalação), AGENTS do repositório, AGENTS aninhados, memória pública disponível
e a configuração de memória local.
Instruções internas do Codex, o envelope de ferramentas e tokens de memória
privada não são expostos pela plataforma; são `null`, não valores zero. O
contador usa `o200k_base` se `tiktoken` estiver instalado e, caso contrário,
marca a estimativa por caracteres.

O fluxo de retrieval não usa Ollama para descobrir arquivos:

```text
tarefa -> índice/rg/headings -> arquivos temáticos mínimos -> avaliar tamanho
                                                    -> direto ou RTX -> JSON para Codex
```

Para recuperar por índice sem conteúdo bruto no contexto principal:

```bash
./scripts/local-ai/memory_context.py retrieve 'codex local ai' --query 'telemetria RTX'
./scripts/local-ai/memory_context.py materialize 'codex local ai' --query 'telemetria RTX' \
  | ./scripts/local-ai/local-ai summarize-memory --memory-topic 'codex-local-ai' --context-tokens 8192
```

`summarize-memory` tem threshold de 1.200 tokens de entrada estimados e 700
tokens de economia prevista. Ele retorna JSON com estado atual, decisões,
restrições, bugs, causas-raiz, valores de configuração, pendências, avisos e
fatos por fonte. Um conjunto menor segue direto; indisponibilidade ou falha da
RTX não bloqueia o Codex. A saída é primeira passagem não autoritativa e não
autoriza decisões de arquitetura, segurança ou produção.

A telemetria separa `tool_output_context_avoided` (o contador já existente
`openai_context_tokens_avoided`) de `memory_tokens_avoided`. A economia de
memória é exclusivamente `memory_tokens_retrieved -
memory_tokens_sent_to_primary_model`; não trata todo o corpus disponível como
economia. Registra `retrieval_calls`, `retrieval_skips`, `files_found`, tokens
recuperados/enviados/evitados, compressão, indisponibilidade e sobrecarga. Uma
sobrecarga sinaliza candidato grande enviado diretamente ao modelo acima do
orçamento validado; não afirma relevância semântica não mensurada.
Quando uma anotação antiga divergir da fonte canônica atual, registre a decisão
direta com `memory-route ... --canonical-conflict`; a telemetria guarda somente
esse sinal e o motivo, não o conteúdo conflitante.

Essa telemetria permanece disponível no bridge e nos sensores para auditoria,
mas não aparece no dashboard **Uso RTX**. O delta de memória não possui o mesmo
contrato líquido do waterfall operacional — especialmente a dedução mensurável
do custo do gate — e apresentá-lo ao lado da Redução útil líquida induzia uma
comparação inválida. O startup observável também é uma fotografia de configuração,
não um sinal operacional acionável. A configuração local do Codex mantém memória
gerada automaticamente desligada para evitar um segundo preload;
a memória versionada e a restauração de Git continuam disponíveis por retrieval.

## Telemetria e painéis

O helper não grava prompt, diff, código-fonte, resposta do modelo nem
credenciais. Em `.agent-history/` (ignorado pelo Git) ele preserva somente
metadados: tarefa, modelo, duração, contagens, status e amostras de GPU/VRAM.
Cada candidato passa primeiro por validações determinísticas específicas da
tarefa e depois por um verificador de fidelidade com nota mínima de 90%. A nota
mede cobertura do conteúdo, não eficiência econômica. Um candidato fiel pode
ser descartado como `insufficient_net_savings` quando o delta líquido após o
custo do gate não alcança o mínimo; esse caso não conta como rejeição de
qualidade. Se a
primeira resposta falhar, o helper faz uma segunda geração completa com o
feedback do gate, sem reduzir silenciosamente o contexto ou o schema. As duas
gerações e verificações pertencem ao mesmo job. Uma segunda rejeição devolve o
fluxo ao modelo principal e registra `discarded`, com economia útil igual a
zero; falha de transporte ou JSON inválido continua sendo falha técnica.

`review-diff` usa schema JSON nativo e limitado, inclusive para cada finding
(`file`, `severity` e `reason`). Isso evita depender apenas da aderência textual
do modelo em diffs longos, que anteriormente podia consumir as duas tentativas
e terminar como `RuntimeError` mesmo com Ollama e GPU saudáveis.

Em logs longos, uma etapa determinística preserva início, fim, `ERROR`,
`EXCEPTION`, `FAIL`, `ASSERT`, `WARN`, `CRITICAL`, `FATAL`, `TIMEOUT` e uma linha
de contexto ao redor de cada sinal, substituindo apenas trechos rotineiros por
marcadores de contagem. A economia continua usando o tamanho do contexto bruto
como baseline; a telemetria também registra quantas linhas rotineiras foram
omitidas e quantos caracteres chegaram ao modelo local. A validação exige que
tipos de sinal e identificadores com underscore presentes nessas linhas sejam
retidos em `summary` ou `errors`; uma omissão consome a única repetição compacta
e, se persistir, devolve o fluxo ao fallback.

O bridge renova sua própria sondagem de saúde a cada minuto (e ao iniciar),
usando o helper de disponibilidade, não um hook de prompt. Isso impede que uma falha transitória de rede
deixe a aba RTX presa em **indisponível** depois de o Ollama voltar. A checagem
só consulta endpoint/GPU e não inicia modelo, não gera carga artificial e não
reinicia nem reconfigura o host remoto.

A sondagem de GPU mantém `StrictHostKeyChecking=yes` e usa por padrão o arquivo
`known_hosts` persistente ao lado de `gpu_probe.ssh_key_path`. Isso é necessário
porque o `$HOME` do container do Home Assistant é efêmero: confiar apenas em
`/root/.ssh/known_hosts` faria a telemetria degradar depois de uma recriação do
container, mesmo com Ollama e RTX saudáveis.

A imagem `ai-bridge` inclui `python3`, pois o helper versionado
`./scripts/local-ai/local-ai` é Python. Assim, uma tarefa elegível enviada pelo
chat do Home Assistant consegue executar a primeira passagem na RTX, em vez de
falhar localmente por ausência do interpretador.

O bridge executa o mesmo servidor `local-ai-rtx` instalado no host. No startup,
um bootstrap idempotente mantém um bloco gerenciado em
`/home/node/.codex/config.toml`, com aprovação automática das ferramentas e o
runtime indicado por `CODEX_LOCAL_AI_RUNTIME_DIR` montado em
`/opt/codex-local-ai` somente para leitura. Se esse runtime não estiver
disponível, o bridge continua atendendo e o Codex aplica o fallback normal.
O diretório privado do runtime precisa permitir leitura e travessia ao grupo
`docker`; seu conteúdo continua sem permissão de escrita pelo container.
Portanto, tanto o Codex do IDE quanto o chat do Home Assistant aplicam `local_ai_status`,
`local_ai_route` e `local_ai_compress_context` sem o usuário precisar pedir o
uso da RTX.

O bridge expõe três endpoints locais sem conteúdo de conversa:

| Endpoint | Dados | Atualização usada no HA |
| --- | --- | --- |
| `GET /usage` | uso/limites do Codex e histórico agregado Local AI | 2 s |
| `GET /local-ai/live` | job atual, amostra instantânea e chats ativos | 1 s |
| `GET /local-ai/history` | até 40 jobs sanitizados das últimas 48 horas | 30 s |

O diretório privado definido por `CODEX_LOCAL_AI_STATE_DIR` é a fonte canônica
da telemetria agregada gerada pelos dois clientes MCP. O Compose monta esse
diretório no bridge com escrita restrita ao grupo compartilhado e define
`LOCAL_AI_TELEMETRY_PATH` para o arquivo montado. Os arquivos usam modo `0660`:
host e bridge podem registrar somente metadados de jobs, enquanto outros
usuários continuam sem acesso.

O status de saúde do painel permanece separado em `.agent-history`. Ao iniciar
a sondagem periódica, o bridge substitui `LOCAL_AI_TELEMETRY_PATH` apenas no
processo filho para que o helper derive e renove o status local, sem misturá-lo
com a telemetria global. Isso evita que uma montagem sem escrita congele o
último status até ele expirar após dois minutos, que fazia o painel mostrar RTX
indisponível mesmo com Ollama e GPU saudáveis.

No dashboard **Chat** há duas abas separadas:

- **Uso do Codex** (`/chat-assistants/uso-codex`): limite, créditos, cache e
  tokens do Codex, sem cards RTX.
- **RTX 4070** (`/chat-assistants/uso-rtx`): estado em tempo real, GPU, VRAM,
  potência, modelo/tarefa, tokens OpenAI economizados por compactação e chats
  que usam a RTX.

Na aba **Uso do Codex**, a coleta do bridge atualiza a cada dois segundos. O
bridge recebe, em modo somente leitura, as sessões do próprio container e as
sessões locais do host configurado em `CODEX_HOST_SESSIONS_DIR`. Ele verifica
metadados dos arquivos a cada ciclo e só relê uma sessão que tenha mudado; não
consulta uma API, não envia prompts e não consome o plano. Por isso, a nova
atividade registrada pelo Codex aparece normalmente em até dois segundos. O
percentual do limite do plano só é apresentado como atual por até dois minutos
depois de um evento de limite do Codex CLI; após isso, o painel o marca como
**desatualizado** e não o usa em alertas ou projeções. O último valor conhecido
continua visível, identificado como leitura histórica. Os totais de tokens
ainda representam somente as sessões preservadas no container do bridge, não
outras máquinas ou clientes Codex.

Na aba **RTX 4070**, o job e a amostra de GPU/VRAM/potência são consultados a
cada segundo. A disponibilidade só é tratada como atual quando o preflight do
bridge tem no máximo dois minutos; fora disso, o painel mostra
**desatualizado** em vez de afirmar que a RTX está pronta.

O Home Assistant recebe automaticamente a observação do endpoint ao vivo a cada
segundo e o agregado de uso a cada dois segundos. Por essa cadência, a aba não
oferece botão de atualização manual: ele apenas repetiria um polling já iminente
e não anteciparia o preflight de saúde, renovado pelo bridge a cada minuto.

Na aba **Codex**, os seletores permitem usar `gpt-5.6-luna`,
`gpt-5.6-terra` ou `gpt-5.6-sol` e um nível compatível de reasoning. O valor
inicial é sempre `gpt-5.6-terra` com reasoning `medium`; o usuário pode mudar
os dois seletores para uma tarefa quando necessário. Cada combinação mantém
uma sessão Codex separada para não retomar contexto com outro modelo. O bridge
desativa o recurso `apps` somente para essas execuções, pois nenhum conector de
apps é configurado nele; isso evita a inicialização do MCP ambiental
`codex_apps` com credencial expirada sem afetar o Codex fora do bridge.

No painel RTX, **chamadas Local AI** e **saldo líquido equivalente** ficam em
gráficos separados: chamadas contam tentativas de tarefas; o saldo soma somente
a diferença entre o contexto recebido e resultados que passaram pelo gate de
qualidade e foram efetivamente usados, descontando o custo local do verificador.
Como os tokenizadores podem diferir, ele é um índice conservador, não uma
contagem faturável da OpenAI. Falhas, descartes e benchmarks diagnósticos valem
zero. O
overhead do envelope de ferramenta/API da OpenAI não é mensurável pelo helper e
fica explicitamente marcado como não mensurado, portanto o valor não é um
registro de cobrança oficial. O resumo operacional expõe no máximo cinco jobs recentes e remove
detalhes de endpoint para permanecer abaixo do limite de atributos do Home
Assistant e preservar a telemetria no Recorder.

Além dos jobs, a telemetria privada guarda somente metadados das decisões de
roteamento: tipo, tamanho estimado, elegibilidade, disponibilidade, motivo,
economia esperada e, após uma chamada bem-sucedida, delta real. IDs UUID tornam
as agregações idempotentes mesmo se o bridge reiniciar ou reler dados. O estado
mantém totais, dias recentes (400 no máximo) e as últimas 40 decisões; o log
privado é limitado a 2 MiB. Não armazena prompt, diff, log, saída de comando ou
resposta local.

O bridge não expõe mais o arquivo retrospectivo como indicador de “hoje”. A
amostra tinha data própria e podia permanecer estática por vários dias, logo
não representava um contador operacional atual. O painel usa somente decisões
terminais registradas na data UTC corrente.

O bridge expõe `local_ai.routing` dentro de `GET /usage`, com totais para hoje,
semana, mês e total. As métricas são:

- **RTX delegation rate** = tarefas elegíveis e disponíveis que usaram RTX /
  tarefas elegíveis e disponíveis.
- **Weighted context savings coverage** = tokens úteis de resultados validados /
  economia potencial estimada das oportunidades elegíveis e disponíveis.
- **Potential tokens avoidable** é estimativa de conteúdo, não fatura OpenAI;
  a cobertura é limitada a 100% e deltas negativos continuam visíveis no
  contador de economia existente.

Na aba **RTX 4070**, a seção **Atenção de roteamento — hoje** mostra somente
os sinais acionáveis do dia UTC: oportunidades realmente perdidas, tokens
potenciais dessas perdas, indisponibilidade confirmada, disponibilidade
desconhecida e falhas técnicas após delegação. Tarefas avaliadas, elegíveis e
disponíveis permanecem numa linha compacta de contexto, acompanhadas da taxa de
disponibilidade entre elegíveis; não ocupam cards de atenção. Rejeições de
qualidade ficam exclusivamente em **Waterfall — hoje · UTC**. A auditoria
retrospectiva e o potencial global permanecem fora porque não representam
atenção operacional concreta do dia.
As entidades acumuladas e as demais seções de atividade, qualidade e histórico
permanecem separadas.

Os blocos **Waterfall — hoje · UTC** e **Waterfall — total preservado** usam
as mesmas etapas, fórmulas, nomes e unidades; muda apenas a janela temporal.
Eles reconciliam somente tentativas de substituição de contexto e explicitam falhas técnicas, conclusões
sem falha, resultados sem classificação de qualidade, avaliações pelo gate,
rejeições, aprovações de fidelidade, candidatos fiéis sem ganho líquido e
aprovados com e sem custo mensurado, sem tabela. Assim, cada diferença entre
duas etapas aparece como uma saída visível, em vez de parecer perda de dados.
Benchmarks ganham contador diagnóstico separado e
não contaminam chamadas ou falhas operacionais. Depois o waterfall muda
explicitamente de unidade para contexto total tentado, contexto OpenAI evitado
validado, custo local do gate nos resultados aprovados, saldo líquido equivalente e redução útil
operacional. A regra conservadora continua
`max(0, contexto evitado - tokens locais do verificador)`, mas o painel explica
que os tokenizadores são diferentes e que o saldo não é uma contagem faturável.
Resultados legados cujo custo do verificador não pode ser separado preservam a
economia bruta para auditoria, mas valem zero líquido. Fallbacks não aparecem
porque sua notificação não forma uma etapa reconciliável.

As taxas de aproveitamento da qualidade, cobertura do custo do gate e cobertura
da classificação ficam em **Diagnóstico do gate — hoje · UTC**. Elas descrevem
a qualidade da medição e não são apresentadas como economia de tokens.

Os indicadores de GPU, VRAM e potência exibem **ociosa** quando a RTX está
disponível sem inferência em andamento. Os valores numéricos aparecem somente
com uma amostra ativa, evitando que o painel apresente `Unavailable` ou um
valor de repouso inventado como se fosse medido.

Os quatro indicadores da seção **Atividade ao vivo** são entidades de
apresentação e ficam fora do Recorder: seus atributos mudam a cada segundo e
não representam uma série histórica útil. Os sensores
`sensor.codex_rtx_*_historico` registram GPU, VRAM e potência como valores
numéricos, com unidade e `state_class: measurement`. Nesses gráficos,
`0` significa que não havia uma amostra de inferência ativa; não representa
uma medição do consumo físico em repouso. Assim, o histórico permanece
contínuo, enquanto indisponibilidade e perda de sinal continuam representadas
pelos cards de saúde. Uma tolerância de cinco segundos no sinal e no fim do
uso evita que uma falha isolada de polling fragmente o histórico ou faça o
card alternar brevemente para **sem sinal**. Ao fim da aba, **Histórico de uso
da RTX — últimas 48 horas** é uma tabela de jobs sanitizados: trabalho delegado,
modelo local, aproveitamento, qualidade do conteúdo, duração e economia líquida
equivalente. Benchmarks são omitidos e todo
descarte aparece com zero economia. O resultado distingue rejeição de fidelidade
de candidato fiel sem ganho líquido suficiente; uma nota de 100% não implica
economia.

A coleta ao vivo ocorre a cada dois segundos, com timeout de três segundos. A
cadência evita sobreposição de comandos observada no intervalo anterior de um
segundo, sem introduzir atraso relevante na leitura operacional do painel.

Os cards de saúde e **Job atual / último** usam o mesmo estado rápido da seção
ao vivo para sinalizar imediatamente o início e o fim de uma inferência. Os
cards em seções com o sufixo **hoje** leem exclusivamente os agregados diários;
as entidades acumuladas permanecem separadas para totais e gráficos de sete
dias. Contagens, economia e qualidade são consolidadas quando cada decisão ou
job termina, enquanto GPU, VRAM, potência e estado do job mudam durante a
execução.

O gráfico **Economia útil diária — últimos 7 dias** lê os sete agregados UTC
preservados diretamente do bridge. Assim, dias anteriores aparecem de imediato
mesmo quando a entidade diária do Home Assistant foi criada recentemente e
ainda não possui histórico suficiente no Recorder. A soma da série reconcilia
com a janela móvel **Últimos 7 dias**; **Mês atual** continua sendo uma janela
de calendário UTC e **Total preservado** cobre toda a telemetria. Somente jobs com
`quality_accepted: true` cujo delta excede o custo medido do verificador aumentam
o valor; descartes, falhas, benchmarks e legado sem custo separável contribuem
com zero. `gross_useful_context_tokens_avoided` mantém o delta aprovado antes do
gate e `quality_validated_validation_tokens` mantém somente o custo dos gates
que aprovaram resultados, permitindo reconciliar o líquido sem misturar tokens
de gerações descartadas.

Os chats aparecem como identificadores curtos (`Codex #…`), não títulos ou
prompts. Quando o chamador fornece `CODEX_CHAT_NAME` ou `CODEX_THREAD_NAME`,
o painel exibe esse nome no lugar do identificador; ele nunca deriva um nome a
partir do conteúdo da conversa. Isso dá correlação operacional sem vazar
conteúdo da conversa.

O bloco **Fluxo operacional diário — últimos 7 dias** lê diretamente a série
UTC preservada pelo bridge, sem depender da média temporal do Recorder. Cada
linha reproduz somente as saídas não zeradas do waterfall: resultados úteis e
mensuráveis, rejeições de fidelidade, candidatos fiéis sem ganho, falhas
técnicas, resultados sem classificação e aprovações sem custo separável. Dias
vazios aparecem como sem atividade; o saldo líquido fica separado dos
resultados do gate.
Benchmarks ficam fora. Rejeições não são falhas de infraestrutura, mas valem
zero economia e reduzem a
redução útil segundo a mesma lógica conservadora do benchmark offline. O painel
também mostra aproveitamento do gate, cobertura da mensuração de seu custo e
cobertura da classificação operacional.

Os grids de indicadores usam duas colunas para permanecerem legíveis também em
telas estreitas. A aba organiza as informações em ordem operacional: saúde da
infraestrutura, atividade ao vivo e resultado/qualidade do dia iniciam as três
colunas; atenção de roteamento e última atividade vêm logo abaixo. Para equilibrar
as alturas, contexto/memória fica após o diagnóstico na primeira coluna, enquanto
qualidade e históricos permanecem na terceira. Acumulados, decisões detalhadas, diagnóstico e gráficos físicos ou
históricos ficam na parte inferior. Métricas prioritárias aparecem uma vez no
topo; rejeições de qualidade aparecem somente em resultado/qualidade, junto da
redução útil. Ela divide o saldo líquido equivalente por todo o contexto das
tentativas operacionais; descartes e falhas entram no denominador com economia
zero. A referência controlada explicita separadamente redução ponderada, mediana,
tamanho da amostra, modelos do gerador/verificador e ausência de avaliação
end-to-end do modelo principal. Os blocos
inferiores preservam detalhes e histórico sem repetir indicadores. Cada
conjunto de roteamento, qualidade, memória, totais, decisões ou histórico inclui
uma nota curta de interpretação; saúde, atividade instantânea e os três gráficos
físicos de GPU/VRAM/potência permanecem sem esse texto auxiliar por serem
autoexplicativos.

Os textos **Como ler** são definições fixas dos indicadores; valores correntes e
avisos condicionais aparecem fora desses parágrafos. Os tiles usam somente as
cores semânticas nativas do Home Assistant: azul/ciano para fluxo e
infraestrutura, roxo para roteamento/memória, verde para resultados úteis, âmbar
para custo ou incerteza e vermelho para falha ou descarte. Isso preserva a
legibilidade nos temas claro e escuro sem CSS customizado.

A decisão terminal `LOCAL_AI_QUALITY_REJECTED` registra economia real e útil
iguais a zero. O bridge também normaliza decisões e jobs históricos sem esses
campos, impedindo que o dashboard apresente “não mensurada” ou uma redução bruta
como economia aproveitável. O diagnóstico detalha somente a tentativa mais
recente; falhas técnicas continuam separadas de rejeições do gate.

A view usa o layout nativo `sections`, com até três colunas contínuas e
`dense_section_placement: false`. Cada coluna mantém seus cards empilhados, sem
lacunas criadas por cards altos das colunas vizinhas. No desktop, os três grupos
prioritários permanecem na primeira linha visual; em telas estreitas, a
responsividade nativa preserva a ordem de cada coluna. O teste
`test_chat_rtx_dashboard_layout.py` protege essa composição.

## Verificação e diagnóstico

No host Codex, confirme a conectividade sem alterar estado:

```bash
nc -vz -w 3 GPU_HOST 11435
curl --fail --connect-timeout 5 http://GPU_HOST:11435/api/tags
./scripts/local-ai/local-ai status
```

Para um teste real, use um diff não sensível ou uma entrada sintética por
stdin. Durante a geração, acompanhe `nvidia-smi` e `ollama ps` no WSL; o
resultado esperado é modelo carregado com `100% GPU`, crescimento de VRAM e
utilização de GPU acima do baseline. No Home Assistant, a aba RTX deve mudar
para **inferência local ativa** e exibir a amostra em até aproximadamente dois
segundos.

| Sintoma | Verificações seguras |
| --- | --- |
| `11435` não conecta | listener e regra de firewall do Windows; rota LAN; teste `curl /api/tags` |
| Recuperação do MCP falha | execute `node --test scripts/local-ai/recover-endpoint.test.mjs`; revise a configuração privada sem expor MAC, endpoint, usuário, chave ou `known_hosts` |
| `11434` conecta pela LAN | desabilite a exposição direta e mantenha somente o portproxy restrito |
| Ollama responde mas sem GPU | `ollama ps`, `nvidia-smi`, driver NVIDIA/WSL e tamanho/quantização do modelo |
| CPU offload | reduza o modelo/contexto; não assuma que uma resposta rápida significa GPU integral |
| RTX não aparece no painel | `GET /local-ai/live`, arquivo privado de telemetria e sensores do pacote HA |
| Roteamento automático do projeto não roda | abra o Codex CLI pelo bridge, execute `/hooks`, revise/aprove `.codex/hooks.json` e confirme `PostToolUse` com `Installed = 1` e `Active = 1` |

## Reprodução em um fork

1. Prepare um host Windows com GPU NVIDIA, WSL2 Ubuntu e Ollama; habilite
   systemd no WSL e confira uma inferência local com `nvidia-smi` e `ollama ps`.
2. Crie o portproxy `GPU_HOST:11435 -> 127.0.0.1:11434` e uma regra de firewall
   limitada ao IP do host Codex. Valide pelo host cliente com `/api/tags`.
3. Instale um modelo que caiba integralmente na VRAM e rode
   `local-ai benchmark --model <modelo>` antes de escolhê-lo como padrão.
4. Crie o `local-ai.json` privado no host Codex e, se usar o bridge, no volume
   privado do Codex do container; adapte os caminhos do preflight a cada
   ambiente.
5. Abra o Codex CLI, execute `/hooks`, revise o hook do projeto e confirme
   obrigatoriamente `PostToolUse` com `Installed = 1` e `Active = 1`; mantenha
   `AGENTS.md` apontando para o MCP global. Não configure `UserPromptSubmit`.
6. Suba o bridge e o Home Assistant, então valide `/usage`, `/local-ai/live` e
   as duas abas do dashboard.

Antes de publicar um fork, execute `node scripts/docs-check.mjs` e
`scripts/security-scan.sh`. Não versione endpoints reais, regras de firewall,
chaves SSH, telemetria, prompts ou histórico de conversas.
