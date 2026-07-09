# Chat "Claude Code (Full Access)" dentro do Home Assistant

## O que é

Um segundo assistente de chat no HA, separado do `conversation.claude_conversation`
nativo, com acesso **irrestrito** a shell e Docker no host — o mesmo poder que o
Claude Code tem numa sessão de terminal neste repositório. Roda via um serviço
`claude-bridge` (novo container) que executa o Claude Code CLI em modo
não-interativo (`-p --dangerously-skip-permissions`), sem revisão humana por
mensagem.

**Restrito a um único usuário do HA** (Gabriel — `user_id
4c8256f7470a4bb1a79421a76f43fdc4`). Qualquer outra conta recebe recusa
automática do agente.

**Risco aceito conscientemente**: quem estiver logado como Gabriel no app/navegador
do HA herda esse poder sem confirmação por ação. Vale considerar 2FA nessa conta.

## Por que os comandos abaixo precisam ser rodados manualmente

Esta sessão do Claude Code tem um classificador de segurança que bloqueia a
própria IA de executar `claude --dangerously-skip-permissions` com o socket do
Docker montado — por ser, na prática, "criar um agente sem sandbox". Os
arquivos já foram todos preparados; falta só você subir e conectar as peças.

## Passo a passo

### 1. Build e subida do bridge

```bash
cd /mnt/data/docker
docker compose build claude-bridge
docker compose up -d claude-bridge
docker compose logs -f claude-bridge   # deve mostrar "claude-bridge listening on :8099"
```

### 1.5. Login com a assinatura (Pro/Max), não API key avulsa

O bridge está configurado para **não** usar `ANTHROPIC_API_KEY` (billing por
token) e sim o login OAuth da sua assinatura mensal, via `claude setup-token`.
As credenciais ficam persistidas no volume `claude-bridge-auth`, então esse
login só precisa ser feito uma vez (sobrevive a restart/rebuild do container).

```bash
docker exec -it claude-bridge claude setup-token
```

Isso vai mostrar uma URL para abrir no navegador e pedir um código de
confirmação — siga o fluxo normalmente (é o mesmo tipo de login usado pelo
Claude Code no terminal). Confirme que funcionou com:

```bash
docker exec claude-bridge claude auth status
```

### 2. Testar o bridge isoladamente (antes de plugar no HA)

```bash
TOKEN=$(grep ^CLAUDE_BRIDGE_TOKEN .env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8099/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "responda apenas: ok", "conversation_id": "teste-1"}'
```

Deve devolver algo como `{"reply":"ok"}`. Se der erro de autenticação, refaça
o passo 1.5 (`claude setup-token`). Se quiser confirmar que tem acesso real
ao host, teste algo como `"liste os containers docker rodando"` — a resposta
deve bater com `docker ps`.

### 3. Restart do Home Assistant (para carregar o custom_component)

```bash
docker compose restart homeassistant
```

Espere ~30-60s o HA voltar (`docker compose logs -f homeassistant` até ver
"Home Assistant initialized").

### 4. Configurar a integração pela UI

1. `http://192.168.0.205:8123` → **Configurações → Dispositivos e Serviços**
2. **+ Adicionar Integração** → buscar **"Claude Code Chat"**
3. Preencher:
   - **bridge_url**: `http://127.0.0.1:8099/chat` (já vem preenchido)
   - **bridge_token**: o mesmo valor do `CLAUDE_BRIDGE_TOKEN` no `.env`
     (rode `grep CLAUDE_BRIDGE_TOKEN .env` pra copiar)
   - **allowed_user_id**: já vem preenchido com o ID do Gabriel — só confirme
4. Depois de criada, vá em **Configurações → Entidades**, busque por "Claude
   Code" e anote o `entity_id` exato gerado (esperado:
   `conversation.claude_code_full_access`, mas confirme). Se vier diferente,
   ajuste o `entity:` do segundo card em
   `homeassistant/dashboards/chat.yaml`.

### 5. Criar o pipeline "Claude Code (Full Access)"

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

## Arquivos envolvidos

- `claude-bridge/Dockerfile`, `claude-bridge/server.js`, `claude-bridge/package.json`
- `.env` (variáveis `ANTHROPIC_API_KEY`, `CLAUDE_BRIDGE_TOKEN`) e `.env.example`
- `docker-compose.yml` (serviço `claude-bridge`)
- `homeassistant/custom_components/claude_code_chat/` (integração custom)
- `homeassistant/dashboards/chat.yaml` (card novo)
- `homeassistant/.storage/assist_pipeline.pipelines` (pipeline novo, editado no passo 5)
