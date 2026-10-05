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

Desde 26/08/2026, o runtime reutilizável é mantido separadamente em
[`gabrafur/local-ai-rtx`](https://github.com/gabrafur/local-ai-rtx). Esta
implantação fixa release, commit e SHA-256 em
[`local-ai-integration/local-ai-rtx.lock.json`](../local-ai-integration/local-ai-rtx.lock.json),
instala releases imutáveis com `make install-local-ai-runtime` e conserva aqui
somente integração, política, dashboards e pesquisa específica. Datasets e
harnesses históricos ficam em [`local-ai-research/`](../local-ai-research/README.md).

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
| `local-ai` | executar tarefas limitadas e emitir JSON/telemetria | release fixada de [`local-ai-rtx`](https://github.com/gabrafur/local-ai-rtx) |
| Política do Codex | decidir quando uma primeira passagem agrega valor | `AGENTS.md` e hook de projeto `.codex/hooks.json` |
| Bridge | expor somente resumo de uso e estado de job | `ia-bridge/server.js`, `ia-bridge/usage.js` |
| Home Assistant | mostrar uso do Codex e RTX separadamente | `homeassistant/packages/codex_usage.yaml` e dashboard |

Os modelos disponíveis podem mudar por instalação. O gerador instalado
permanece `qwen2.5-coder:14b`, que cumpriu os quatro schemas e não exibiu CPU
offload. Nenhum verificador por modelo está promovido; o único validador novo é
o gate determinístico e extrativo de logs do runtime 1.3.3. A primeira leitura
de 51,5% bruta e a rodada autoavaliada de 23,2%
são históricas. Em 2026-08-24, o benchmark v4 comparou `qwen3:8b` e
`qwen3:14b` em 16 observações cada, com metade holdout. Ambos selecionaram os
mesmos 2/16 resultados economicamente úteis, 13,6% ponderados e mediana zero;
o 14B reduziu falsas rejeições, mas não aumentou a economia e foi mais lento.
Nenhum foi promovido. O registro comparativo e a reavaliação operacional estão em
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

### Publicação nativa ao iniciar ou retomar o Windows

`local-ai-integration/windows-rtx-portproxy.ps1` verifica a publicação restrita
depois que a rede e a API loopback do Ollama estão disponíveis. O instalador
`local-ai-integration/install-windows-rtx-portproxy.ps1` registra a tarefa
`LocalAiRtxStartupPortproxy` como SYSTEM, com gatilhos de boot, logon e retorno
da suspensão (`Power-Troubleshooter`, evento 1), atrasados em 30/20/20 segundos.
Não há agenda periódica, Wake-on-LAN nem inicialização de WSL nessa tarefa.
O mecanismo existente que inicia/mantém o WSL e o serviço Ollama continua
responsável pelo backend.

O hook aguarda até 18 verificações, com intervalo de cinco segundos e timeout
de dois segundos na API local. Só republica `GPU_HOST:11435 -> 127.0.0.1:11434`,
no máximo duas vezes, depois de conferir o endereço local e a regra de firewall
existente, limitada ao único `CODEX_HOST`. Conflito com outro destino, endereço
genérico ou firewall amplo falha fechado. Um listener saudável não sofre
mutação. O script não reinicia IP Helper, Tailscale, SSH, WSL nem outro serviço
e não altera firewall ou outros proxies. O timeout da tarefa é quatro minutos,
com instância única e sem despertar o computador.

Execute o instalador em PowerShell elevado, fornecendo `-ListenAddress`,
`-ClientAddress` e `-FirewallRuleName` a partir da configuração privada atual.
Ele copia o script para `%ProgramData%\LocalAiRtx`, restringe a pasta a SYSTEM
e administradores e guarda backups do script e de uma tarefa anterior ali.
Os endereços e o XML instalado não pertencem ao repositório. Para desfazer,
desabilite/remova somente `LocalAiRtxStartupPortproxy` e restaure o backup
anterior, quando existente; preserve o keepalive do WSL e o firewall.
O processo da tarefa usa `RemoteSigned`, sem mudar a política persistente do
Windows. O resultado sanitizado fica em `windows-rtx-portproxy-status.json` na
mesma pasta protegida, com estado, motivo ou contagem de reparos e timestamp;
o Agendador registra retorno zero no sucesso e um na falha.

Valide sem efeitos com `powershell.exe -NoProfile -NonInteractive -File
local-ai-integration/windows-rtx-portproxy.test.ps1`. O teste de integração deve
confirmar retorno zero da tarefa, listener restrito e `/api/tags` acessível
pelo cliente, preservando PIDs/estados dos serviços compartilhados, firewall
e demais regras. A execução manual da tarefa não comprova um ciclo real de
suspensão ou boot; esse ciclo deve ser observado separadamente. Se a
republicação limitada não resolver, mantenha a recuperação MCP como ação
explícita; não acrescente restart de IP Helper a este hook, pois ele possui
dependentes de VPN.

Referências: [portproxy do Windows](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface)
e [atraso de gatilho por evento](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-delay-eventtriggertype-element).

## Configuração do cliente Codex

Cada máquina mantém sua configuração fora do Git, por exemplo em
`~/.config/local-ai-rtx/config.json`. O caminho anterior
`~/.config/codex/local-ai.json` permanece somente como fallback compatível:

```json
{
  "enabled": true,
  "endpoint": "http://GPU_HOST:11435",
  "model": "qwen2.5-coder:14b",
  "medium_analysis_min_tokens": 800,
  "preflight_command": "/opt/local-ai-rtx/local-ai-preflight.mjs",
  "recovery_command": "/opt/local-ai-rtx/recover-endpoint.mjs",
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

O runtime distribui `local-ai-preflight.mjs` e resolve o helper de recovery no
mesmo diretório imutável antes de considerar um caminho privado antigo. No
container, o bootstrap do bridge migra de forma idempotente
`preflight_command` e `recovery_command` para `/opt/local-ai-rtx`; no host, o
instalador aponta para a release ativa. Assim, caminhos legados como
`codex-local-ai/current` ou caminhos de checkout não mantêm o health check
dependente de fallback.

Não há hook global nem preflight de Local AI no envio do prompt. O hook de
memória `UserPromptSubmit` apenas prepara um checkpoint e contexto interno, sem
inferência ou confirmação inicial. O Codex começa a trabalhar imediatamente. Quando o pré-processamento determinístico encontra pela primeira
vez na conversa material elegível de cerca de 1.200 tokens ou mais, a política
consulta `local_ai_status` de forma preguiçosa e usa o MCP global
`local-ai-rtx`: primeiro `local_ai_route` e, somente para uma rota elegível e
benéfica, `local_ai_compress_context`. Os tipos são
`summarize-document`, `summarize-memory`, `inspect-files`, `review-diff`,
`analyze-tests`, `summarize-log` e `classify-error`. O helper
`$HOME/.local/share/local-ai-rtx/current/local-ai` continua disponível para diagnósticos, testes e
para registrar o recibo metadata-only `confirm-delivery`; esse subcomando não
faz inferência. Dados secretos, decisões de segurança, migrações, operações
destrutivas e revisão final nunca são enviados ao modelo local.

Contratos, schemas, documentação bilíngue e mudanças multiarquivo também podem
usar a RTX depois de uma derivação determinística: envie um inventário com
arquivos, campos, comandos, módulos, headings e nomes de testes, não o código
bruto inteiro. Esse crosswalk é adequado para cobertura documental e triagem;
arquitetura, segurança e aprovação final permanecem no modelo principal.

### Cobertura em cada nova solicitação

O Codex carrega a cadeia de `AGENTS.md` uma vez ao iniciar a sessão, mas a regra
versionada manda reavaliar o roteamento em **cada solicitação do usuário**. Isso
faz a política alcançar candidatos que apareçam em turnos posteriores sem criar
um preflight de GPU. O tamanho total do prompt nunca basta: o agente deve
isolar um corpo não sensível, aplicar ferramentas determinísticas e chamar
`local_ai_route` antes de qualquer compressão.

| Origem do candidato | Aplicação | Garantia disponível |
| --- | --- | --- |
| Saída grande de `Bash` direto | Automática pelo `PostToolUse` | Determinística somente após `/hooks` mostrar `Installed = 1` e `Active = 1` |
| `exec_command` aninhado no Code Mode | Redução antes da emissão; hooks dependem do cliente | Feedback do hook não prova substituição do objeto JavaScript; use o formatador local para TAP grande |
| Texto ou anexo do prompt | Explícita pelo agente conforme `AGENTS.md` | Política; `UserPromptSubmit` só prepara a revisão de memória |
| Resultado de outro tool ou MCP | Explícita sobre o menor trecho não sensível | O hook de `Bash` não intercepta esse caminho |
| Conteúdo pequeno, estruturado, secreto ou privado | Não aplicar RTX | Fallback determinístico/modelo principal |

### Redução local sem perda de saídas de testes

Para suítes grandes em formato Node TAP, execute
`python3 scripts/local-ai/run.py -- COMMAND [ARG ...]`, preservando o wrapper
de recursos ou alvo Make já usado. O formatador atua antes de a saída chegar
ao Codex. Não usa rede, modelos, GPU, cache de respostas ou armazenamento de
logs; a saída pequena, desconhecida ou que não compensa passa intacta.

Somente registros de sucesso com estrutura reconhecida são compactados em
linhas `@pass [id,nome,duration_ms,tipo]`. O cabeçalho informa colunas, contagem,
tamanho e SHA-256 do original. Mensagens de falha, assertions multilinha,
warnings, skips, TODOs e qualquer linha desconhecida permanecem literais.
`expand_tap`, em `scripts/local-ai/compact_output.py`, reconstrói a saída, e o
formatador exige igualdade byte a byte antes de entregá-la. A redução mínima
é 15% incluindo o envelope; o limiar é 4.800 bytes e o limite de buffer é
8 MiB. Acima desse limite, a saída segue integralmente em streaming. O comando
mantém seu código de saída, argumentos literais e cancelamento por grupo de
processos; não use este wrapper em terminais interativos ou serviços duradouros.

O lançamento usa Python da biblioteca padrão para evitar o custo de iniciar
outro processo Node. A biblioteca de contagem de tokens é usada somente pelo
benchmark, fora do runtime. Resultados e método ficam em
[`benchmarks/local-context-output/README.md`](benchmarks/local-context-output/README.md).
As contagens `o200k_base` se referem a texto das saídas, não a tokens faturados
ou economia percentual da conversa inteira. Não entram nos contadores de
inferência, GPU ou recibos de compressão generativa. Para rollback, execute o
comando original sem o wrapper; hooks e runtime MCP não foram alterados.

O runtime 1.3.3 promoveu historicamente `summarize-log` com pelo menos 3.000
tokens estimados e o gate `deterministic-log-anchors-v1`. O pivot restrito de
2026-08-25 substituiu essa política: em 90 casos de holdout, os fatos
determinísticos preservaram 100% dos fatos críticos com 12.205 tokens estimados,
enquanto o braço determinístico + resumo local usou 18.292. Como a etapa local
aumentou o contexto em 49,87%, a decisão vigente é `DETERMINISTIC_ONLY` e não há
perfil generativo de compressão promovido. Observações antigas continuam
auditáveis, mas não autorizam novas chamadas operacionais.

A única expansão local aprovada é um canário separado de extração estruturada
residual, desligado por padrão. Ele não é rota de compressão: exige parser
determinístico primeiro, as flags global e independente, bucket estável abaixo
de 10%, validação campo a campo contra a fonte e fallback GPT direto. A fonte
canônica da mudança é
[`LOCAL_AI_RESTRICTED_PIVOT_2026-08-25.md`](LOCAL_AI_RESTRICTED_PIVOT_2026-08-25.md).

Em 2026-08-25, a capacidade operacional foi instalada de forma controlada. Os
defaults públicos continuam `false` e rollout `0`; o override privado efetivo
habilita exclusivamente `structured_extraction` em 10%. O tool MCP
`local_ai_structured_extract` executa parser, residual, coorte SHA-256 estável,
uma única inferência com `qwen2.5-coder:14b`, validação source-anchored e aceite
ou fallback GPT. O breaker persistente e o kill switch são fail-closed. As 21
sondas, incluindo uma inferência real na RTX, ficaram explicitamente excluídas
das métricas operacionais. Como ainda não houve tentativa de produção, o estado
é `CANARY_ACTIVE_INSUFFICIENT_OPERATIONAL_SAMPLE` e a única decisão permitida é
`KEEP_AT_10_PERCENT`. Evidências sanitizadas ficam em
[`benchmarks/local-ai-structured-extraction-canary/`](benchmarks/local-ai-structured-extraction-canary/README.md).

O benchmark misto v8 evita extrapolar a redução de logs para todo o sistema.
Com 14 pares em sete classes e uma carga sintética ponderada de 100 tarefas
equivalentes, `gpt-5.6-terra`/`medium` consumiu 1.675.620 tokens ponderados no
controle e 1.568.475 após o roteamento: 6,39% de economia global. Somente os
logs foram elegíveis; nesse estrato a economia foi 30,10%. Ambos os braços
passaram 14/14 oráculos funcionais, sem perda relevante ou divergência. O custo
foi latência: nos logs, a média end-to-end subiu de 6,502 para 15,660 segundos.
Pesos e limitações estão em `docs/LOCAL_AI_BENCHMARK_2026-08-16.md`.

O benchmark de alto potencial, revisado no schema v2 em 2026-08-24, excluiu
`summarize-log` e avaliou 100 casos em extração, classificação, seleção de
arquivos, agrupamento de erros e resumo factual de diffs. Houve 70 tentativas
de tarefa e 86 inferências contando o braço local-only de seleção: 27 resultados
foram utilizáveis e 43 caíram em fallback. A auditoria separou 32 ocorrências
categóricas de erro crítico em 25 casos únicos. O braço determinístico passou o
gate das fixtures em 100/100, mas a independência do ground truth ficou
`INSUFFICIENT_EVIDENCE`; esse número não é tratado como comparação independente.
A redução de 37,35% e os 88.748 tokens potencialmente evitados são estimativas
do cenário GPT simulado, não medição do GPT-5.6. Todas as classes receberam
`DETERMINISTIC_FIRST`, nenhuma apresentou vantagem operacional e o roteamento
de produção permanece inalterado. O relatório completo está em
[`LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md`](LOCAL_AI_HIGH_POTENTIAL_BENCHMARK_2026-08-24.md).

O sucessor quality-first de 2026-08-25 congelou um novo conjunto residual de
100 casos (25 calibração, 75 holdout), repetiu as 100 fixtures antigas para cada
modelo e avaliou verifier separadamente. Foram 983 inferências reais com
`qwen2.5-coder:14b`, `north-mini-code-1.0:q4_K_M` e
`devstral-small-2:24b-instruct-2512-q4_K_M`. `qwen3.8:27b` ficou
`NOT_RUN_RUNTIME_INCOMPATIBLE` e `qwen3-coder-next:q4_K_M`,
`NOT_RUN_RESOURCE_CONSTRAINT`. Nenhum challenger superou todos os gates em
qualquer atividade. Extração empatou em 15/15 entre os três e, portanto, não
superou o baseline; as demais classes tiveram erros críticos e fallback alto.
O roteamento continua `shadow/disabled`, sem primary ou verifier local em
produção. O registro por atividade existe atrás de
`LOCAL_AI_QUALITY_PIPELINE_ENABLED` e falha diretamente para GPT quando não há
promoção válida. O relatório completo e os hashes estão em
[`LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md`](LOCAL_AI_QUALITY_BAKEOFF_2026-08-25.md).

O hook `PostToolUse` é versionado apenas neste projeto e precisa ser aprovado no
Codex em `/hooks` depois de sua instalação ou de qualquer alteração. Ele atua
somente quando uma saída grande já foi produzida; não analisa o prompt nem cria
uma etapa de confirmação. A aprovação é vinculada ao conteúdo do hook; uma
alteração exige nova revisão. Consulte a documentação oficial de
[hooks do Codex](https://learn.chatgpt.com/docs/hooks).

### Aprovação obrigatória do hook por cliente

Esta verificação interativa faz parte da instalação e manutenção, não é uma
etapa opcional. Repita-a depois de um novo clone ou instalação, da reconstrução
ou atualização do cliente que executa o Codex e sempre que `.codex/hooks.json`
mudar. A confiança fica no estado do cliente: o CLI do `ai-bridge` usa o volume
com o `HOME` do usuário do contêiner, enquanto a extensão do VS Code usa o
`HOME` do host. Portanto, aprovar em um deles não ativa o outro.

Para prompts enviados pelo bridge, abra o CLI do contêiner:

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

O projeto também possui hooks `UserPromptSubmit` e `Stop` para revisão de
memória pública: o primeiro entrega contexto interno e o segundo verifica o
checkpoint sem gerar prompt de continuação no chat. Depois de revisar a definição,
confirme ambos com `Installed = 1` e `Active = 1`; eles são independentes da
redução de saídas do `PostToolUse`.
Seu contrato, limites e teste de aceitação ficam em
`docs/MEMORIA_VERSIONADA_AGENTES.md`.

`PreToolUse = 0` é esperado porque este projeto não usa preflight de prompt. A
mera presença de `.codex/hooks.json` não comprova que o hook está ativo. Não use
opções de bypass de trust; se a tabela não mostrar `PostToolUse` como instalado
e ativo, conclua a revisão pela própria interface antes de validar o roteamento.

Para prompts enviados pela extensão do VS Code, abra `/hooks` com o Codex que
vem na própria extensão, usando o `HOME` do host e este checkout. Confirme a
mesma tabela no cliente da extensão. Neste checkout, o launcher somente localiza
e abre o binário da extensão; ele não aprova nem contorna a confiança:

```bash
cd /mnt/data/docker
./local-ai-integration/review-vscode-hooks.sh
```

Depois da aprovação ou de uma atualização da extensão, execute
`Developer: Reload Window` pela paleta de comandos e abra uma nova conversa. O
`app-server` mantém o conjunto de hooks e a confiança carregados no início; uma
conversa já aberta pode continuar reportando `HOOK_NOT_ACTIVE` até a janela ser
recarregada.

Quando a extração determinística é útil em uma chamada Bash observável, o hook
retorna `continue: false` com contexto adicional limitado. A cobertura de
chamadas aninhadas depende do cliente. A documentação atual admite hooks em
Code Mode e distingue o feedback visível do valor retornado à promessa
JavaScript; portanto receber feedback não autoriza emitir novamente o resultado
bruto. Consulte a [semântica oficial de hooks](https://learn.chatgpt.com/docs/hooks).
Mantenha a saída dentro da orquestração até concluir a redução, ou use o
formatador TAP antes da fronteira da ferramenta. Os recibos
`code-mode-orchestrator-v1` são evidência histórica: não crie novos recibos de
compressão enquanto os perfis generativos continuarem sem promoção.

## Política de roteamento e auditoria

O objetivo não é ocupar a RTX em todos os prompts. No estado vigente, a ordem
para compressão de contexto é:

```text
ferramenta determinística -> fatos determinísticos quando aplicável -> Codex/OpenAI
```

O `routing.py` da release fixada torna a decisão reproduzível sem inferência. Ele
usa tamanho estimado, tipo da tarefa, compressibilidade esperada, helper
compatível, disponibilidade verificada de forma preguiçosa e suficiência de uma
ferramenta determinística. Os valores iniciais vêm do helper com contexto
efetivo mínimo de 8.192 tokens e do benchmark local validado; a suíte de
workloads os protege contra regressão.

| Tipo | Mínimo estimado | Máximo bruto confiável | Economia mínima | Compressão |
| --- | ---: | ---: | ---: | --- |
| `classify-error` | 800 tokens | sem máximo após filtro de sinais | 500 tokens | alta |
| `analyze-tests` | 900 tokens | sem máximo após filtro de sinais | 600 tokens | alta |
| `summarize-log` | sem rota generativa | sem máximo após filtro de sinais | fatos determinísticos | alta |
| `review-diff` / `inspect-files` | 1.200 tokens | 3.000 tokens | 700 tokens | média |
| `summarize-document` | 1.200 tokens | 3.000 tokens | 700 tokens | média |
| `summarize-memory` pelo MCP | 1.200 tokens | 6.000 tokens | 700 tokens | média |

Com o gerador `qwen2.5-coder:14b`, todos os perfis generativos de compressão
ficam em `LOCAL_AI_NOT_BENEFICIAL`; só rodam com `LOCAL_AI_FORCE=1` em benchmark
diagnóstico e não formam oportunidades perdidas. `summarize-log` agora usa o
extrator determinístico de fatos, sinais, stack/path e valores críticos, sem
inferência. Truncamento excessivo, mais sinais do que o limite seguro ou redução
insuficiente devolvem o contexto bruto. Os antigos jobs com
`deterministic-log-anchors-v1` permanecem na telemetria histórica com sua prova
de entrega original, mas não definem o roteamento atual.

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
$HOME/.local/share/local-ai-rtx/current/local-ai route analyze-tests --input-chars 32000
```

O resultado `LOCAL_AI_ELIGIBLE` é apenas uma prévia: a chamada normal ao helper
registra o resultado final como `LOCAL_AI_USED` ou
`LOCAL_AI_UNNECESSARY_CALL`. Se uma oportunidade clara for conscientemente
ignorada, registre-a sem fornecer o conteúdo bruto:

```bash
$HOME/.local/share/local-ai-rtx/current/local-ai route review-diff --input-chars 24000 --outcome skipped
```

Para testar uma indisponibilidade sem desligar a GPU, use uma avaliação
controlada e sem chamada de rede:

```bash
$HOME/.local/share/local-ai-rtx/current/local-ai route analyze-tests --input-chars 32000 --availability unavailable
```

O `UserPromptSubmit` de memória não chama a RTX nem exige confirmação inicial
ou a palavra `feito`; ele apenas prepara o checkpoint e o contexto interno.
O `PostToolUse` do runtime fixado detecta padrões de credenciais e reduz somente
logs grandes elegíveis por extração determinística. Não consulta o MCP nem
inicia inferência enquanto os perfis de compressão estão sem promoção.
A classificação `analyze-tests` não ativa essa rota; o formatador TAP explícito
cobre essa lacuna sem mudar hooks. Saídas pequenas, comandos sensíveis e perfis
não promovidos seguem o caminho original. Anexos já enviados no prompt estão
fora desse ponto de interceptação; nunca os envie integralmente apenas para
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
auditoria aceita esse marcador como evidência do job do hook. Para Code Mode,
ela só aceita o envelope v1 quando a rota elegível veio antes da compressão e o
`job_id` e o `result` coincidem com o evento MCP; uma compressão MCP isolada não
é classificada como entrega.

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
$HOME/.local/share/local-ai-rtx/current/local-ai memory-audit
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
$HOME/.local/share/local-ai-rtx/current/memory_context.py retrieve 'codex local ai' --query 'telemetria RTX'
$HOME/.local/share/local-ai-rtx/current/memory_context.py materialize 'codex local ai' --query 'telemetria RTX' \
  | $HOME/.local/share/local-ai-rtx/current/local-ai summarize-memory --memory-topic 'codex-local-ai' --context-tokens 8192
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

### Painel operacional calculado no Node-RED

A aba `uso-rtx` consome exclusivamente o contrato MQTT do tab `metricas_rtx`:
`sensor.rtx_painel` contém disponibilidade, razões, períodos, roteamento,
série diária e histórico limitado; sensores numéricos separados alimentam tiles
e gráficos com localização pt-BR. Os antigos sensores `codex_*` permanecem por
compatibilidade com outros consumidores, mas não calculam este painel.

O bridge continua produtor dos contadores sanitizados e dos recibos de entrega.
O Node-RED valida a idade das observações, calcula saldo bruto menos custo do
gate, reconcilia esse saldo com o contador confirmado e calcula taxas usando
somente denominadores válidos. Inconsistência, dado ausente ou vencido produz
`null`, nunca zero medido. Zero tentativas produz saldo zero e taxas sem amostra.
Os contadores podem incluir processamento determinístico na CPU: não são prova
de inferência na RTX nem medição de cobrança OpenAI. Benchmarks e diagnósticos
ficam separados das tentativas operacionais. O formatador local de TAP não é
inferência e não é acrescentado a esses contadores.

As sondas passivas publicam `collected_at`, inclusive quando estado/valores não
mudam. O canvas lê snapshots do HA a cada 2 s; não chama recovery, Wake-on-LAN,
SSH nem Ollama. Parâmetros visíveis delimitam idades e quantidade de jobs; o
validador preserva a última configuração válida. A disponibilidade do painel
usa também o LWT do Node-RED e expiração MQTT de 45 s. O discovery retido é
renovado a cada minuto. O sensor de atributos é excluído do Recorder; os sensores
numéricos preservam histórico. GPU, VRAM e potência ociosas permanecem sem
amostra, sem produzir zeros artificiais. Os gráficos novos começam com seus
próprios sensores; o histórico legado permanece preservado.

O layout separa Agora, Resultado de hoje, Qualidade, Evolução, Execuções e
Amostras da GPU. Contagens usam as janelas UTC do produtor; horários individuais
são apresentados no fuso local. Jinja se limita a localização, tabelas e rótulos
já decididos no contrato; nenhuma taxa, validade ou classificação é decidida no
card. Os detalhes de benchmarks continuam disponíveis nos sensores de diagnóstico
e nos artefatos versionados, fora do painel operacional.

Fontes: `nodered/tools/install-rtx-metrics-flow.mjs` e funções
`nodered/tools/functions/rtx-metrics-*.js`. Regenerar com
`npm --prefix nodered run flows:update-rtx-metrics`. Os controles TESTE 0–5
percorrem a normalização e os cálculos reais, terminando no gate anterior ao MQTT.
Após reset, executar nominal, offline, stale/unknown, vazio e fonte inválida;
repetir nominal comprova recuperação. Estado sintético é separado do estado de
produção. Regressões: `test-rtx-metrics-flow.mjs`, replay do observador global e
`homeassistant/tests/test_chat_rtx_dashboard_layout.py`.

### Contrato de telemetria preservado

O helper não grava prompt, diff, código-fonte, resposta do modelo nem
credenciais. Em `.agent-history/` (ignorado pelo Git) ele preserva somente
metadados: tarefa, modelo, duração, contagens, status e amostras de GPU/VRAM.
O schema 19 distingue economia provisória aprovada pelo gate de economia
confirmada como contexto realmente utilizado pelo modelo principal. Uma
confirmação exige sucesso, delta e gate mensurados, validador independente,
nenhum truncamento e um dos dois transportes: origem `post-tool-hook`, ou recibo
`code-mode-orchestrator-v1` ligado a um job MCP de mesmo tamanho de entrada.
CLI, MCP direto, benchmarks e histórico sem esse vínculo valem zero confirmado.
O recibo guarda somente `job_id`, tarefa, transporte, tamanho e horário; nunca
persiste comando, entrada ou saída. A auditoria retrospectiva também exige que
o envelope emitido tenha o mesmo `job_id` e o mesmo `result` do evento MCP.
Os mesmos totais são agregados por dia, tarefa, gerador e par
gerador/validador; pares sem validação independente permanecem identificados e
reivindicam zero confirmado. O validador normalmente é um modelo distinto do
gerador. A única exceção promovida é o gate exato de logs, identificado por
`verifier_model=deterministic:log-anchors-v1`, sem segunda inferência.
Cada candidato passa primeiro por validações determinísticas específicas da
tarefa; fora do perfil extrativo, passa depois por um verificador de fidelidade
com nota mínima de 90%. A nota
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
omitidas e quantos caracteres chegaram ao modelo local. No perfil 1.3.3, o
modelo recebe IDs estáveis `L0001` etc. e seleciona de uma a quatro linhas
rotineiras. A saída entregue é reconstruída: `errors` recebe até 16 linhas
críticas exatas, inclusive continuação de stack/path; `routine_context` recebe
somente IDs resolvidos para linhas exatas; arquivos são extraídos localmente e
ações geradas são removidas. Se qualquer seletor não vier da fonte, houver
truncamento ou o limite crítico for excedido, uma segunda tentativa é permitida
e depois o corpo bruto segue pelo fallback com economia zero.

O bridge renova sua própria sondagem passiva de saúde a cada minuto (e ao
iniciar), usando o helper de disponibilidade, não um hook de prompt. Essa
checagem só consulta endpoint/GPU: não inicia modelo, não gera carga artificial
e não reinicia nem reconfigura o host remoto.

O tab versionado `recuperacao_rtx` do Node-RED acompanha esse estado a cada
minuto sem disparar recuperação. Somente o inject manual explícito do tab pode
chamar o endpoint autenticado `POST /local-ai/recover` do bridge. O bridge abre
uma sessão JSON-RPC real com o MCP `local-ai-rtx` e solicita
`local_ai_status`; somente então o helper pode executar Wake-on-LAN e as duas
tentativas limitadas de recuperação.
O canvas mostra saúde, despacho, resultado e motivo sanitizado, incluindo
comando ausente, SSH indisponível, falha de WSL/Ollama, portproxy, timeout ou
listener ausente. Requisições concorrentes compartilham a mesma recuperação.

O cooldown entre pedidos explícitos é uma política visual validada no canvas:
o padrão é **60 segundos**, com limite inteiro de **10 a 600 segundos**. Um
valor inválido é rejeitado sem substituir a última política persistente. A
disponibilidade, o pedido explícito, `test_mode`, o término do cooldown e a
rota status/alerta/recovery são switches nomeados; JavaScript permanece apenas
para normalizar o envelope HTTP, ler/persistir estado e montar o incidente.
O produtor bruto `sensor.codex_rtx_host_reachability_raw` confirma passivamente,
a cada 30 segundos, se o computador está alcançável por ICMP ou pela porta SSH
já configurada em `pc_power_*`; ele nunca acorda nem altera a máquina. No canvas,
o estado `offline` silencia a indisponibilidade esperada. Somente `online` com o
endpoint indisponível gera um alerta de domínio, deduplicado visualmente uma vez
por incidente; `unknown` falha de forma silenciosa e não é convertido em
`node_error`.

Os controles `TESTE` do tab atravessam a mesma normalização e decisão, mas o
gate final os envia exclusivamente ao terminal dry-run (`simulated: true`,
`dispatched: false`). O fluxo não contém SSH, PowerShell, Wake-on-LAN nem
credenciais; o token do bridge vem apenas do ambiente do container. Desse modo,
o polling passivo nunca acorda nem altera o host; a recuperação exige a ação
manual e não cria uma segunda rotina mutável fora do MCP auditável.

Isso se aplica à recuperação remota e ao polling residencial. O hook nativo de
inicialização/retomada descrito acima apenas republica a porta restrita quando
o backend já responde; ele não executa o recovery remoto nem reinicia serviços
compartilhados.

A sondagem de GPU mantém `StrictHostKeyChecking=yes` e usa por padrão o arquivo
`known_hosts` persistente ao lado de `gpu_probe.ssh_key_path`. Isso é necessário
porque o `$HOME` do container do Home Assistant é efêmero: confiar apenas em
`/root/.ssh/known_hosts` faria a telemetria degradar depois de uma recriação do
container, mesmo com Ollama e RTX saudáveis.

A imagem `ai-bridge` inclui `python3`, pois o helper versionado
O executável `$HOME/.local/share/local-ai-rtx/current/local-ai` é Python. Assim, uma tarefa elegível enviada pelo
chat do Home Assistant consegue executar a primeira passagem na RTX, em vez de
falhar localmente por ausência do interpretador.

O bridge executa o mesmo servidor `local-ai-rtx` instalado no host. No startup,
um bootstrap idempotente mantém um bloco gerenciado em
`/home/node/.codex/config.toml`, com aprovação automática das ferramentas e o
runtime indicado por `CODEX_LOCAL_AI_RUNTIME_DIR` montado em
`/opt/local-ai-rtx` somente para leitura. Se esse runtime não estiver
disponível, o bridge continua atendendo e o Codex aplica o fallback normal.
O diretório privado do runtime precisa permitir leitura e travessia ao grupo
`docker`; seu conteúdo continua sem permissão de escrita pelo container.
Portanto, tanto o Codex do IDE quanto o chat do Home Assistant aplicam `local_ai_status`,
`local_ai_route` e `local_ai_compress_context` sem o usuário precisar pedir o
uso da RTX.

O bridge expõe quatro endpoints locais sem conteúdo de conversa:

| Endpoint | Dados | Atualização usada no HA |
| --- | --- | --- |
| `GET /usage` | uso/limites do Codex e histórico agregado Local AI | 2 s |
| `GET /local-ai/live` | job atual, amostra instantânea e chats ativos | 1 s |
| `GET /local-ai/history` | até 40 jobs sanitizados das últimas 48 horas | 30 s |
| `POST /local-ai/recover` | recovery autenticado via `local_ai_status` do MCP | inject manual explícito no Node-RED |

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
sessões locais do host configurado em `CODEX_HOST_SESSIONS_DIR`. A imagem usa
`BRIDGE_UID`/`BRIDGE_GID`, derivados de `REPO_UID`/`REPO_GID` pelo Compose, para
executar como usuário não root com a identidade do dono do checkout. Isso
permite ler os diretórios `0700` e arquivos `0600` novos do Codex pela montagem
somente leitura, preservando suas permissões. Ao migrar uma instalação cujo
bridge usava outro UID, reconcilie somente arquivos desse UID nos dois volumes
de autenticação e no diretório de estado do bridge; preserve conteúdo, modos
e grupos compartilhados. Faça a migração antes de iniciar a nova imagem,
pois o histórico também precisa ajustar os modos dos próprios arquivos.

Se uma fonte ainda negar leitura (`EACCES`/`EPERM`),
o agregado responde `status: degraded`, razão `session_source_unreadable` e
totais/analytics nulos; limites de conta e telemetria Local AI independentes
continuam no contrato. A próxima leitura tenta novamente. Totais parciais não
podem ser publicados como completos. Os endpoints de telemetria serializam o
resultado antes dos headers HTTP: outras falhas retornam JSON 500 sem encerrar
o processo ou interromper `/health` e o chat. O bridge verifica metadados dos
arquivos a cada ciclo e só relê uma sessão que tenha mudado; não
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

### Histórico da apresentação anterior (substituído pelo contrato acima)

No painel RTX, **chamadas Local AI** e **saldo líquido equivalente** ficam em
gráficos separados: chamadas contam tentativas de tarefas; o saldo soma somente
a diferença entre o contexto recebido e resultados que passaram pelo gate de
qualidade e tiveram uso confirmado pelo `PostToolUse` ou pelo recibo Code Mode,
descontando o custo local do verificador. O waterfall separa resultados com uso não confirmado dos
que efetivamente substituíram contexto e mostra a cobertura dessa confirmação.
Tabelas inferiores expõem a redução ponderada por tarefa e por par
gerador/verificador, sempre usando as tentativas operacionais do segmento como
denominador.
Como os tokenizadores podem diferir, ele é um índice conservador, não uma
contagem faturável da OpenAI. Falhas, descartes e benchmarks diagnósticos valem
zero. O
overhead do envelope de ferramenta/API da OpenAI não é mensurável pelo helper e
fica explicitamente marcado como não mensurado, portanto o valor não é um
registro de cobrança oficial. O resumo operacional expõe no máximo cinco jobs recentes e remove
detalhes de endpoint para permanecer abaixo do limite de atributos do Home
Assistant e preservar a telemetria no Recorder.

O painel também contém **Benchmark RTX — quality-first por atividade**. O
bridge lê somente o agregado versionado e sanitizado, separado da telemetria
operacional, e mostra 15 linhas de primary, dez de verifier, cinco decisões,
inventário dos modelos, recursos, dataset e hashes. Respostas, thinking,
perfis completos e os 983 eventos de benchmark não são expostos como atributos
do Home Assistant. A marcação `measured`, `estimated` ou `not_tested` impede
apresentar tokens GPT estimados como medição real. O resultado histórico de
`summarize-log` continua identificável separadamente, mas a política vigente é
determinística; todas as chamadas do bake-off valem zero nos contadores
operacionais.

O card separado **Pivot RTX — expansão restrita** lê
`local_ai.benchmark_restricted_pivot`. Ele mostra as quatro linhas de trabalho,
suas decisões, modelos/digests e agregados sanitizados: extração residual,
comparação A/B/C dos logs, retrieval determinístico/embedding/híbrido e o skip
da similaridade de erros. Casos, queries, caminhos recuperados, chunks e eventos
brutos não entram nos atributos. Valores ausentes continuam ausentes, e cada
resultado é marcado como `MEASURED`, `ESTIMATED` ou `NOT_TESTED`. O benchmark
declara economia operacional zero e permanece fora do waterfall.

O A/B de entrega v6 reproduz, somente por metadados, o controle bruto e o
tratamento de um job Code Mode confirmado. A primeira observação mediu 4.074
tokens de controle, 149 no tratamento e 3.925 úteis, ou 96,3%. Esse percentual
é específico da observação; o benchmark offline v5 mais amplo permanece em
94,8% com 8/8 aceites. Os limites estão em
`docs/LOCAL_AI_BENCHMARK_2026-08-16.md`.

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
aprovados com e sem custo mensurado, uso não confirmado e uso confirmado, sem
tabela. Assim, cada diferença entre duas etapas aparece como uma saída visível,
em vez de parecer perda de dados.
Benchmarks ganham contador diagnóstico separado e
não contaminam chamadas ou falhas operacionais. Depois o waterfall muda
explicitamente de unidade para contexto total tentado, tokens Codex totais,
contexto OpenAI evitado com uso confirmado, custo local do gate desses resultados,
saldo líquido equivalente e redução útil operacional. A redução útil divide o
saldo líquido pela base contrafactual da mesma janela UTC — tokens Codex totais
observados + saldo útil —, e não pelo contexto tentado pela Local AI. Assim, a
fórmula é `saldo útil / (tokens totais + saldo útil)`. A regra conservadora continua
`max(0, contexto evitado - tokens locais do verificador)`, mas o painel explica
que os tokenizadores são diferentes e que o saldo não é uma contagem faturável.
Resultados legados cujo custo do verificador ou uso não pode ser provado
preservam valores provisórios para auditoria, mas valem zero líquido. Fallbacks
aparecem apenas no diagnóstico, pois a notificação pode se sobrepor a falhas,
rejeições ou desvios e não forma uma etapa somável do waterfall.

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
de calendário UTC e **Total preservado** cobre toda a telemetria. Somente jobs
com `quality_accepted: true`, uso confirmado e delta superior ao custo medido do
verificador aumentam o valor; descartes, falhas, benchmarks e legado sem custo
ou entrega comprováveis contribuem com zero.
`confirmed_gross_useful_context_tokens_avoided` mantém o delta confirmado antes
do gate e `confirmed_quality_validation_tokens` mantém o custo correspondente,
permitindo reconciliar o líquido sem misturar resultados provisórios ou
gerações descartadas.

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
redução útil. Ela divide o saldo líquido equivalente pela base contrafactual
(`tokens totais + saldo útil`); descartes e falhas entram no
denominador com economia zero. A referência controlada explicita separadamente redução ponderada, mediana,
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
$HOME/.local/share/local-ai-rtx/current/local-ai status
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
| Regra do portproxy existe, mas `11435` continua em timeout | confirme o listener Windows em `:11435`; uma regra exibida por `netsh interface portproxy show` não prova que ela está ativa. Use `local_ai_status` pelo MCP para acionar somente a recuperação revisada (IP Helper e o proxy exato); não recrie regras manualmente nem exponha `11434`. |
| Recuperação do MCP falha | confirme o CI e os testes da release fixada de `local-ai-rtx`; revise a configuração privada sem expor MAC, endpoint, usuário, chave ou `known_hosts` |
| `11434` conecta pela LAN | desabilite a exposição direta e mantenha somente o portproxy restrito |
| Ollama responde mas sem GPU | `ollama ps`, `nvidia-smi`, driver NVIDIA/WSL e tamanho/quantização do modelo |
| CPU offload | reduza o modelo/contexto; não assuma que uma resposta rápida significa GPU integral |
| RTX não aparece no painel | `GET /local-ai/live`, arquivo privado de telemetria e sensores do pacote HA |
| Feedback de hook em Code Mode, mas saída bruta ainda presente | não reemita o objeto JavaScript bruto; teste a cobertura do cliente e, para TAP grande, use `python3 scripts/local-ai/run.py` antes da entrega |
| Roteamento automático de `Bash` direto não roda | identifique o cliente que envia os prompts; execute `/hooks` nesse mesmo cliente e estado, confirme `PostToolUse` com `Installed = 1` e `Active = 1` e, para a extensão do VS Code, recarregue a janela e abra uma conversa nova |

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
5. Em cada cliente Codex que enviará prompts, execute `/hooks`, revise o hook do
   projeto e confirme obrigatoriamente `PostToolUse` com `Installed = 1` e
   `Active = 1`. Recarregue o cliente depois da aprovação; no VS Code, use
   `Developer: Reload Window` e abra uma conversa nova. Mantenha `AGENTS.md`
   apontando para o MCP global. Não configure `UserPromptSubmit`.
6. Suba o bridge e o Home Assistant, então valide `/usage`, `/local-ai/live` e
   as duas abas do dashboard.

Antes de publicar um fork, execute `node scripts/docs-check.mjs` e
`scripts/security-scan.sh`. Não versione endpoints reais, regras de firewall,
chaves SSH, telemetria, prompts ou histórico de conversas.
