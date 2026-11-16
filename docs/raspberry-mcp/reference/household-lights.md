# Luzes da casa pelo MCP

A Eva lê e aciona um conjunto fixo de luzes da casa por duas ferramentas MCP:

- `ha_lights_read` lista as luzes registradas com o estado atual no Home Assistant
  (`on`, `off`, `unavailable`). Somente leitura.
- `ha_light_set` liga (`on`) ou desliga (`off`) uma luz registrada e depois lê o
  estado real. `state=confirmed` significa que o Home Assistant informa o estado
  pedido. `unconfirmed` (estado não alcançado em 6 s) e `uncertain` (resposta do
  serviço perdida) nunca são reenviados automaticamente; observe com
  `ha_lights_read`.

Alvos registrados (política `/usr/local/lib/raspberry-ha-lights/policy.json`):
`lampadas_garagem`, `lampada_varanda`, `abajour_sala_de_estar`,
`refletores_jardim` e `refletor_portao_carros`. Só entidades `switch`/`light`
podem ser registradas. Relé do portão, alarme, fechaduras, climatização e
controles do veículo não estão registrados e são inalcançáveis: o chamador envia
apenas a chave registrada e on/off.

## Caminho

```
conector ChatGPT -> túnel -> frontend raspberry-mcp@ (sem rede)
  maintenance-entry.mjs -> private-content-route.mjs -> lights-route.mjs
  -> /run/raspberry-mcp/ha-lights.sock -> raspberry-ha-lights@.service
  -> REST do Home Assistant em localhost
```

- `maintenance-entry.mjs` tem hash fixado pelo portão de interface da manutenção
  e não muda. `private-content-route.mjs` (não fixado) reexporta sua rota
  envolvida por `makeLightsRoute`; `overlay.py` deriva esses bytes da base
  instalada exata.
- O broker roda por pedido como `DynamicUser`, sem capabilities, com acesso IP
  apenas a localhost e `/mnt/data/docker` inacessível. O token do Home Assistant
  chega só por `LoadCredential`.
- Limites: 30 comandos por hora e intervalo de 3 s. Cada comando é gravado em
  `/var/lib/raspberry-ha-lights/commands.json` antes do envio (histórico de 24 h).
- `ha_light_set` não é somente leitura, então o conector mantém sua confirmação de
  interface.
- O token é o long-lived existente, com direitos de administrador no Home
  Assistant; o broker o limita aos switches registrados. Um usuário dedicado de
  menor privilégio no Home Assistant é um endurecimento possível.

## Operação

Fontes e testes ficam em `scripts/raspberry-mcp/ha-lights/` (`test_broker.py`,
`lights-route.test.mjs`). `install.py` é o operador Root, com os verbos
`prepare`, `apply`, `verify` e `rollback`. O `rollback` restaura a imagem
anterior da rota de conteúdo privado e remove o socket, as units e o broker.

Ferramentas novas só aparecem numa nova conexão do frontend. Depois de instalar,
reinicie o túnel (`raspberry-mcp-tunnel.service`) sem operação MCP em andamento
e, se a lista estiver em cache, atualize as ferramentas do conector no ChatGPT.

Para desativar o controle mantendo a leitura, defina `enabled` como false na
política. Qualquer mudança futura em `private-content-route.mjs` precisa manter o
envoltório de iluminação.
