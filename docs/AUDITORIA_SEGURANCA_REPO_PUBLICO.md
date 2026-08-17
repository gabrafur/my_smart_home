# Case histórico: saneamento do repositório público

> **Arquivado.** Este registro explica uma decisão passada. Para o contrato
> atual, use [Modelo de privacidade](PRIVACY_MODEL.md),
> [Fronteira pública/privada](PUBLIC_PRIVATE_BOUNDARY.md), `.gitignore` e os
> scanners executáveis.

## Problema

Uma revisão de publicação identificou que a configuração rastreada misturava
código reutilizável com estado de runtime e identificadores persistentes de uma
instalação. Mesmo sem uma credencial detectada, metadados desse tipo podem
revelar pessoas, localização, rede ou hardware.

## Causa-raiz

- exceções antigas no `.gitignore` permitiam registries do Home Assistant;
- alguns flows e pacotes usavam literais onde deveria existir indireção;
- documentação operacional tratava valores de uma instalação como exemplos;
- remover arquivos do HEAD não removia objetos já alcançáveis no histórico.

## Investigação sanitizada

| Marco | Evidência técnica |
| --- | --- |
| T0 | inventário de arquivos rastreados e regras de ignore |
| T+1 | scanner do HEAD por credenciais, coordenadas, rede e IDs físicos |
| T+2 | varredura separada do histórico, sem reproduzir valores encontrados |
| T+3 | testes negativos com fixtures sintéticas para provar detecção |
| T+4 | validação de Compose, JSON/YAML, links e fluxos após a correção |

A investigação diferenciou **segredo rotacionável** de **metadado persistente**.
O snapshot não confirmou credenciais no Git, mas confirmou que dados privados
haviam sido rastreados no histórico. Por isso a resposta combinou prevenção no
HEAD com uma decisão separada sobre reescrita destrutiva do histórico.

## Correção

- estado de runtime passou a ser integralmente ignorado;
- valores específicos migraram para secrets, `.env` ou bindings privados;
- flows públicos usam papéis lógicos e falham de forma segura quando o binding
  está ausente;
- exemplos passaram a usar valores reservados ou placeholders;
- `scripts/security-scan.sh`, `scripts/privacy-check.mjs` e testes negativos
  entraram no caminho canônico `make validate-public`;
- memória pública foi separada de transcripts e runtime de agentes.

## Histórico Git

Reescrever histórico é uma operação distinta: altera SHAs, exige publicação
não fast-forward, afeta clones/forks e não revoga cópias externas. A revisão
produziu um procedimento isolado e verificável, mas não o tornou automático.
Qualquer execução futura exige autorização explícita, backup, clone descartável,
varredura pós-reescrita e plano de realinhamento dos consumidores.

Este case não contém valores, nomes, contagens de dispositivos, horários,
rotas, coordenadas ou instruções dependentes da residência original.

## Validação atual

```bash
scripts/security-scan.sh
make privacy-check
node scripts/docs-check.mjs
make validate-public
```

Os testes confirmam que arquivos proibidos não estão rastreados, que fixtures
sintéticas maliciosas são rejeitadas, que achados não ecoam valores e que
documentação, bindings, memória e restore respeitam a fronteira pública.

## Lições

1. Repositório público exige allowlist conceitual, não apenas busca por tokens.
2. Runtime, memória de agente e documentação têm ciclos de vida diferentes.
3. Papéis lógicos tornam código demonstrável sem publicar a topologia física.
4. Sanitizar o HEAD não equivale a limpar histórico.
5. Segurança editorial precisa de testes executáveis e fixtures sintéticas.
