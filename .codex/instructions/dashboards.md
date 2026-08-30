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
