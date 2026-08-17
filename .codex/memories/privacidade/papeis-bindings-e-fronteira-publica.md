# Papéis, bindings e fronteira pública

- A lógica pública usa os papéis `resident_primary`, `resident_secondary`,
  `mobile_primary`, `mobile_secondary`, `vehicle_primary`, `garage_gate`,
  `exterior_light` e `security_panel`; papel lógico não é `entity_id`.
- O contrato vigente está em `bindings/public-bindings.schema.json` e o exemplo
  sintético em `bindings/private-bindings.example.json`.
- Valores reais pertencem exclusivamente a `bindings/private/`, ignorado pelo
  Git e montado somente para leitura em `/run/private-bindings`.
- Home Assistant consome os bindings por
  `homeassistant/custom_components/public_bindings`; Node-RED os carrega em
  `publicBindings` por `nodered/settings.js`. Ausência ou binding inválido deve
  degradar de forma segura, sem migração automática de registries.
- `make privacy-check` examina a árvore rastreada e
  `make privacy-check-staged` examina o index; achados nunca mostram fragmentos
  dos valores detectados.
- Memória pública rastreada e runtime privado são fontes distintas. Conteúdo
  existente apenas em runtime deve ser reportado como `knowledge_not_versioned`.

Fontes atuais: `docs/PRIVACY_MODEL.md` e
`docs/PUBLIC_PRIVATE_BOUNDARY.md`. Essas fontes substituem aliases residenciais
e instruções anteriores baseadas diretamente em IDs da instalação.
