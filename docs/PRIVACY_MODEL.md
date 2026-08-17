# Modelo de privacidade

Este repositório publica arquitetura, contratos e exemplos restauráveis sem
publicar a identidade ou a rotina de uma residência. Código e documentação usam
papéis lógicos; a instalação real fornece bindings locais ignorados pelo Git.

## Papéis públicos

| Papel | Responsabilidade pública |
| --- | --- |
| `resident_primary` | primeiro morador lógico |
| `resident_secondary` | segundo morador lógico |
| `mobile_primary` | dispositivo e notificador móvel primário |
| `mobile_secondary` | dispositivo e notificador móvel secundário |
| `vehicle_primary` | veículo principal |
| `garage_gate` | portão e relé de pulso |
| `exterior_light` | conjunto de iluminação externa |
| `security_panel` | painel de segurança |

Um papel não é um `entity_id`. Entidades, serviços e tópicos físicos pertencem
ao binding privado descrito em
[PUBLIC_PRIVATE_BOUNDARY.md](PUBLIC_PRIVATE_BOUNDARY.md).

## O que pode ser público

- arquitetura, invariantes, contratos, testes e procedimentos de recovery;
- IDs lógicos, exemplos sintéticos e tempos relativos;
- nomes públicos de produtos e integrações quando tecnicamente necessários;
- memórias canônicas sanitizadas em `.codex/memories/`, indexadas por
  `MEMORY.md`.

Não são públicos nomes de moradores, relações familiares, endereços,
coordenadas, IPs privados, MACs, IDs físicos, identificadores de conta,
trackers/notificadores reais, rotinas, trajetos, payloads ou logs reais,
credenciais e tokens.

Registros históricos podem permanecer quando conservam valor técnico, mas usam
papéis lógicos, dados sintéticos, precisão reduzida e indicação explícita de que
o exemplo foi sanitizado.

## Validação semântica

```bash
make privacy-check
make privacy-check-staged
```

O primeiro comando examina somente o conteúdo rastreado pelo Git; o segundo,
somente o conteúdo staged. Arquivos untracked nunca tornam a árvore publicada
válida. O scanner cobre identidades em entidades, rede privada, coordenadas,
MACs, VIN/serial, tópicos residenciais, timestamps associados a eventos,
artefatos de estado/backup, imagens fora da área pública e metadados de imagem.

Uma denylist privada pode ser fornecida por `PRIVACY_DENYLIST_FILE`. Ela é
opcional, ignorada pelo Git e nunca tem seus valores impressos. Achados de
privacidade e do scanner de segurança exibem apenas regra, arquivo, linha e
categoria.

## Memória pública e runtime privado

A memória pública obedece à autoridade do código, dos testes, da documentação
operacional e das decisões arquiteturais vigentes. O checker exige que cada
memória referenciada esteja rastreada e rejeita memórias órfãs ou links inválidos.

`.agent-history/`, `.claude/`, `.local-secrets/`, runtime não declarado de
`.codex/` e diretórios equivalentes não são fontes documentais e não podem ser
publicados. Conhecimento existente apenas nesses locais deve ser reportado como
`knowledge_not_versioned` e transformado manualmente em conteúdo sanitizado.

## Limitações conhecidas

- Scanner semântico reduz risco, mas não substitui revisão humana nem denylist
  local adequada à instalação.
- O checker não consulta registries ou dispositivos reais.
- Arquivos já publicados no histórico Git exigem procedimento separado,
  revisão e rotação; removê-los do snapshot atual não reescreve o histórico.
- Nomes públicos de fornecedores e modelos podem exigir exceções documentadas
  quando fazem parte do contrato de uma integração vendorizada.
