# Bootstrap, módulos opcionais e demo sintética

[English](BOOTSTRAP_DEMO.en.md)

## Bootstrap reproduzível

O caminho para um revisor público é:

```bash
git clone https://github.com/gabrafur/my_smart_home.git smart-home
cd smart-home
make bootstrap
make validate-public
make demo
make demo-test
```

Esses comandos criam apenas templates ignorados no clone, executam o contrato
público canônico e rodam o cenário em memória. Eles não iniciam a stack Compose.

Em clone público limpo, valide primeiro:

```bash
make bootstrap-test
node scripts/modules-check.mjs
```

Depois, com autorização para criar arquivos privados no clone:

```bash
make bootstrap
# ou
MODULES=core,zigbee,appdaemon make bootstrap
```

`scripts/bootstrap.mjs` lê `bootstrap/bootstrap-manifest.json`, copia somente
templates públicos para destinos ignorados e gera aleatoriamente apenas
segredos técnicos seguros para geração automática. Ele nunca gera senhas
escolhidas pelo operador, coordenadas, identidades ou credenciais de serviços.

Arquivos existentes são preservados byte a byte; symlinks em destinos privados
são rejeitados. Execuções repetidas são idempotentes. O resultado lista somente
caminhos conhecidos, módulos, ferramentas disponíveis e gaps manuais — nunca
valores gerados.

O bootstrap não inicia containers. Mosquitto, hash de administrador Node-RED,
placeholders específicos e autenticação de agentes continuam passos manuais.

## Núcleo e módulos

`modules/features.json` define o núcleo mínimo:

```text
core
├── homeassistant
├── nodered
└── mosquitto
```

Os módulos opcionais são `zigbee`, `vehicle`, `alarm`, `alexa`, `localtuya`,
`matter`, `portainer`, `appdaemon`, `local-ai`, `agent-bridge`,
`raspberry-specific` e `automation`. Cada um declara dependências, serviços,
configuração e degradação segura.

Para clones novos, `compose.modules.yml` adiciona profiles sem alterar o
comportamento histórico de `docker-compose.yml`:

```bash
# valida somente o núcleo e a estrutura do projeto
docker compose --env-file .env.example \
  -f docker-compose.yml -f compose.modules.yml config --quiet

# exemplo posterior, após preparar estado privado; não é executado pelo bootstrap
docker compose -f docker-compose.yml -f compose.modules.yml \
  --profile zigbee --profile matter up -d
```

O Compose principal continua iniciando os serviços atuais quando usado sozinho.
No overlay, Matter deixou de ser dependência rígida do Home Assistant; sua
ausência não bloqueia o núcleo.

Integrações implementadas dentro do Home Assistant/Node-RED usam bindings e
falham de forma segura quando o módulo não está configurado. A arquitetura não
renomeia entities, não altera registries e não migra estado automaticamente.

## Demo sintética

```bash
make demo
make demo-test
```

`demo/scenario.json` e `demo/engine.mjs` simulam, em memória:

- presença e chegada por papéis lógicos;
- solicitação lógica de segurança;
- iluminação de chegada e timeout;
- pressão e recovery de storage;
- queda/recovery de Internet e Zigbee;
- deduplicação de alerta sem segunda notificação;
- rejeição de evento de saúde stale/out-of-order;
- serialização e reload de estado sintético num restart simulado;
- alertas, recoveries e métricas de observabilidade.

Toda ação produzida contém `simulated: true` e `dispatched: false`. A engine não
importa HTTP, rede, MQTT, subprocessos ou clientes residenciais; não usa
credenciais, coordenadas nem `entity_id`. O teste substitui `fetch` por uma
falha, verifica os imports, prova que nenhuma rota real é chamada e mantém a
[saída de exemplo publicada](demo-output.pt-BR.md) idêntica ao formatter. O
restart é um modelo em memória.

## Contexto da IA

O prompt canônico é `prompts/restore-smart-home.prompt.md`. Após o commit
correto ser identificado:

```bash
node scripts/ai-context-recovery.mjs --commit <commit>
```

No desenvolvimento, `make context-recovery-check` verifica o worktree/index
rastreado. Runtime privado nunca é fonte automática. Use
`knowledge_not_versioned` quando a decisão necessária ainda não foi convertida
em documentação pública sanitizada.
