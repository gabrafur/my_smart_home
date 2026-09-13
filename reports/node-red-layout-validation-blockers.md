# Bloqueios de validação Node-RED preexistentes

Baseline funcional: snapshot anterior à reorganização visual, SHA-256 `3411d46c3b20e1e8c3b0e4aa0eec801749e9622609678c2808b4f4a09cf14412`.

Os itens abaixo já falhavam nesse baseline e continuam fora do escopo exclusivamente visual. A correção exigiria alterar flows funcionais, políticas ou geradores; por segurança, nenhuma dessas mudanças foi feita.

| Validação | Falha observada no baseline |
| --- | --- |
| `flows:validate` | `infra_notify_persistent` é rejeitado como saída persistente fora do hub canônico. |
| `test:all` | O primeiro replay, `test-alarm-arrival-disarm-flow.mjs`, encontra `api-call-service` onde espera `change`. |
| `flows:test-notification-hubs` | O gerador dos hubs não é idempotente; na segunda aplicação, `grp_internet_publish.h` passa de 760 para 770. |
| `flows:validate-manual-tests` | `resident_notifications_test_notify_secondary` é rejeitado como entrega de teste inválida. |
| `flows:validate-observability` | A entrada de domínio não referencia `notification_hub_mobile_observer_out`. |

O comparador layout-only foi executado entre o baseline acima e o resultado final. Como IDs, tipos, regras, funções, payloads, wires, links, memberships e todos os demais campos funcionais permaneceram idênticos, essas falhas não foram introduzidas pela reorganização.
