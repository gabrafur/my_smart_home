# Estado do Home Assistant pelo MCP (somente leitura)

A Eva lê o valor **ao vivo** de um conjunto fixo de entidades de status do Home
Assistant pela ferramenta `ha_states_read`, sem navegador, sem senha e sem
depender de nenhum computador ligado. Ela fecha a lacuna entre ler a
configuração de um painel (YAML pelo catálogo) e saber o valor medido agora.

Cada linha traz `state`, `unit`, `last_changed`, `last_updated`,
`last_reported`, `measured_at` (o último relato do sensor, mesmo sem mudança de
valor), `age_seconds`, `available` (falso para `unavailable`, `unknown` ou
entidade ausente) e `collection_error`. Sem `entity_id` lista todas; com um
`entity_id` registrado lê só ela.

## O que pode ser lido

A política do root (`/usr/local/lib/raspberry-ha-states/policy.json`, fonte em
`scripts/raspberry-mcp/ha-states/policy.json`) lista as entidades do placar
`house-status`: saúde, carga, memória, disco, temperatura e uptime do
Raspberry; internet, VPN, Zigbee e Tuya; incidente do Node-RED; os três
resultados de cópia (Git, externa, restauração testada) e os backups do HA;
atualizações pendentes; baterias.

- Só os domínios `sensor`, `binary_sensor`, `input_boolean` e `update` podem
  ser registrados. Alarme, fechaduras, portão, pessoas e localização ficam
  fora: além de acionáveis, o estado deles revela quem está em casa.
- Atributos só saem quando a política os lista para a entidade (por exemplo,
  `freshness` e `last_confirmed_at` dos resultados de cópia; versões das
  atualizações), e só como valores curtos de máquina. Texto livre vira
  `[withheld]`; `friendly_name` e demais atributos nunca saem.
- O broker só faz `GET /api/states/<entidade>`; não existe caminho para
  chamar serviço. Usa o token do usuário não administrador do Home Assistant
  já usado pelas luzes, entregue pelo systemd (`LoadCredential`).

## Caminho

```
conector -> frontend raspberry-mcp@ -> maintenance-entry.mjs
  -> private-content-route.mjs (v4) -> states-route.mjs
  -> /run/raspberry-mcp/ha-states.sock -> raspberry-ha-states@.service
  -> REST do Home Assistant em localhost
```

`private-content-route.mjs` passa da v3 (luzes + conta do Codex) para a v4, que
envolve também a rota de estado. `maintenance-entry.mjs`, com hash fixado, não
muda, e nenhum serviço é reiniciado: o frontend carrega a rota a cada conexão.

## Instalar, conferir e reverter

Operador root revisado `scripts/raspberry-mcp/ha-states/install.py`
(`prepare`, `apply`, `verify`, `rollback`), uma invocação por verbo e sem
repetição automática. `prepare` exige os bytes exatos da rota v3; `apply` guarda
esses bytes ao lado do operador; `verify` confere arquivos, rota v4, socket e
uma leitura real da carga de 5 minutos. `rollback` desativa o socket, restaura
a v3 e remove os arquivos novos.

Testes: `scripts/raspberry-mcp/ha-states/test_broker.py` (política sem domínios
acionáveis, valor com horário e idade, indisponível, atributos e texto livre
retidos, recusa de entidade não registrada sem ler nada, Home Assistant fora do
ar) e `states-route.test.mjs` (lista igual à política, recusas), executados por
`scripts/raspberry-mcp/ha-states.test.mjs`.
