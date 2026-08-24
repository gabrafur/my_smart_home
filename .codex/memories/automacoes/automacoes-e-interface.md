# Automações e interface

## Chegada e iluminação de segurança

Zonas, rastreadores congelados, cooldowns e deduplicação formam um único
contrato de segurança. Antes de mudar esse comportamento, consulte
`docs/ILUMINACAO_SEGURANCA_NODERED.md` e
`docs/SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md`.

## Portão da garagem

O relé Zigbee TS0001 deve receber pulso em software (`ON` seguido de `OFF`).
Não usar `on_time` ou `onWithTimedOff`. Consulte
`docs/PORTAO_GARAGEM_RELE_LOCAL.md` e
`docs/PORTAO_GARAGEM_BOTAO_PULSO.md`.

## Alarme e painéis

- A integração Moni Mobile cobre armar, desarmar e ler o estado agregado das
  partições. Ela não expõe entidades individuais de zona. Consulte
  `docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md`.
- Os painéis Lovelace YAML são declarados em `lovelace.dashboards` dentro de
  `homeassistant/configuration.yaml`; as chaves públicas de dashboard usam
  hífen. Para assistentes e chat, consulte `docs/CHAT_CLAUDE_CODE_HA.md`.

## Chat de agentes no Home Assistant

- Os agentes `Claude Code Chat` e `Codex` têm controle total do host e usam uma
  allowlist explícita de usuários humanos ativos. Cargo administrativo não
  concede acesso implicitamente; identificadores permanecem somente no config
  entry privado da integração.
- Config entries antigos com um único usuário são migrados preservando esse
  acesso. Alterações posteriores na allowlist recarregam apenas a integração.
- Autorização é verificada antes de histórico, limpeza ou envio, e a conversa
  persistente continua separada por agente e usuário autenticado. O bearer
  token local do `ai-bridge` forma uma segunda fronteira independente.
- Card dedicado e entidades do Assist injetam o mesmo contexto confiável: nome
  do usuário autenticado, escopo limitado ao Raspberry Pi e seus recursos
  acessíveis (incluindo Home Assistant, Node-RED, Docker e arquivos), e
  capacidade de alterá-los somente quando o pedido autorizar.
- Fontes atuais: `homeassistant/custom_components/claude_code_chat/` e
  `docs/CHAT_CLAUDE_CODE_HA.md`.

## Padrões Lovelace reutilizáveis

Em views nativas `sections`, um card dentro de um `grid` de duas colunas ocupa
uma célula desse grid. Textos explicativos que precisam preencher a coluna
inteira devem ser cards irmãos do grid na seção, não o último filho ímpar. Isso
preserva a responsividade sem CSS customizado e deve ter teste de regressão do
nível de indentação/layout.

Tabelas Markdown geradas por Jinja precisam manter cabeçalho, separador e linhas
sem linhas vazias entre eles: use controle de whitespace nos blocos do loop,
pois uma quebra vazia encerra a tabela e transforma as linhas seguintes em
texto. Em colunas estreitas, combine campos relacionados na mesma célula com
`<br>` antes de adicionar rolagem horizontal. Valide o template renderizado com
dados sintéticos no ambiente do Home Assistant, além de testar o YAML fonte.
