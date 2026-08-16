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

- A integração Moni Mobile cobre armar e desarmar; monitoramento de zonas é um
  escopo futuro deliberado. Consulte `docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md`.
- Painéis Lovelace personalizados usam `url_path` com hífen; `input_text` tem
  limite de 255 caracteres. Para assistentes e chat, consulte
  `docs/CHAT_CLAUDE_CODE_HA.md`.
