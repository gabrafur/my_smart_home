# Memória do projeto

Este é o ponto de entrada canônico para memória de longo prazo do projeto.
Leia-o junto com `AGENTS.md` antes de mudanças não triviais. A configuração e a
documentação versionadas têm precedência sobre este resumo; memórias históricas
não constituem autorização para ações sensíveis ou irreversíveis.

## Princípios de trabalho

- Preserve integrações e automações existentes ao adicionar uma funcionalidade
  semelhante. Remoções ou substituições exigem pedido explícito.
- Documente no mesmo conjunto de alterações qualquer mudança não trivial em
  flows, pacotes do Home Assistant, integrações ou ferramentas. Atualize o guia
  relacionado em `docs/` ou crie um seguindo a convenção existente.
- Ao alterar lógica no Node-RED, mantenha também os nomes, comentários e textos
  dos nós coerentes com o comportamento novo.
- Ao criar commits para alterações acumuladas e independentes, separe-os por
  assunto. Revise o índice antes de cada commit.
- Nunca versionar credenciais, tokens, coordenadas, chaves, dados de runtime ou
  registros de dispositivos. `.gitignore` e os guias de instalação e segurança
  são a fonte de verdade.

## Referências operacionais atuais

- **Chegada e iluminação de segurança:** trate zonas, rastreadores congelados,
  cooldowns e deduplicação como partes do mesmo fluxo. Consulte
  `docs/ILUMINACAO_SEGURANCA_NODERED.md` e
  `docs/SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md` antes de alterá-lo.
- **Creta / Kia UVO:** a integração local e os limites de wake/refresh são
  intencionais; valide IDs de entidade atuais antes de usá-los. Consulte
  `docs/CRETA_KIA_UVO_INTEGRATION.md`.
- **Portão da garagem:** o relé Zigbee TS0001 deve receber pulso em software
  (`ON` seguido de `OFF`); não usar `on_time`/`onWithTimedOff`. Consulte
  `docs/PORTAO_GARAGEM_RELE_LOCAL.md` e
  `docs/PORTAO_GARAGEM_BOTAO_PULSO.md`.
- **Moni Mobile:** a integração cobre armar e desarmar; monitoramento de zonas
  é escopo futuro deliberado, não uma falha conhecida. Consulte
  `docs/INTEGRACAO_MONI_MOBILE_INTELBRAS.md`.
- **Home Assistant e host:** alterações de Bluetooth, Matter, D-Bus ou energia
  devem seguir `docs/BLUETOOTH_MATTER.md` e
  `docs/CONTROLE_ENERGIA_HOME_ASSISTANT.md`; confirme qualquer ampliação de
  privilégio ou acesso ao host.
- **Painéis Lovelace:** caminhos personalizados usam hífen e `input_text` tem
  limite de 255 caracteres. Consulte `docs/CHAT_CLAUDE_CODE_HA.md` quando a
  mudança envolver assistentes ou o painel de chat.

## Manutenção desta memória

Inclua somente decisões reutilizáveis e verificadas, com links para a fonte
canônica. Remova ou atualize itens que forem superados por configuração ou
documentação posterior. Não registre segredos nem aprovações temporárias.
