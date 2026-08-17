# Contrato determinístico de backup e restauração

[English](RESTORE_CONTRACT.en.md)

## Autoridade e limites

`restore/private-state-manifest.yaml` é a autoridade versionada sobre o estado
privado necessário para reconstruir a instalação. O arquivo usa o subconjunto
JSON compatível com YAML 1.2 para permitir parsing determinístico com Node.js
puro. Ele é validado por `restore/schema.json`.

O manifesto não contém valores privados. Para cada item ele registra nome
lógico, componente, módulo, origem/destino relativos ou externos, obrigação,
criticidade, owner, grupo, permissões, modo de consistência, serviços que
precisariam estar parados, dependências, ordem, comportamento de instalação
nova/restauração, checksum, validação e política Git.

O Git continua sendo a autoridade para código/configuração pública; o bundle
privado é externo, criptografado e nunca deve ficar no checkout. Os comandos
desta etapa não criam backup a partir do runtime nem iniciam containers.

## Estrutura do bundle

```text
bundle-externo/
├── bundle.json
├── manifest.yaml
├── checksums.json
└── components/
    └── <logical_name>/
        └── payload
```

`bundle.json`, validado por `restore/bundle.schema.json`, registra:

- versão do schema;
- commit e branch/release do repositório;
- criação UTC e arquitetura;
- versões de componentes e digests de imagens quando conhecidos;
- módulos habilitados e componentes incluídos;
- checksum do manifesto e referência a `checksums.json`;
- estado de verificação e método de criptografia externa.

Ele nunca registra chave de criptografia, senha, segredo ou token.
`checksums.json` usa SHA-256 por arquivo e preserva somente metadados necessários
à validação/aplicação. O diretório inteiro deve receber criptografia autenticada
antes de armazenamento ou transporte fora do host.

## Componentes e consistência

O manifesto separa o núcleo obrigatório de estado condicionado a módulos. O
núcleo inclui configuração privada, bindings, secrets/estado do Home Assistant,
credenciais do Node-RED e credenciais do Mosquitto. Banco do Recorder, contexto
Node-RED e persistência MQTT podem ser recriados, mas são preservados quando
necessários ao objetivo de recovery.

Zigbee exige que configuração, banco e backup do coordenador pertençam ao mesmo
snapshot parado. Matter e Portainer são diretórios indivisíveis. Volumes de
autenticação de agentes e identidade SSH são estado externo: aparecem no plano,
mas exigem procedimento separado e aprovação específica; a engine não os copia
silenciosamente.

`service_must_be_stopped` é requisito do plano, não autorização para parar um
serviço. A coordenação operacional ocorre fora destes comandos.

## Comandos sem escrita

```bash
make backup-plan
make backup-verify BACKUP_DIR=/caminho/externo
make restore-plan BACKUP_DIR=/caminho/externo
make restore-verify BACKUP_DIR=/caminho/externo
```

`backup-plan` não lê conteúdo privado nem copia dados. Ele mostra somente nomes
lógicos/mascarados, dependências, consistência, ordem e serviços envolvidos; o
tamanho fica como dependente da instalação porque o runtime não é inspecionado.

Os comandos `*-verify` validam schemas, checksum do manifesto, checksums de
payload, contagem de bytes, presença dos componentes obrigatórios, módulos,
estrutura e ausência de symlinks. `restore-plan` adiciona commit, arquitetura,
digests, espaço disponível, owner/grupo/permissões e conflitos de destino.

## Apply e rollback

`restore-apply` não faz parte do fluxo automático. Ele exige:

```bash
make restore-apply \
  BACKUP_DIR=/caminho/externo \
  DESTINATION=/destino/revisado \
  CONFIRM=RESTORE_PRIVATE_STATE
```

A engine sempre recusa `/`, o diretório home, a raiz do repositório e ancestrais
do repositório. Somente canários sob o diretório temporário são allowlisted.
Outro destino exige adicionalmente:

```text
ALLOW_NON_CANARY=I_UNDERSTAND_NON_CANARY_DESTINATION
```

Isso não substitui aprovação humana. Antes da primeira cópia, a engine verifica
bundle, compatibilidade e espaço. Cada conflito recebe snapshot em área de
rollback; no primeiro erro, itens já tocados voltam ao estado anterior. Logs e
saída contêm apenas metadados e nomes lógicos.

## Teste sintético

```bash
make restore-test
```

O teste cria bundle e destino exclusivamente em diretórios temporários. Ele
prova schema, ordem, checksums, permissões, restauração, rejeição de checksum
incorreto, componente obrigatório ausente, contrato de destino alterado,
destinos perigosos e rollback após falha injetada. Nenhum caminho residencial é
lido ou modificado.

## Recuperação do contexto da IA

Depois de infraestrutura e configuração validadas:

```bash
node scripts/ai-context-recovery.mjs --commit <commit-restaurado>
```

O checker confirma o commit, `AGENTS.md`, `MEMORY.md`, índice canônico e somente
as memórias temáticas selecionadas (por padrão, `restore`). Outros temas podem
ser passados por `--topics tema-1,tema-2`. Ele nunca lê `.agent-history/`, `.claude/`,
runtime privado de `.codex/` ou `.local-secrets/`. Conhecimento necessário que
exista somente ali deve ser reportado como `knowledge_not_versioned`.

O prompt coordenador é `prompts/restore-smart-home.prompt.md`. A sequência é:

```text
infraestrutura restaurada
→ configuração validada
→ commit identificado
→ AGENTS.md e MEMORY.md carregados
→ memórias relevantes verificadas contra o commit
→ agente apto a operar
```

## CLI de agente

No ambiente em que este contrato foi validado, `codex`, `claude`, `openai` e
`chatgpt` não estavam instalados como comandos. Por isso o projeto não publica
uma flag não verificada. Use a interface oficial disponível e envie exatamente:

```text
Leia e execute integralmente prompts/restore-smart-home.prompt.md
```

Quando uma CLI for instalada, valide `--help` e `--version` no próprio ambiente
antes de documentar uma invocação de uma linha. Nunca passe secrets em argv.

## Limitações

- Criação de backup real não foi automatizada nesta etapa.
- Snapshot de volume externo, parada de serviços e pós-restore residencial
  continuam operações deliberadamente separadas e autorizadas.
- Compatibilidade marcada como diferente exige revisão; não há migração
  automática de banco, registry, fabric ou rede Zigbee.
- O teste sintético prova a engine, não a consistência de um bundle privado real.
