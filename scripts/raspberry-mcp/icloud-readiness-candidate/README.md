# Diagnóstico iCloud pelo MCP

Este candidato acrescenta `evidence.data.icloud_readiness` à ferramenta existente
`maintenance_capabilities`. A implementação foi instalada e lida pelo cliente
MCP real em 26/10/2026. Esta exportação continua desarmada e não concede
permissão de produção. Outra instalação requer pacote privado completo, prazo e
autorização do proprietário. A documentação do transporte e de outros clientes está em
[RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md](../../../docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md).

## Chamada e campos

Um chatbot usa a autenticação MCP existente, sem acesso ao socket root:

```json
{"name":"maintenance_capabilities","arguments":{"host":"raspberry"}}
```

| Campo de `icloud_readiness` | Evidência e limite |
| --- | --- |
| `state`, `observed_at`, `collection_error` | Resultado da coleta, sem afirmar saúde funcional |
| `loaded.code_sha256`, `identity_kind`, `release_revision` | Objetos de código do processo HA, revisão e nonce existentes |
| `loaded.entry_phase`, `native_process_identity_verified` | Fase observada e identidade do processo; entry_ready não prova saúde Apple |
| `loaded.observed_at`, `age_seconds` | Horário original e idade; prova antiga ou conflitante fica unknown |
| `expected_node_contract` | Serviço revisado `public_bindings.call`, ação `refresh_location`; não declara configuração Node-RED atual |
| `service_registration.registered` | true/false da presença no registro HA; null quando não comprovada |
| `service_registration.observed_at`, `age_seconds`, `collection_error` | Coleta independente da versão carregada |
| `service_registration.last_success` | Histórico explícito; falha posterior não mantém o estado atual verde |
| `functional_health`, `functional_recovery_proven` | Sempre unknown/false neste diagnóstico |

O parser e os testes são o contrato executável. Resposta root fora do contrato,
coleta incompleta, expiração, saturação ou indisponibilidade mantém unknown.
Não interpretar isso como inexistência da integração ou autorização para retry.

## Fontes e limites

O observador HA reutiliza a identidade/token já carregados. Só depois de
verificar a identidade e receber o primeiro snapshot da assinatura existente,
consulta `GET /api/services` em loopback, até uma vez por 60s, uma em voo,
timeout de 3s, resposta máxima de 256KiB e sem redirects. O catálogo é usado
apenas em memória. Somente o booleano do serviço fixo sobrevive: nomes alheios,
descrições, campos e exemplos não são persistidos nem exportados.

O ramo root reutiliza o socket administrativo e aceita somente um pedido
literal interno. Confere a prova existente do iCloud, marcador/nonce, revisão,
idade e associação ao processo atual. Consulta exclusivamente
`GET /containers/homeassistant/top?ps_args=-eo%20pid` no socket Docker local,
com até 128 PIDs/8KiB e timeout de 2s. Lê NSpid e início em ticks em status/stat
dos PIDs e confirma a associação em duas observações. Não usa Docker exec,
inspeção de configuração, logs, cmdline, shell ou caminhos escolhidos pelo bot.

O perfil mantém UID, Group, capabilities e restrições existentes. Três mounts
opcionais expõem prova, marcador e socket somente ao código root selado.
Montar um socket readonly não restringe o protocolo Docker: a restrição é o
código auditado, que só oferece a rota de PIDs. O socket nunca é dado ao bot.
Nenhuma credencial, localização, mensagem privada ou identificador de ativação
é retornado. Falha no novo probe não pode parar a observação original.

## Preparação, instalação e revogação

Os arquivos deste diretório têm bindings desarmados: prazo zero, marcador de
manifesto, principal e recibo histórico substituídos. `SOURCE-MAP.json` distingue
hash da fonte preparada e da exportação. Não copiar este snapshot sobre um
executor ou uma política viva. Os dois JSONs privados de política, recibos,
credenciais e manifesto real não são publicados.

Para instalar ou portar, o administrador deve:

1. Criar área privada fora de qualquer checkout Git, modo 0700/umask 077, e copiar as fontes
   revisadas. O guard recusa `.git` em qualquer ancestral, inclusive worktree
   e link quebrado. Não gerar snapshots privados dentro de outro clone. Registrar versão do host/MCP e preservar os quatro fontes antes
   da mudança: notification_collector, executor, recovery e repair-broker.
2. Aplicar somente os deltas de leitura sobre essas versões atuais. Conservar
   o ramo de migração, histórico e principal existentes; não adotar o recibo
   sintético como estado real. Vincular o deadline aprovado em `package_model`,
   instalador e configuração do probe; conferir o hash do executor no wrapper.
   Vincular também STAGE, STATE, hashes do instalador/manifesto após geração,
   UID/GID e proprietários dos locks, caminho e conteúdo do recibo histórico
   validado e pin do wrapper. Os placeholders não são um instalador universal.
3. Construir em privado before/after e a cadeia de hashes com `proposed()`.
   Preservar todos os campos de política alheios ao escopo. O manifesto deve
   selar onze alvos e os cinco perfis/política inalterados. Executar testes,
   leitura isolada no perfil real, revisão de privacidade e preflight root.
   Conferir separadamente que o socket administrativo existente está ativo,
   escutando, habilitado no boot e acessível ao principal esperado. O pacote r2
   instalado não fazia essa checagem: seu aceite exigiu habilitar o socket
   existente uma vez; nenhum novo endereço ou listener foi criado.
4. Apresentar diff, hashes, identidade, validade, mounts, limites e reversão ao
   proprietário. Só após aprovação instalar por intent e backups, com os locks
   compartilhados. O pacote exige daemon-reload e um restart do observador HA;
   não reinicia HA, Node-RED, procmon, contabilidade ou serviços do backup.
5. Validar o campo por cliente MCP real e duas coletas naturais separadas por
   pelo menos 60s. Catálogo, teste, cache de serviços e contêiner saudável não
   comprovam esse aceite nem recuperação funcional.

O instalador conserva intent antes do efeito, CAS, backups, hashes e recibos
históricos. Resposta incerta não permite repetir apply ou restart. Rollback
exige os mesmos backups e um intent separado, dentro da validade. A reversão
normal exige instalação integral e hashes finais exatos; escrita parcial ou
política alterada depois requer reconciliação, sem repetir apply. Reverter
primeiro o complemento de revogação antes do rollback r2; nunca apagar uma
revogação existente. O snapshot
diagnóstico é conservado como histórico, sem significar saúde recuperada.

Revogação do novo escopo usa o marcador root fixo
`/var/lib/raspberry-icloud-access/revoked`, root:root 0644. A regra
`/etc/tmpfiles.d/raspberry-icloud-readiness.conf` mantém um link de
`/run/raspberry-icloud-read/revoked` para esse marcador persistente. Ela usa `L`,
sem sobrescrever revogação existente; perder `/run` não apaga a revogação.
O complemento instalado não reinicia serviços e conserva o prazo original.
Para revogar, o administrador cria somente esse arquivo fixo; remover uma
revogação requer decisão administrativa explícita, nunca é automático. Bloqueia o
ramo root e a próxima consulta nativa, preservando a observação original. O
prazo aprovado é obrigatório; não há renovação automática nem reset de orçamento.
As seis tentativas Events/24h e mínimo de 600s são independentes desta leitura.

## Evidência disponível

Passaram 44 testes Python e 15 Node isolados, incluindo o guard de workspace
e a construção mínima das políticas de revogação. O tmpfiles real foi testado
em raiz temporária, preservando o marcador após perda simulada de `/run`;
isso não é prova de reboot do servidor. A leitura de processo passou no
perfil root limitado real. A consulta HA real confirmou a identidade existente,
HTTP 200 e presença do serviço, sem criar assinatura ou chamar serviço.
Uma preparação anterior com template foi recusada pelo HA e não foi ativada.
O cliente MCP real leu o campo sem erro às 13:28 e 13:35 UTC, com coleta
nativa avançando 420,031 segundos. Após o complemento, outra leitura real
às 13:57 UTC passou. Isso comprova acesso pelo MCP, sem identificar uma
execução específica da Eva/dots nem comprovar saúde do provedor Apple.
Aplicação/reversão de reparos e prova funcional continuam em outro pacote;
este candidato não conclui o objetivo de operação proativa.
