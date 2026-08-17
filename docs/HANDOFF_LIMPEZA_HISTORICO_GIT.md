# Handoff histórico: privacidade e recovery do fluxo de chegada

> **Arquivado.** Nomes, horários, trajetos e observações residenciais foram
> removidos. O estado atual está em
> [contexto de segurança](ILUMINACAO_SEGURANCA_NODERED.md), no
> [inventário de recovery](SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md) e no
> [case de saneamento](AUDITORIA_SEGURANCA_REPO_PUBLICO.md).

## Contexto

O trabalho original reuniu duas frentes que precisavam permanecer separadas:

1. retirar dados privados do branch atual e decidir como tratar o histórico;
2. tornar um fluxo event-driven de chegada seguro diante de estado stale,
   reinícios, rate limits e integrações indisponíveis.

## Decisões preservadas

- flows e documentação usam papéis como `resident_primary`,
  `vehicle_primary`, `exterior_light` e `security_panel`;
- distância é apenas evidência auxiliar; ausência de binding não autoriza um
  efeito físico;
- snapshots, timestamps e ownership persistido têm validade limitada;
- refresh de integração cloud respeita cooldown, backoff e deduplicação;
- a fonte de verdade pública é `nodered/flows.json`; geradores legados não
  podem sobrescrever recovery mais novo;
- reescrita Git continua destrutiva, opcional e fora do fluxo automático.

## Linha do tempo sanitizada

| Marco | Resultado |
| --- | --- |
| T0 | scanner identifica classes de metadado e caminhos indevidos |
| T+1 | bindings privados substituem literais públicos |
| T+2 | gates de readiness, stale state e ownership são incorporados |
| T+3 | replay cobre reinício, ordem de eventos, retry e degradação segura |
| T+4 | validação canônica integra segurança, privacidade e testes de runtime |

## Evidência reproduzível

```bash
npm --prefix nodered run flows:validate
npm --prefix nodered run test:all
scripts/security-scan.sh
make privacy-check
```

Os testes usam eventos e papéis sintéticos; não dependem de chegada real,
coordenadas, notifier pessoal, mapa, rota ou horário residencial. Validação
física continua sendo responsabilidade humana da instalação derivada e não é
claim deste repositório público.

## Lições

- replay determinístico prova lógica e recovery, não o comportamento de um
  dispositivo real;
- side effects devem falhar fechados até que contexto e ownership sejam
  reconciliados;
- integração cloud é uma entrada opcional e sujeita a limites externos;
- um handoff público deve registrar invariantes, não episódios domésticos.
