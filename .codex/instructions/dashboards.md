# Dashboards

## Formatação numérica dos dashboards

Todo número apresentado ao usuário em dashboards deve seguir a convenção
pt-BR: `.` como separador de milhar e `,` como separador decimal. Preserve os
estados canônicos como números para cálculos, histórico e automações; não grave
valores pré-formatados como estado de sensor. Sensores numéricos usados por
cards nativos devem declarar `unit_of_measurement` e `state_class` adequados
para que o frontend aplique a localização. Valores numéricos renderizados em
Markdown/Jinja devem importar e usar
`custom_templates/formatting.jinja::format_number_ptbr`. Ao criar ou alterar
um dashboard, atualize os testes de regressão que verificam esse contrato.

## Separação entre produtores, decisões e apresentação

Não force todos os dados exibidos a nascer no Node-RED. Integrações do Home
Assistant, MQTT, sensores passivos e workers sanitizados podem continuar como
produtores dos fatos brutos que realmente lhes pertencem. Políticas e decisões
operacionais de automação pertencem ao fluxo canônico do Node-RED; dashboards
e cards são consumidores.

Em todo dashboard ou card novo ou materialmente alterado:

- consuma entidades, estados, razões e atributos canônicos já publicados;
- limite Jinja e JavaScript a formatação, localização, layout, tabelas, gráficos,
  rótulos diretamente derivados do estado canônico e estado local da interface;
- uma idade pode ser convertida para texto legível, mas sua classificação em
  `fresh`, `stale`, `available` ou equivalente deve vir pronta do produtor
  canônico, sem threshold local;
- não recalcule distância, raio, seleção de fonte, disponibilidade, stale,
  threshold, cooldown, dedupe, retry, backoff, lifecycle ou autorização de
  efeito;
- um botão pode representar uma intenção explícita do usuário, mas o Node-RED
  deve validar, decidir, deduplicar, aplicar gates e executar ou simular o
  efeito;
- JavaScript de custom cards pode manter rascunho, histórico visual, loading e
  preferências de interface, mas não pode implementar política residencial;
- acrescente regressão que prove a existência do produtor canônico e rejeite a
  reintrodução da mesma decisão no dashboard.

Se um valor exibido exigir interpretação operacional, publique também a
classificação e a razão canônicas. Não esconda essa interpretação em texto,
cor ou ícone calculado exclusivamente no frontend.
