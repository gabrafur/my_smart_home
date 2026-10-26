# Contrato iCloud carregado: fonte pública desarmada

Esta exportação documenta o diagnóstico implementado no Raspberry. O código da
integração pertence ao checkout em `homeassistant/custom_components/icloud/` e
`homeassistant/custom_components/public_bindings/`; não é duplicado neste pacote.
A exportação não contém concessão root, políticas privadas, manifesto executável,
recibos, credenciais, nonces de ativação nem validade administrativa real. Não
copiar estas fontes sobre uma instalação viva. O executor exportado tem prazo
zero e principal substituído; o instalador tem prazo/pins zero e paths de staging
substituídos. O estado da implementação instalada e a validade vigente devem ser
consultados no MCP, não inferidos da presença desses arquivos.

## Layout e pré-requisitos

Colocar este diretório em `scripts/raspberry-mcp/loaded-contract-candidate` dentro
do mesmo checkout que contém `homeassistant/`. Os testes de frescor e de AST
usam esse caminho relativo fixo. `SOURCE-MAP.json` registra hashes das fontes
preparadas e exportadas, adaptações e referências aos arquivos do checkout. Os
hashes identificam código; não concedem acesso.

- `loaded_contract.py`: modelo de observação/projeção e sanitização de
  tentativas naturais, com leitura do arquivo fixo de escopo. Não acessa rede
  nem chama o provedor.
- `root-candidate/`: leitor root limitado, projeção independente do cliente,
  cópia selável do modelo e executor desarmado para revisão.
- `upgrade.template.py`: algoritmo de instalação, ativação única e rollback;
  depende de pacote privado e helper selado ausentes desta exportação.
- Sete arquivos `test_*.py`: 77 métodos de teste, contados estaticamente nesta
  preparação. Os testes não foram executados durante a exportação. A integração
  HA isolada com dependências reais é uma validação adicional separada; seus
  ambientes e evidências privados não fazem parte deste pacote.

Os testes puros usam Python 3.11 ou posterior e biblioteca padrão. O teste AST
compila apenas funções selecionadas de `public_bindings`, sem importar HA ou
chamar dispositivos. O teste de frescor importa módulos puros da integração
por um pacote sintético. Executar a partir de um checkout completo:

```sh
python3 -m unittest discover -s scripts/raspberry-mcp/loaded-contract-candidate -p 'test_*.py'
```

Esse comando é orientação de validação; não foi executado na preparação desta
exportação. As validações de recuperação substituem filesystem, locks, helpers
e controle de serviços por fixtures e mocks. Não invocam o instalador real.

## Interface MCP para Eva ou outro chatbot

Usar a autenticação e o transporte MCP existentes, descobrir o nome real em
`tools/list` e consultar a ferramenta existente:

```json
{"name":"maintenance_capabilities","arguments":{"host":"raspberry"}}
```

Nenhuma ferramenta nova é introduzida. O campo de diagnóstico é
`evidence.data.icloud_readiness`, com `source`, `observed_at`, `state`,
`collection_error`, `loaded`, `service_registration`, `native_contract` e
`coverage`. `functional_health` continua `unknown` e
`functional_recovery_proven` continua `false`.

`native_contract` informa `state`, `collection_error`, `observed_at`,
`age_seconds` e `data`. Quando não há prova válida, `data` pode ser `null`.
A estrutura fechada de `data` é:

- `schema_version: 1`, origem fixa e timestamp próprio da coleta;
- `public_setup_sha256`, vinculado independentemente ao setup público carregado;
- `bindings`, com os dois papéis públicos fixos `resident_primary` e
  `resident_secondary`, ação `refresh_location` e booleanos ou `null` para
  handler pronto, binding carregado, provedor/serviço esperados, contrato do
  alvo, registro downstream, conta carregada correspondente e API presente;
- `latest_attempts`: no máximo uma linha por papel, contendo estado, timestamp,
  idade, estágio `provider_refresh` ou `downstream_call`, resultado
  `started`/`completed`/`error` e classe de exceção da allowlist;
- `historical_attempt_only: true` em cada tentativa e marcadores explícitos de
  ausência de chamadas diagnósticas e de prova de recuperação funcional.

Ausência de uma tentativa significa `not_observed`; falha de observação significa
`unknown`. Uma execução natural completada permanece um fato histórico limitado.
Registro do serviço, conta/API presentes e fase `entry_ready` não comprovam
saúde Apple, execução atual do handler ou recuperação de todos os fluxos. A
consulta não retorna usernames, senhas, entidades privadas, localização, mensagens
ou stack brutos. Classes fora da allowlist viram `other`; dados inválidos são
retidos como incerteza, sem exportar o texto original.

## Integridade e frescor

A observação ocorre no loop HA, em tipos nativos exatos e closures do setup
carregado. A coleta não acessa propriedades do provedor. O timestamp é capturado
antes de enfileirar a gravação no executor: atraso de publicação não rejuvenesce
os dados. Prova ou contrato com mais de 60 segundos não confirma estado atual;
a resposta root deve ter até 10 segundos e o catálogo HA até 90 segundos.

A prova nativa schema 2 vincula revisão, nonce existente, hashes de objetos de
código, PID/start ticks e contrato sanitizado. O leitor root confirma associação
ao contêiner fixo `homeassistant`, com metadados de processos limitados, e verifica
hashes esperados de código e setup público. Nonces e identidades de processo não
são projetados no MCP. Manter as verificações e o socket administrativo existente
ativo; não substituir falha de integridade por aceitação de conteúdo desconhecido.

## Preparar uma instalação em outro host

Isto é uma referência de implementação, não um instalador portátil completo.
Um operador precisa construir, fora de qualquer checkout e em área privada 0700,
um pacote concreto para a versão atual do host, preservando os recibos e intents
existentes. O pacote precisa incluir:

1. Versão/imagem HA e APIs nativas compatíveis; aliases dos dois papéis públicos
   e tipos reais `GuardedAccount`, `Service`, `HassJob`, lista de config entries e
   closures esperadas. Mudança de layout deve produzir `unknown`, sem adaptar
   silenciosamente propriedades privadas.
2. Todos os arquivos before/after e suas permissões/identidades reais; helper
   histórico root auditado e seu hash; STAGE, STATE, manifesto e pins novos; conta
   nativa do socket, revisão e fingerprint conforme o Python realmente usado.
   Recalcular a cadeia de dependências dos executores, wrappers e políticas;
   não reutilizar pins de uma preparação anterior.
3. Políticas privadas preservadas e escopo nativo root:root/0644 em
   `.mcp-icloud-contract-scope.json`, com os campos exatos `schema_version`,
   `enabled`, `issued_at`, `expires_at`, `operation_id`, `release_revision`.
   O prazo deve ser positivo, de até 24 horas, e corresponder à autorização
   concreta; nonce/revisão devem corresponder à ativação vigente. Nada renova
   automaticamente a autoridade ou reseta orçamentos.
4. Diff, testes isolados, identidade, validade, limites, efeitos de ativação,
   revogação e recuperação para aprovação do pacote concreto antes de ativar
   uma ampliação de acesso. O template separa instalar fontes de ativar: prevê
   no máximo um restart HA e um restart de rollback reconciliado, preservando
   os outros seis serviços, registries e recorder. Não executar essa sequência
   em um host já migrado só porque este diretório foi publicado.
5. Aceite com cliente MCP real após ativação autorizada e avanço natural do
   timestamp. Catálogo, testes ou fonte em disco não comprovam código carregado.
   Não criar chamadas de localização, autenticação Apple ou eventos domésticos
   para testar o diagnóstico.

O template não acompanha `sealed_helpers.py`, políticas, `.storage`, bancos,
MANIFEST real, escopo/ativação reais, backups nem arquivos before privados. Sua
restauração parcial aceita somente hashes before/after conhecidos; qualquer
edição externa, backup inválido ou reinício incerto exige reconciliação antes de
novos efeitos. Cada restart tem intent prévio e não é repetido automaticamente.
A persistência dos backups e do bundle é parte obrigatória do pacote privado.

## Revogação e escopo histórico

O marcador persistente `.mcp-icloud-contract-revoked` no config HA bloqueia a
coleta do contrato nativo. Revogar também o escopo de leitura root e a concessão
administrativa pelos mecanismos existentes quando esse for o escopo da decisão;
não apagar marcadores para recuperar acesso sem decisão explícita. Preservar a
revogação durável introduzida pelo pacote de leitura anterior.

O [candidato r2 anterior](../icloud-readiness-candidate/README.md) conserva sua
história. Não sobrescrever seus recibos ou interpretar seus bindings como a
concessão nova. Este pacote não resolve sozinho Node-RED, heartbeat, backups,
restauração de serviços, 24 horas de continuidade ou autonomia completa da Eva.
