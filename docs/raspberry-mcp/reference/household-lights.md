# Luzes e ações da casa pelo MCP

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
podem ser registradas. Alarme, fechaduras e controles do veículo não estão
registrados e são inalcançáveis: o chamador envia apenas a chave registrada e o verbo.

## Ações da casa (v3, 20/11/2026)

Depois que a Eva não conseguiu desligar o ar-condicionado nem o PC e o proprietário
pediu que ela tivesse também o portão, duas ferramentas passaram a existir, no mesmo
broker, rota e socket:

- `ha_actions_read` lista as ações registradas e se cada uma pode rodar agora.
- `ha_action_run` (`destructiveHint: true`, então o conector pede confirmação) executa
  uma ação: `target` + `action`, nada mais.

| Alvo | Ação | O que o Home Assistant executa | Confirmação |
| --- | --- | --- | --- |
| `ar_condicionado_escritorio` | `on` / `off` | `switch.turn_on/off` em `switch.ar_condicionado_escritorio_power` | estado lido de volta |
| `pc_gabriel` | `poweroff` | `script.turn_on` em `script.pc_desligar` | só que o script rodou; o PC não é lido |
| `portao_garagem` | `pulse` | `button.press` em `button.acionar_portao_da_garagem` | só que o botão registrou o pulso |

O serviço fica fixo pelo tipo da ação (`power`, `poweroff`, `pulse`); a política só
nomeia a entidade e o rótulo. Cada tipo tem limite próprio, separado do das luzes:
`power` 20/h e 5 s, `poweroff` 3/h e 30 s, `pulse` 6/h e 20 s. Nenhum é reenviado
automaticamente: `unconfirmed` e `uncertain` pedem observação, não repetição.

O portão não tem sensor de posição. Um pulso executa o próximo passo do ciclo da
central (abrir, parar ou fechar), e o resultado traz `position_unknown`. O botão só
publica o evento; o Node-RED continua dono do pulso físico (OFF → ON → OFF) e das suas
travas, descritas em [PORTAO_GARAGEM_BOTAO_PULSO](../../PORTAO_GARAGEM_BOTAO_PULSO.md).
Ligar o PC não existe (seria Wake-on-LAN, fora do escopo pedido).

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
  chega só por `LoadCredential` e pertence a um usuário dedicado, sem administrador e
  só local (`eva-household-lights`, grupo `system-users`): lê estados e chama
  `turn_on`/`turn_off`, mas não acessa serviços e APIs administrativos. O token
  administrativo de longa duração não é mais usado pelo broker.
- Limites das luzes: 30 comandos por hora e intervalo de 3 s. Cada comando é gravado em
  `/var/lib/raspberry-ha-lights/commands.json` antes do envio (histórico de 24 h).
- `ha_light_set` não é somente leitura, então o conector mantém sua confirmação de
  interface.
- Cada chamada às duas ferramentas entra no log de auditoria do frontend
  (namespace `raspberry-mcp`, campos `tool`, `id` e `success`).
- `maintenance_capabilities` ganha um bloco `household_lights` com as ferramentas
  e os alvos. O `no_actuators` do broker selado de diagnóstico continua valendo
  para as ferramentas de diagnóstico e manutenção e não é reescrito.
- O token é o long-lived existente, com direitos de administrador no Home
  Assistant; o broker o limita aos switches registrados. Um usuário dedicado de
  menor privilégio no Home Assistant é um endurecimento possível.

## Operação

Fontes e testes ficam em `scripts/raspberry-mcp/ha-lights/` (`test_broker.py`,
`lights-route.test.mjs`). `install.py` é o operador Root, com os verbos
`prepare`, `apply`, `verify` e `rollback`; esse `rollback` restaura a imagem
anterior da rota de conteúdo privado e remove o socket, as units e o broker.
`upgrade.py` troca a rota da v1 pela v2 com compare-and-swap nos bytes exatos da
v1, e seu `rollback` volta para a v1.

Ferramentas novas só aparecem numa nova conexão do frontend. Depois de instalar,
reinicie o túnel (`raspberry-mcp-tunnel.service`) sem operação MCP em andamento
e, se a lista estiver em cache, atualize as ferramentas do conector no ChatGPT.

Para desativar o controle mantendo a leitura, defina `enabled` como false na
política. Qualquer mudança futura em `private-content-route.mjs` precisa manter o
envoltório de iluminação.

A v3 foi instalada pelo operador Root `closure-claude-1720/ha-lights-r3/deploy.py`
(compare-and-swap nos bytes exatos da v2 de `broker.py`, `policy.json` e
`lights-route.mjs`; imagens anteriores em `BEFORE-V2`; `rollback` volta à v2). O broker
roda por conexão, então não reinicia serviço; o frontend carrega a rota nova na
conexão seguinte (reiniciar `raspberry-mcp-tunnel.service`).
