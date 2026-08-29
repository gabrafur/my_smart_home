# Fronteira de automações nativas do Home Assistant

[Português (principal)](AUTOMACOES_NATIVAS_HOME_ASSISTANT.md) · [English](HOME_ASSISTANT_NATIVE_AUTOMATIONS.en.md)

O Node-RED concentra as automações residenciais e a orquestração normal. O
Home Assistant mantém somente cinco automações que pertencem à fronteira da
própria plataforma ou funcionam como proteção independente do Node-RED.

| ID | Responsabilidade | Motivo para permanecer nativa |
| --- | --- | --- |
| `1783799940000` | converter `samsungtv.turn_on` em Wake-on-LAN | o gatilho é emitido pela integração Samsung dentro do Home Assistant e o MAC permanece em `secrets.yaml` |
| `raspberry_pi_health_problem_notification` | avisar quando um sensor derivado de saúde entra em alerta | mantém observabilidade quando o Node-RED ou seu websocket estiver indisponível |
| `raspberry_pi_health_recovery_notification` | encerrar o alerta e avisar a recuperação | compartilha os mesmos sensores, IDs de notificação e fila da automação de falha |
| `raspberry_pi_home_assistant_started` | registrar que o Home Assistant iniciou | o evento de lifecycle pertence ao processo que acabou de iniciar e confirma sua própria recuperação |
| `portao_garagem_rele_preso_em_on` | abrir o contato se o relé permanecer fechado por 5 s | é um watchdog independente que só envia `OFF`; movê-lo para o mesmo runtime que produz pulsos reduziria a defesa em profundidade |

Essas exceções não autorizam novas automações nativas por conveniência. Uma
nova entrada precisa demonstrar dependência de lifecycle/API interna do Home
Assistant ou ganho real de segurança por independência do Node-RED. O teste
`homeassistant/tests/test_native_automation_boundary.py` fixa o inventário e
alguns invariantes críticos.

## Rollback e validação

As cinco automações restantes não estão duplicadas. Para reverter a migração
do pulso do portão, restaure a automação de cooldown no Home Assistant e remova
a entrada equivalente do Node-RED em uma única troca; nunca mantenha os dois
caminhos capazes de executar a mesma ação.

Valide a fronteira com:

```bash
python3 -m unittest homeassistant.tests.test_native_automation_boundary
node nodered/tools/validate-flows.mjs
```
