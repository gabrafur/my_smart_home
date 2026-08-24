# Tour técnico de portfólio

[English](ENGINEERING_TOUR.md) · [Português](ENGINEERING_TOUR.pt-BR.md)

Este tour é um caminho de leitura por evidências, não um segundo resumo. Todo o
percurso fica no repositório público e usa testes sintéticos; nenhum runtime da
residência é necessário.

## 30 segundos: forma do sistema

- **Arquitetura:** Home Assistant, Node-RED e MQTT formam o núcleo. Módulos
  opcionais adicionam Zigbee, Matter, AppDaemon, integrações cloud e ferramentas
  de agentes. O [diagrama de arquitetura](assets/smart-home-architecture.svg)
  separa código público, runtime privado, dispositivos físicos, serviços cloud
  opcionais, backup/restore e a fronteira de agentes/Local AI.
- **Stack:** Docker Compose, Home Assistant, Node-RED, Mosquitto, Zigbee2MQTT,
  Python, JavaScript, YAML/Jinja e GitHub Actions.
- **Diferenciais de engenharia:** contratos explícitos de estado/recovery,
  bindings fail-closed, restore determinístico, replays isolados de runtime,
  scanners de privacidade e demo sintética sem dispositivos.

## 5 minutos: o argumento de engenharia

1. **O estado é orientado a eventos e protegido.** Papéis lógicos desacoplam a
   lógica pública dos IDs físicos. Replays do Node-RED exercitam duplicatas,
   snapshots stale, observações conflitantes e ordem de restart.
2. **Falha e recuperação são estados observáveis.** Flows de Internet, Zigbee,
   storage e chegada/segurança emitem incidentes limitados, deduplicam
   notificações e registram recovery em vez de tratar logs como prova.
3. **Dados públicos e privados têm contratos separados.** Schemas e fixtures
   sintéticas são revisáveis; bindings, registries, secrets, coordenadas e
   histórico ficam fora do Git. Binding ausente falha de forma segura.
4. **O restore é determinístico dentro de uma fronteira explícita.** Um
   manifesto define componentes privados. `plan` e `verify` são somente leitura;
   `apply` valida o destino, exige token de confirmação e prepara rollback.
5. **CI e validação local compartilham uma entrada.** `make validate-public`
   aciona estrutura, documentação, checks próximos de proveniência, segurança,
   privacidade, replays, restore, bootstrap e demo. O GitHub Actions chama o
   mesmo alvo.

## 15 minutos: implementação representativa

| # | Superfície de evidência | O que inspecionar |
| --- | --- | --- |
| 1 | [Fonte da arquitetura](assets/smart-home-architecture.mmd) | Fronteiras e setas de dependência verdadeiras; o SVG é gerado desta fonte. |
| 2 | [Grafo de módulos](../modules/features.json) e [overlay do Compose](../compose.modules.yml) | Core de três serviços, profiles opcionais, dependências declaradas e degradação segura. |
| 3 | [Adapter de bindings do Home Assistant](../homeassistant/custom_components/public_bindings/__init__.py) e [schema](../bindings/public-bindings.schema.json) | Projeção de papéis lógicos, allowlist de atributos, mount privado read-only e falha de ação indisponível. |
| 4 | [Replay de recovery de segurança](../nodered/tools/test-security-recovery-flow.mjs) contra os [flows](../nodered/flows.json) | Recovery após restart, rejeição stale/out-of-order, timers de lifecycle e reconciliação física. |
| 5 | [Replay de infraestrutura em runtime](../nodered/tools/test-infrastructure-monitoring-runtime.mjs) | Node-RED isolado para thresholds, deduplicação, recovery e concorrência limitada de subprocessos. |
| 6 | [Scanner de privacidade](../scripts/privacy-check.mjs) e [bindings sintéticos](../bindings/private-bindings.example.json) | Validação semântica de papéis e detecção sem ecoar riscos de publicação. |
| 7 | [Engine de restore](../scripts/restore.mjs) e [testes adversariais](../scripts/restore.test.mjs) | Manifesto, rejeição de destino perigoso, defesa contra symlink, confirmação e preparo de rollback. |
| 8 | [Engine da demo](../demo/engine.mjs), [fixture](../demo/scenario.json) e [testes](../scripts/demo.test.mjs) | Presença/chegada, sinais de saúde, deduplicação, rejeição stale, reload após restart e ausência de I/O real. |
| 9 | [Validação canônica](../Makefile) e [workflow do GitHub](../.github/workflows/public-validation.yml) | Um contrato local/CI e permissões read-only no workflow. |
| 10 | [Recovery de contexto dos agentes](../scripts/ai-context-recovery.mjs) e [contrato de memória pública](MEMORIA_VERSIONADA_AGENTES.md) | Retomada vinculada ao commit e memória sanitizada, sem transcripts privados. |

Continue no [case de platform engineering](portfolio/technical-case-study-pt-BR.md)
para restrições e trade-offs ou execute a [demonstração segura](BOOTSTRAP_DEMO.md).
