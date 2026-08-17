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
  └─ local-ai + preflight + telemetria privada
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
| Política do Codex | decidir quando uma primeira passagem agrega valor | `AGENTS.md` e hook global privado |
| Bridge | expor somente resumo de uso e estado de job | `claude-bridge/server.js`, `claude-bridge/usage.js` |
| Home Assistant | mostrar uso do Codex e RTX separadamente | `homeassistant/packages/codex_usage.yaml` e dashboard |

Os modelos disponíveis podem mudar por instalação. O modelo selecionado após o
benchmark é `qwen2.5-coder:7b`: cumpriu os quatro schemas, teve cerca de
91–93 tok/s por caso e não exibiu CPU offload. O registro comparativo está em
[`LOCAL_AI_BENCHMARK_2026-08-16.md`](LOCAL_AI_BENCHMARK_2026-08-16.md).

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
auto-proxy e `hostAddressLoopback`. Um agendador do Windows inicia um processo
leve de keepalive do WSL no logon do usuário; o `ollama.service` fica habilitado
no systemd do WSL. Portanto, a disponibilidade automática depende desse logon
(ou de uma política de logon automático equivalente), além de Windows e WSL
estarem saudáveis.

## Configuração do cliente Codex

Cada máquina que executa Codex mantém sua configuração fora do Git, por
exemplo em `~/.config/codex/local-ai.json`:

```json
{
  "enabled": true,
  "endpoint": "http://GPU_HOST:11435",
  "model": "qwen2.5-coder:7b",
  "medium_analysis_min_tokens": 800,
  "preflight_command": "/caminho/privado/local-ai-preflight"
}
```

O preflight só confirma disponibilidade e, quando configurado, sonda a GPU por
SSH/WSL. Ele não instala, reinicia, desperta ou reconfigura infraestrutura. As
variáveis `LOCAL_AI_ENABLED=0`, `LOCAL_AI_ENDPOINT`, `LOCAL_AI_MODEL` e
`LOCAL_AI_FORCE` permitem controle local; `LOCAL_AI_FORCE` é diagnóstico e não
autoriza delegação inadequada.

No início de cada conversa, a política chama `local_ai_status` uma vez. Em
tarefas elegíveis com material selecionado de cerca de 1.200 tokens ou mais,
ela usa o MCP global `local-ai-rtx`: primeiro `local_ai_route` e, somente para
uma rota elegível e benéfica, `local_ai_compress_context`. Os tipos são
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

O hook é privado e precisa ser aprovado no Codex em `/hooks` depois de sua
instalação ou de qualquer alteração. A aprovação é vinculada ao conteúdo do
hook; uma alteração exige nova revisão. Consulte a documentação oficial de
[hooks do Codex](https://learn.chatgpt.com/docs/hooks).

## Política de roteamento e auditoria

O objetivo não é ocupar a RTX em todos os prompts. A decisão é positiva somente
quando uma primeira passagem local, limitada e não sensível, tem previsão
material de reduzir o contexto que chegaria ao modelo principal. A ordem é:

```text
ferramenta determinística -> decisão de roteamento -> Local AI quando útil -> Codex/OpenAI
```

`scripts/local-ai/routing.py` torna a decisão reproduzível sem inferência. Ele
usa tamanho estimado, tipo da tarefa, compressibilidade esperada, helper
compatível, disponibilidade já conhecida pelo preflight e suficiência de uma
ferramenta determinística. Os valores iniciais vêm do helper limitado a 4.096
tokens e do benchmark local validado; a suíte de workloads os protege contra
regressão.

| Tipo | Mínimo estimado | Economia esperada mínima | Compressão padrão |
| --- | ---: | ---: | --- |
| `classify-error` | 800 tokens | 500 tokens | alta |
| `analyze-tests` / `summarize-log` | 900 tokens | 600 tokens | alta |
| `review-diff` / `inspect-files` | 1.200 tokens | 700 tokens | média |
| `summarize-document` / `summarize-memory` pelo MCP | 1.200 tokens | 700 tokens | alta |

JSON grande, busca, listagem de arquivos, parsing e outros dados estruturados
continuam determinísticos quando a ferramenta aplicável resolve o caso. Por
isso, tamanho isolado nunca aciona a RTX.

Uma inferência concluída não prova retenção. Se o JSON condensado omitir
requisitos, arquivos ou riscos críticos conhecidos, ele é descartado e o fluxo
volta à evidência determinística sem alegar economia útil. A validação P1
confirmou melhor retenção para inventários derivados de schemas, módulos,
comandos e testes do que para blocos longos de código bruto; essa preferência é
parte da política atual.

As decisões terminais são `DETERMINISTIC`, `LOCAL_AI_USED`,
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

O hook `UserPromptSubmit` atual executa só o preflight após a confirmação do
roteamento de modelo; ele não é um middleware de todos os resultados de
ferramentas. Assim, um anexo já incluído no prompt inicial pode necessariamente
chegar ao modelo principal antes de o helper do repositório poder compactá-lo.
Para diffs, logs, testes, arquivos e saídas de comandos, a política em
`AGENTS.md` exige a decisão antes de imprimir ou anexar o corpo bruto. Essa é a
limitação conhecida da cobertura, não uma razão para chamar a GPU tardiamente
ou para inventar telemetria.

## Contexto de memória do repositório

`AGENTS.md` é carregado pelo Codex antes do trabalho; memória versionada do
repositório não é descoberta como instrução automaticamente. O projeto mantém
somente o índice canônico `.codex/memories/projeto/indice.md` como ponto leve
de entrada e seleciona memória temática depois que a tarefa justifica histórico.
`MEMORY.md` permanece um índice de compatibilidade, não outra fonte canônica.

O auditor reproduzível é:

```bash
./scripts/local-ai/local-ai memory-audit
```

Ele informa apenas tokens observáveis: AGENTS global, AGENTS do repositório,
AGENTS aninhados, memória pública disponível e a configuração de memória local.
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

No dashboard **Uso RTX**, o bloco *Contexto e memória* mostra startup
observável, memória recuperada, enviada ao modelo principal, evitada,
compressão, sobrecargas e a última decisão. A configuração local do Codex
mantém memória gerada automaticamente desligada para evitar um segundo preload;
a memória versionada e a restauração de Git continuam disponíveis por retrieval.

## Telemetria e painéis

O helper não grava prompt, diff, código-fonte, resposta do modelo nem
credenciais. Em `.agent-history/` (ignorado pelo Git) ele preserva somente
metadados: tarefa, modelo, duração, contagens, status e amostras de GPU/VRAM.
Se a primeira resposta local não formar o JSON exigido, o helper faz no máximo
uma segunda tentativa mais compacta. As duas gerações pertencem ao mesmo job e
seus tokens locais são somados; nova falha encerra a tarefa normalmente para o
Codex aplicar o fallback, sem criar loops.

`review-diff` usa schema JSON nativo e limitado, inclusive para cada finding
(`file`, `severity` e `reason`). Isso evita depender apenas da aderência textual
do modelo em diffs longos, que anteriormente podia consumir as duas tentativas
e terminar como `RuntimeError` mesmo com Ollama e GPU saudáveis.

Em logs longos, uma etapa determinística preserva início, fim, `ERROR`,
`EXCEPTION`, `FAIL`, `ASSERT`, `WARN`, `CRITICAL`, `FATAL`, `TIMEOUT` e uma linha
de contexto ao redor de cada sinal, substituindo apenas trechos rotineiros por
marcadores de contagem. A economia continua usando o tamanho do contexto bruto
como baseline; a telemetria também registra quantas linhas rotineiras foram
omitidas e quantos caracteres chegaram ao modelo local.

O bridge renova o preflight de saúde a cada minuto (e ao iniciar), usando o
mesmo hook privado já aprovado. Isso impede que uma falha transitória de rede
deixe a aba RTX presa em **indisponível** depois de o Ollama voltar. A checagem
só consulta endpoint/GPU e não inicia modelo, não gera carga artificial e não
reinicia nem reconfigura o host remoto.

A sondagem de GPU mantém `StrictHostKeyChecking=yes` e usa por padrão o arquivo
`known_hosts` persistente ao lado de `gpu_probe.ssh_key_path`. Isso é necessário
porque o `$HOME` do container do Home Assistant é efêmero: confiar apenas em
`/root/.ssh/known_hosts` faria a telemetria degradar depois de uma recriação do
container, mesmo com Ollama e RTX saudáveis.

A imagem `claude-bridge` inclui `python3`, pois o helper versionado
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

O bridge expõe dois endpoints locais sem conteúdo de conversa:

| Endpoint | Dados | Atualização usada no HA |
| --- | --- | --- |
| `GET /usage` | uso/limites do Codex e histórico agregado Local AI | 2 s |
| `GET /local-ai/live` | job atual, amostra instantânea e chats ativos | 1 s |

O diretório privado definido por `CODEX_LOCAL_AI_STATE_DIR` é a fonte canônica
da telemetria agregada gerada pelos dois clientes MCP. O Compose monta esse
diretório no bridge com escrita restrita ao grupo compartilhado e define
`LOCAL_AI_TELEMETRY_PATH` para o arquivo montado. Os arquivos usam modo `0660`:
host e bridge podem registrar somente metadados de jobs, enquanto outros
usuários continuam sem acesso.

O status de saúde do painel permanece separado em `.agent-history`. Ao iniciar
o preflight periódico, o bridge substitui `LOCAL_AI_TELEMETRY_PATH` apenas no
processo filho para que o hook derive e renove o status local, sem misturá-lo
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

No painel RTX, **chamadas Local AI** e **tokens OpenAI economizados** ficam em
gráficos separados: chamadas contam tentativas de tarefas; tokens economizados
são a estimativa assinada da diferença entre o contexto recebido pelo helper e
o resumo efetivamente retornado ao Codex. Falhas e benchmarks diagnósticos não
entram nessa economia; uma saída maior que a entrada reduz o acumulado. O
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

O bridge expõe `local_ai.routing` dentro de `GET /usage`, com totais para hoje,
semana, mês e total. As métricas são:

- **RTX delegation rate** = tarefas elegíveis e disponíveis que usaram RTX /
  tarefas elegíveis e disponíveis.
- **Weighted context savings coverage** = tokens realmente evitados /
  economia potencial estimada das oportunidades elegíveis e disponíveis.
- **Potential tokens avoidable** é estimativa de conteúdo, não fatura OpenAI;
  a cobertura é limitada a 100% e deltas negativos continuam visíveis no
  contador de economia existente.

Na aba **RTX 4070**, o bloco *Roteamento inteligente* mostra tarefas avaliadas,
elegíveis, RTX usada, oportunidades perdidas, indisponibilidade e chamadas
desnecessárias. Os cards seguintes exibem as duas coberturas, potencial,
economia real diária, a última decisão e oportunidades perdidas recentes. Os
cards anteriores de chamadas, economia, GPU, VRAM, potência e último job são
preservados.

Os indicadores de GPU, VRAM e potência exibem **ociosa** quando a RTX está
disponível sem inferência em andamento. Os valores numéricos aparecem somente
com uma amostra ativa, evitando que o painel apresente `Unavailable` ou um
valor de repouso inventado como se fosse medido.

Os chats aparecem como identificadores curtos (`Codex #…`), não títulos ou
prompts. Quando o chamador fornece `CODEX_CHAT_NAME` ou `CODEX_THREAD_NAME`,
o painel exibe esse nome no lugar do identificador; ele nunca deriva um nome a
partir do conteúdo da conversa. Isso dá correlação operacional sem vazar
conteúdo da conversa.

O painel também registra a **taxa de falhas Local AI**: chamadas com status
`failed` divididas pelo total de tarefas solicitadas à RTX. O gráfico mostra a
taxa acumulada que o sensor observou ao longo do tempo, com linhas para o
total e para cada modelo monitorado. Novos modelos exigem uma entidade estável
adicional para aparecerem no gráfico nativo do Home Assistant.

Os grids do painel usam duas colunas para que estado, GPU, VRAM e potência
permaneçam legíveis também em telas estreitas. A aba organiza as informações em
ordem operacional: saúde da infraestrutura, atividade ao vivo, resultado e
qualidade do roteamento do dia, itens que exigem atenção, última atividade,
contexto e memória, decisões detalhadas, acumulados, diagnóstico e gráficos.
Métricas prioritárias aparecem uma vez no topo; os blocos inferiores preservam
detalhes e histórico sem repetir os mesmos indicadores.

A view usa o layout nativo `sections`, com até três colunas e
`dense_section_placement: false`. Esse é o contrato visual padrão: no desktop,
as seções numeradas de 1 a 11 seguem da esquerda para a direita e depois de cima
para baixo; em telas estreitas, a responsividade nativa preserva a mesma ordem
em uma coluna. O teste `test_chat_rtx_dashboard_layout.py` protege essa sequência.

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
para **inferência local ativa** e exibir a amostra em até aproximadamente um
segundo.

| Sintoma | Verificações seguras |
| --- | --- |
| `11435` não conecta | listener e regra de firewall do Windows; rota LAN; teste `curl /api/tags` |
| `11434` conecta pela LAN | desabilite a exposição direta e mantenha somente o portproxy restrito |
| Ollama responde mas sem GPU | `ollama ps`, `nvidia-smi`, driver NVIDIA/WSL e tamanho/quantização do modelo |
| CPU offload | reduza o modelo/contexto; não assuma que uma resposta rápida significa GPU integral |
| RTX não aparece no painel | `GET /local-ai/live`, arquivo privado de telemetria e sensores do pacote HA |
| Hook não roda | abra `/hooks`, revise/aprove o hook e confirme o caminho configurado |

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
5. Instale/revise o hook do Codex, faça a aprovação em `/hooks` e mantenha
   `AGENTS.md` apontando para o helper versionado.
6. Suba o bridge e o Home Assistant, então valide `/usage`, `/local-ai/live` e
   as duas abas do dashboard.

Antes de publicar um fork, execute `node scripts/docs-check.mjs` e
`scripts/security-scan.sh`. Não versione endpoints reais, regras de firewall,
chaves SSH, telemetria, prompts ou histórico de conversas.
