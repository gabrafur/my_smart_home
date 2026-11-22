# Componentes reaproveitáveis

[Português (principal)](REUSABLE_COMPONENTS.md) · [English](REUSABLE_COMPONENTS.en.md)

Quase ninguém vai adotar esta casa inteira, mas várias peças resolvem problemas
comuns de quem opera Home Assistant e Node-RED. Este catálogo lista o que pode
ser reaproveitado hoje, de quais arquivos depende e quanto trabalho exige para
virar um projeto independente.

O código original está sob [GPL-3.0-only](../LICENSE). Uma peça extraída
continua GPL, a menos que o titular dos direitos do código original decida
outra licença para ela; componentes vendorizados mantêm sempre a licença
própria ([avisos de terceiros](../THIRD_PARTY_NOTICES.pt-BR.md)).

## Catálogo

| Componente | O que resolve | Arquivos principais | Dependências | Acoplamento | Esforço para extrair |
| --- | --- | --- | --- | --- | --- |
| Validador e renderizador de layout do Node-RED | Canvases legíveis: sobreposição, margens, fios longos, cruzamentos, benchmark que não pode piorar | `nodered/tools/flow-layout-*.mjs`, `nodered/tools/validate-flow-layout.mjs`, `nodered/tools/render-flow-layout.mjs`, `nodered/tools/layout-flows-elk.mjs` e testes | Node.js, `elkjs` | baixo: lê qualquer `flows.json` | baixo |
| Política de testes manuais com dry-run | Todo tab declara como é testado sem efeito físico | `nodered/tools/manual-test-policy.json`, `nodered/tools/validate-manual-test-policy.mjs` | Node.js | baixo; os nomes de tabs são deste projeto | baixo |
| Observador global de falhas do Node-RED | `catch`/`status` em todo tab, dedupe, confirmação de queda compartilhada, histórico de causas | `nodered/tools/install-global-flow-observer.mjs`, `nodered/tools/validate-global-flow-observer.mjs`, `nodered/tools/test-global-flow-observer.mjs` | Node.js, nós do Home Assistant | **alto**: o gerador também instala hubs, retomada, observadores de host/MQTT e alertas operacionais | alto; extrair primeiro só o grupo `catch`/`status` e o classificador |
| Hubs de notificação | Saída única para celular, Alexa e notificação persistente, com destinatários por papel lógico | `nodered/tools/install-notification-hubs.mjs`, `nodered/tools/test-notification-hubs.mjs` | Node.js, Home Assistant | médio: depende dos bindings | médio |
| Bindings por papel lógico | Lógica pública sem IDs físicos; papel ausente falha fechado | `bindings/public-bindings.schema.json`, `bindings/private-bindings.example.json`, `homeassistant/custom_components/public_bindings/`, `scripts/public-bindings-check.mjs` | Python (HA), Node.js | baixo | baixo a médio |
| Scanner de privacidade | Barra dados da casa em commits sem imprimir o valor encontrado | `scripts/privacy-check.mjs`, `scripts/security-scan.sh` | Node.js, Bash | médio: regras ajustadas a este repositório | médio |
| Motor de restore por manifesto | `plan`/`verify` somente leitura; `apply` com token, validação de destino e rollback | `scripts/restore.mjs`, `restore/schema.json`, `restore/private-state-manifest.yaml`, `scripts/restore.test.mjs` | Node.js | baixo: o manifesto descreve os componentes | médio |
| Ferramentas MCP limitadas para o Home Assistant | Assistente de IA com allowlist, limite de taxa, registro antes do envio e leitura de volta | `scripts/raspberry-mcp/ha-lights/`, `scripts/raspberry-mcp/ha-states/` | Python (biblioteca padrão), systemd, frontend MCP deste projeto | médio: a rota entra pelo frontend MCP do Raspberry | médio; o broker Python é independente, a rota não |
| Checagens de documentação | Links, âncoras, pares bilíngues, comandos `make`/npm citados e blocos Mermaid | `scripts/docs-check.mjs`, `scripts/assets-check.mjs`, `docs/i18n-manifest.json` | Node.js | médio: caminhos e regras deste repositório | médio |
| Mensagens de commit | Conventional Commits em inglês, inclusive em clone raso de CI | `scripts/commit-message-check.mjs` | Node.js | nenhum | baixo |

## Como reaproveitar hoje

Sem extrair nada, copie os arquivos listados para o seu repositório, mantenha
os testes junto e preserve o aviso de licença. Rode os testes da peça antes de
adaptá-la; por exemplo:

```bash
node nodered/tools/test-flow-layout-validator.mjs
node --test scripts/restore.test.mjs
node --test scripts/commit-message-check.test.mjs
```

## Como extrair para um repositório próprio

1. Escolha a peça e a licença (decisão do titular do código original).
2. Crie um clone descartável e mantenha só os caminhos da peça, preservando o
   histórico deles, por exemplo com
   [`git filter-repo`](https://github.com/newren/git-filter-repo):

   ```bash
   git clone https://github.com/gabrafur/my_smart_home.git extracao
   cd extracao
   git filter-repo --path nodered/tools/flow-layout-policy.mjs \
     --path nodered/tools/flow-layout-validator.mjs \
     --path nodered/tools/validate-flow-layout.mjs
   ```

3. Acrescente `package.json` ou `pyproject.toml`, README próprio em inglês,
   licença, CI e um exemplo sintético.
4. Publique uma primeira versão e, aqui, troque a cópia por uma dependência
   fixada, com link de volta neste catálogo.

Nenhuma peça foi extraída ainda; quando for, este catálogo passa a apontar para
o repositório dela.
