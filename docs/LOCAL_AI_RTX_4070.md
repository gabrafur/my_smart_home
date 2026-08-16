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
  "preflight_command": "/caminho/privado/local-ai-preflight"
}
```

O preflight só confirma disponibilidade e, quando configurado, sonda a GPU por
SSH/WSL. Ele não instala, reinicia, desperta ou reconfigura infraestrutura. As
variáveis `LOCAL_AI_ENABLED=0`, `LOCAL_AI_ENDPOINT`, `LOCAL_AI_MODEL` e
`LOCAL_AI_FORCE` permitem controle local; `LOCAL_AI_FORCE` é diagnóstico e não
autoriza delegação inadequada.

Após a confirmação normal do roteamento de modelo, a política pode executar um
preflight curto uma vez por conversa. Em tarefas elegíveis com material grande
(referência: aproximadamente 6.000 caracteres), ela usa
`./scripts/local-ai/local-ai` para `review-diff`, `summarize-log`,
`analyze-tests`, `inspect-files` ou `classify-error`. Dados secretos,
decisões de segurança, migrações, operações destrutivas e revisão final nunca
são enviados ao modelo local.

O hook é privado e precisa ser aprovado no Codex em `/hooks` depois de sua
instalação ou de qualquer alteração. A aprovação é vinculada ao conteúdo do
hook; uma alteração exige nova revisão. Consulte a documentação oficial de
[hooks do Codex](https://learn.chatgpt.com/docs/hooks).

## Telemetria e painéis

O helper não grava prompt, diff, código-fonte, resposta do modelo nem
credenciais. Em `.agent-history/` (ignorado pelo Git) ele preserva somente
metadados: tarefa, modelo, duração, contagens, status e amostras de GPU/VRAM.

O bridge expõe dois endpoints locais sem conteúdo de conversa:

| Endpoint | Dados | Atualização usada no HA |
| --- | --- | --- |
| `GET /usage` | uso/limites do Codex e histórico agregado Local AI | 10 s |
| `GET /local-ai/live` | job atual, amostra instantânea e chats ativos | 1 s |

No dashboard **Chat** há duas abas separadas:

- **Uso do Codex** (`/chat-assistants/uso-codex`): limite, créditos, cache e
  tokens do Codex, sem cards RTX.
- **RTX 4070** (`/chat-assistants/uso-rtx`): estado em tempo real, GPU, VRAM,
  potência, modelo/tarefa e chats que usam a RTX.

Os chats aparecem como identificadores curtos (`Codex #…`), não títulos ou
prompts. Isso dá correlação operacional sem vazar conteúdo da conversa.

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
