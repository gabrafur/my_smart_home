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

O comparador layout-only é executado novamente a cada lote contra um snapshot do `flows.json` ativo imediatamente anterior. Isso preserva também mudanças funcionais concorrentes que tenham sido incorporadas ao flow atual. Como IDs, tipos, regras, funções, payloads, wires, links, memberships e todos os demais campos funcionais permanecem idênticos dentro de cada lote, essas falhas não são introduzidas pela reorganização.

## Gates visuais promovidos

Os itens abaixo não são mais tratados como bloqueios preexistentes aceitáveis em um canvas alterado. O comparador layout-only agora reprova o candidato quando encontra:

- groups ou nodes sobrepostos;
- group a mais de 160 px de seu vizinho mais próximo, inclusive o observador global, ou canvas dividido em mais de uma cadeia espacial de groups nesse limite; vazios residuais dentro da cadeia continuam sujeitos à inspeção ampliada;
- node fora dos limites de seu group;
- wire cuja curva atravessa um terceiro node;
- wire local acima de 500 px;
- wire local com retorno visual: a entrada do destino recua mais de 60 px em relação à porta de saída, ainda que os centros aparentem avançar.

Cruzamentos possíveis entre wires são emitidos como aviso obrigatório e exigem inspeção do PNG/SVG em escala legível, pois bifurcações legítimas podem produzir interseções na aproximação geométrica. A auditoria anterior às mudanças mantém esses indicadores como baseline histórico; ela não autoriza reintroduzi-los no resultado.
