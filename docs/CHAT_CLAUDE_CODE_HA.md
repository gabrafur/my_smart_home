# Chat "Claude Code (Full Access)" dentro do Home Assistant

## O que é

Dois assistentes de desenvolvimento no HA, separados do
`conversation.claude_conversation` nativo, com acesso **irrestrito** a shell e
Docker no host: **Claude Code (Full Access)** e **Codex**. O serviço
`ai-bridge` executa o CLI selecionado em modo não interativo e mantém as
sessões separadas por conversa.

No card do Codex, toda solicitação recebe automaticamente um contexto confiável
com o nome do usuário autenticado no Home Assistant e com a fronteira
operacional: somente este servidor, o repositório e os softwares, serviços,
contêineres e integrações instalados nele. O nome é tratado como dado de
identidade, não como instrução. O card exibe permanentemente essa fronteira e o
usuário atual, sem exigir que a pessoa repita o contexto em cada mensagem.

O código-fonte fica em `ia-bridge/`. O serviço e o container usam o
identificador `ai-bridge`; os volumes de autenticação existentes são
preservados para compatibilidade com restauração e instalações anteriores.

**Restrito a um único usuário do HA** (o `user_id` do administrador, lido de
`/config/.storage/auth`). Qualquer outra conta recebe recusa automática do
agente. O id fica no config entry da integração, nunca no código — este
repositório é público.

**Risco aceito conscientemente**: quem estiver logado com essa conta no app/navegador
do HA herda esse poder sem confirmação por ação. Vale considerar 2FA nessa conta.

## Por que os comandos abaixo precisam ser rodados manualmente

Esta sessão do Claude Code tem um classificador de segurança que bloqueia a
própria IA de executar `claude --dangerously-skip-permissions` com o socket do
Docker montado — por ser, na prática, "criar um agente sem sandbox". Os
arquivos já foram todos preparados; falta só você subir e conectar as peças.

## Passo a passo

### 1. Build e subida do bridge

```bash
cd CAMINHO_DO_REPOSITORIO
docker compose build ai-bridge
docker compose up -d ai-bridge
docker compose logs -f ai-bridge   # deve mostrar "agent bridge listening on :8099"
```

### 1.5. Login com a assinatura (Pro/Max), não API key avulsa

O bridge está configurado para **não** usar `ANTHROPIC_API_KEY` (billing por
token) e sim o login OAuth da sua assinatura mensal, via `claude setup-token`.
As credenciais do Claude ficam persistidas no volume legado
`claude-bridge-auth`, então esse
login só precisa ser feito uma vez (sobrevive a restart/rebuild do container).

```bash
docker exec -it ai-bridge claude setup-token
```

Isso vai mostrar uma URL para abrir no navegador e pedir um código de
confirmação — siga o fluxo normalmente (é o mesmo tipo de login usado pelo
Claude Code no terminal). Confirme que funcionou com:

```bash
docker exec ai-bridge claude auth status
```

### 1.6. Login do Codex com a conta ChatGPT

O Codex usa um volume separado (`codex-bridge-auth`) para persistir o login.
Como o container não tem navegador, use o fluxo por código de dispositivo:

```bash
docker exec -it ai-bridge codex login --device-auth
docker exec ai-bridge codex login status
```

Abra no navegador o endereço exibido pelo primeiro comando e informe o código.
O login sobrevive a restart e rebuild do container.

### 2. Testar o bridge isoladamente (antes de plugar no HA)

```bash
TOKEN=$(grep ^AI_BRIDGE_TOKEN .env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8099/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "responda apenas: ok", "conversation_id": "teste-1"}'
```

Deve devolver algo como `{"reply":"ok"}`. Se der erro de autenticação, refaça
o passo 1.5 (`claude setup-token`). Se quiser confirmar que tem acesso real
ao host, teste algo como `"liste os containers docker rodando"` — a resposta
deve bater com `docker ps`.

Para testar o Codex isoladamente, acrescente `"agent":"codex"` ao JSON:

```bash
TOKEN=$(grep ^AI_BRIDGE_TOKEN .env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8099/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","message":"responda apenas: ok","conversation_id":"teste-codex-1"}'
```

### 2.1. Histórico compartilhado com o workspace

Cada turno enviado pelo Home Assistant é gravado no host em
`.agent-history/turns.jsonl`. O mapeamento entre o
`conversation_id` do Home Assistant e a sessão do CLI fica em
`.agent-history/sessions.json`, portanto a conversa continua mesmo depois de
restart ou rebuild do bridge.

Na primeira instalação, crie o diretório com acesso para o usuário do host e o
grupo do Docker usado pelo bridge:

```bash
cd CAMINHO_DO_REPOSITORIO
install -d -m 2770 -g "$(stat -c '%g' /var/run/docker.sock)" .agent-history
```

O diretório contém conteúdo privado e está ignorado pelo Git. Para consultar
as conversas no workspace usado pelo Codex:

```bash
node scripts/agent-history.mjs list
node scripts/agent-history.mjs show <conversation_id> codex
```

O bridge também oferece leitura autenticada para integrações locais:

```bash
TOKEN=$(grep ^AI_BRIDGE_TOKEN .env | cut -d= -f2-)
curl -s http://127.0.0.1:8099/history/conversations \
  -H "Authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:8099/history?conversation_id=<conversation_id>" \
  -H "Authorization: Bearer $TOKEN"
```

Isso compartilha o conteúdo e a continuidade das conversas. A interface do
Codex não importa essas conversas automaticamente para a lista nativa de chats;
quando solicitado, o agente lê o transcript compartilhado como contexto.

### 2.2. Fila, recuperação e timeout

O bridge serializa requisições que usam o mesmo par `agent:conversation_id`.
Conversas diferentes continuam em paralelo, mas dois prompts simultâneos na
mesma conversa não disputam a mesma sessão do CLI.

Antes de iniciar o CLI, o turno é gravado como `pending`. O resultado reutiliza
o mesmo `id`, e a leitura do histórico mantém apenas a versão mais recente desse
turno. Em uma execução normal não aparece uma segunda entrada; se um restart
interromper o CLI, o prompt permanece visível como pendente para diagnóstico.

O limite coordenado é de **15 minutos**:

- o Compose fixa `BRIDGE_TIMEOUT_MS=900000`;
- o custom component usa `REQUEST_TIMEOUT_SECONDS = 900`;
- o fallback interno do bridge também é de 15 minutos.

Não configure um valor menor apenas no `.env`: o Compose o ignora de propósito
para impedir que uma configuração privada antiga restaure o timeout anterior de
cinco minutos. Para mudar o limite, altere Compose, bridge e custom component na
mesma revisão.

Ao expirar, o bridge encerra todo o grupo de processos do CLI e descarta a
sessão persistida daquela conversa, evitando retomar uma execução incompleta.
Se o Codex reportar conflito de escrita ao retomar uma thread, o bridge remove a
sessão conflitante e tenta uma vez em uma sessão nova. O prompt e o erro final
continuam registrados em `.agent-history/turns.jsonl`.

O `ai-bridge` usa resolvers DNS externos explícitos no Compose, mantendo a
descoberta interna pelo DNS embutido do Docker. O healthcheck também exige que
`chatgpt.com` seja resolvido; assim o contêiner não permanece falsamente
saudável quando apenas o endpoint HTTP local está acessível.

### 3. Restart do Home Assistant (para carregar o custom_component)

```bash
docker compose restart homeassistant
```

Espere ~30-60s o HA voltar (`docker compose logs -f homeassistant` até ver
"Home Assistant initialized").

### 4. Configurar a integração pela UI

1. `http://IP_DO_HOST:8123` → **Configurações → Dispositivos e Serviços**
2. **+ Adicionar Integração** → buscar **"Claude Code Chat"**
3. Preencher:
   - **bridge_url**: `http://127.0.0.1:8099/chat` (já vem preenchido)
   - **bridge_token**: o mesmo valor do `AI_BRIDGE_TOKEN` no `.env`
     (rode `grep AI_BRIDGE_TOKEN .env` pra copiar)
   - **allowed_user_id**: cole o `user_id` do administrador. Pegue em
     `/config/.storage/auth` (chave `users` → `id`) ou em
     **Configurações → Pessoas → (usuário)**, na URL do navegador
4. Depois de criada, vá em **Configurações → Entidades**, busque por "Claude
   Code" e anote o `entity_id` exato gerado (esperado:
   `conversation.claude_code_full_access`, mas confirme). Se vier diferente,
   ajuste o `entity:` do card **Claude Code (Full Access)** em
   `homeassistant/dashboards/chat.yaml`.

### 5. Criar o pipeline "Claude Code (Full Access)"

Este pipeline e somente do Claude Code. O Codex atual usa a aba dedicada
**Codex** do dashboard `Chat`, por meio do card
`homeassistant/www/codex-chat-card-v2.js` e dos comandos WebSocket registrados
pela integracao. Nao crie um segundo tile/pipeline do Codex: isso duplicaria
duas interfaces para a mesma conversa persistente.

Edite o storage do Assist (troque `<ENTITY_ID>` pelo valor confirmado no
passo 4):

```bash
docker exec homeassistant python3 -c "
import json
path = '/config/.storage/assist_pipeline.pipelines'
with open(path) as f:
    data = json.load(f)
data['data']['items'].append({
    'conversation_engine': '<ENTITY_ID>',
    'conversation_language': '*',
    'id': __import__('uuid').uuid4().hex[:26],
    'language': 'pt',
    'name': 'Claude Code (Full Access)',
    'stt_engine': None,
    'stt_language': None,
    'tts_engine': None,
    'tts_language': None,
    'tts_voice': None,
    'wake_word_entity': None,
    'wake_word_id': None,
    'prefer_local_intents': False,
})
with open(path, 'w') as f:
    json.dump(data, f)
print('ok')
"
docker compose restart homeassistant
```

Note que `preferred_item` não é alterado — o pipeline padrão continua sendo o
restrito (`Zé`), então visitantes e o restante da família seguem só com
controle de dispositivos.

### 6. Testar de ponta a ponta pelo chat do HA

No app/navegador, abra o Assist (ícone de balão de fala ou o card "Claude
Code (Full Access)" na aba **Chat**), troque o pipeline no seletor do topo do
popup para **"Claude Code (Full Access)"**, e mande algo que só é possível
com acesso real, ex.:

> quais containers estão rodando agora?

A resposta deve bater com a realidade do host (mesma lista de `docker ps`).

Para o Codex, abra **Chat → Codex**, envie a mesma pergunta e confirme que o
historico reaparece depois de recarregar a pagina. A aba **Assistentes** mantem
somente Claude padrao, Home Assistant e Claude Code (Full Access).

### Painel de uso do Codex

A aba **Chat → Uso do Codex** acompanha as métricas emitidas pelo Codex CLI autenticado
no volume `codex-bridge-auth`. O endpoint local `GET /usage` do bridge devolve
somente o resumo sanitizado de limite, créditos e tokens; prompts e respostas
não fazem parte da resposta. O sensor `Codex Usage Raw`, definido em
`homeassistant/packages/codex_usage.yaml`, consulta esse endpoint a cada dois
segundos.

O card é carregado pelo registro canônico `lovelace.resources`, com
`resource_mode: yaml`, antes de o dashboard tentar instanciá-lo. O parâmetro
`v` contém os 12 primeiros caracteres do SHA-256 do arquivo e o teste
`homeassistant/tests/test_codex_chat_resource.py` impede que arquivo e versão
divirjam. As mensagens permitem seleção e cópia no desktop e por toque
prolongado no celular. Durante uma execução, o rodapé mostra o tempo decorrido
e distingue inicialização, análise e tarefas demoradas. A seleção inicial usa
Luna com reasoning baixo para priorizar latência; Terra e Sol continuam
disponíveis no seletor.

Os arquivos em `/local` recebem cache longo do navegador; quando o card for
alterado, atualize esse hash na mesma implantação para que clientes não
reutilizem um módulo antigo que falhou ao carregar.

Depois de alterar ou instalar esses arquivos, reconstrua o bridge e reinicie o
Home Assistant:

```bash
docker compose build ai-bridge
docker compose up -d ai-bridge
docker compose restart homeassistant
```

Os tokens exibidos abrangem somente as sessões ainda presentes nesse volume.
O saldo e a janela de limite refletem a última métrica que o CLI recebeu; o
painel mostra o horário dessa métrica para deixar eventual defasagem visível.

#### Local AI / RTX 4070

O uso de inferência local fica na aba separada **Chat → RTX 4070**, não na aba
de uso do Codex. O endpoint local `GET /local-ai/live` fornece somente o job
ativo e a amostra de GPU; `Codex RTX Live Raw` o consulta aproximadamente uma
vez por segundo. A página mostra tarefa, modelo, GPU, VRAM, potência e os
identificadores curtos dos chats ativos, sem título ou conteúdo de conversa.

O helper `scripts/local-ai/local-ai` só recebe tarefas delimitadas de primeira
passagem e conserva somente telemetria privada por metadados em
`.agent-history/`. O guia [Codex + Local AI com RTX
4070](LOCAL_AI_RTX_4070.md) descreve a rede, o preflight, a política de
delegação, a aprovação do hook, os comandos de teste e a reprodução em um fork.

A mesma aba possui controles de alertas para o iPhone de resident_primary. O painel
mantém apenas os sensores e as preferências; a avaliação, o cooldown e o push
são executados pelo fluxo **Alertas Codex** do Node-RED. Os limites de atenção,
crítico, eficiência mínima de cache e saldo baixo de créditos podem ser
ajustados no próprio painel. O teste manual de push fica no nó de injeção
**Testar push no iPhone** desse fluxo; instalar ou reiniciar a configuração não
dispara essa notificação.

## Arquivos envolvidos

- `ia-bridge/Dockerfile`, `ia-bridge/server.js`, `ia-bridge/package.json`
- `ia-bridge/history.js`, `ia-bridge/usage.js`, `scripts/agent-history.mjs`, `AGENTS.md`
- `scripts/local-ai/` (helper delimitado, prompts, testes e telemetria privada)
- `.env` (variáveis `CLAUDE_CODE_OAUTH_TOKEN`, `AI_BRIDGE_TOKEN`) e `.env.example`
- `docker-compose.yml` (serviço `ai-bridge`)
- `homeassistant/custom_components/claude_code_chat/` (integração custom)
- `homeassistant/dashboards/chat.yaml` (card novo)
- `homeassistant/packages/codex_usage.yaml`, `homeassistant/tools/codex_usage.py`,
  `homeassistant/tools/codex_rtx_live.py`
- `homeassistant/www/codex-chat-card-v2.js` (aba Codex com historico)
- `homeassistant/.storage/assist_pipeline.pipelines` (pipeline novo, editado no passo 5)
