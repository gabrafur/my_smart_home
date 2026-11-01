# Núcleo protegido de manutenção por componente

Snapshot de referência das fontes observadas no núcleo. O inventário em
[`SOURCE-MAP.json`](../SOURCE-MAP.json) registra a comparação de cada módulo e
harness instalado com a candidata revisada, owner/modo, SHA de origem, SHA
exportado e normalizações. A comparação verifica bytes de arquivos; não é
atestado de código executado, reparo funcional ou atuação de um cliente de IA.
`source_observed_at` delimita a observação de cada arquivo; uma correção posterior
no host não atualiza automaticamente esta exportação. Compare os hashes atuais
antes de usar o snapshot. Não copie políticas, autorizações ou recibos privados
para tornar a referência pública equivalente ao ambiente residencial.

O MCP real recebeu `protected_component_maintenance` por
`maintenance_capabilities`, com coleta válida e admissão para a preparação
inicial de `observacao_host`. O reparo inicial concluiu aplicação, identidade
carregada e prova funcional isolada posterior, com liberação da operação.
Esse aceite limitado não comprova replay nativo completo nem autonomia de um
cliente. O perfil congelado exige atualização após a mudança de fonte; não
reaplique a proposta antiga. As doze ferramentas do protótipo anterior não foram
cadastradas. O transporte imediato usa as ferramentas `codex_task_*` existentes.

## Exportação desarmada

Não contém política, perfil privado, proposta, request, concessão sudo, chave,
recibo, banco, imagem de backup, unidades com pins locais ou snapshot Git. O
operador instala e sela esses artefatos separadamente; copiar esta pasta sobre
produção invalida os hashes existentes.

Três fontes foram normalizadas explicitamente: o prazo privado de
`root_bootstrap.py` e do publisher passa a zero, impedindo ativação; o peer
privado do Node-RED vira `<NODE_RED_PEER>`. Os demais módulos e os três harnesses
genéricos conservam seus bytes de origem. Um instalador deve resolver os bindings
mediante configuração protegida aprovada e criar novos pins. Não há instalador
armado neste diretório.

## Organização

| Superfície | Fontes |
| --- | --- |
| Estado, reservas, jobs e coordenação | `workflow.py`, `component_jobs.py`, `root_coordinator.py`, `executor_observer.py`, `reciprocal_gate.py` |
| Autoridade e transporte de tarefas | `admission.py`, `owner_lease.py`, `root_bootstrap.py`, `native_factory.py`, `initial_host_contract.py`, `task_adapter.py` |
| Fontes, validação e publicação protegida | `source_writer.py`, `preparation_storage.py`, `validation_profile.py`, `preparer.py`, `revision_review.py`, `publisher_parent.py`, `publication_bridge.cjs`, `revision_store.cjs` |
| Leitura, deploy e composição de recibos | `readonly_parent.py`, `worker_parent.py`, `canonical_worker.py`, `effects/`, `attestation_model.cjs` |
| Probe específico e validação isolada | `functional.py`, `harness/` |

O contrato local não seleciona modelo nem realiza inferência. Os gates e recibos
podem ser consumidos por outro chatbot MCP. A rota atual de tarefas e seu
orçamento ainda dependem do adaptador/daemon Codex. Não há outro executor aceito.

## Limites atuais

Só o perfil inicial `observacao_host` está ativo. As nove fontes permitidas vêm
do perfil Root e devem corresponder à revisão pública aprovada. Outro componente
ou revisão exige perfil, validação, efeito e prova específicos; não herda acesso.
Após alterar essas fontes, `profile_refresh_required` pode impedir nova
preparação até a revisão protegida do perfil.

A recorrência permanece desativada. Produtores de saúde e webhooks continuam
somente leitura. O núcleo não instala firmware, reinicia a casa, aciona rádio,
faz limpeza ou amplia o catálogo de Storage. Todos esses efeitos exigem seus
próprios contratos e admissão.

O SourceWriter restringe nove nomes e usa CAS, ownership e modo preservados.
O rename atômico requer duas pastas pai graváveis no sandbox Root; não alegar
que `ReadWritePaths` concede somente os nove arquivos. Código proposto executa
no sandbox separado UID65534, sem rede, dados privados ou credenciais.

O guard interno mantém capabilities vazias. A unidade instalada faz bind
readonly somente do inode do operations lock para um diretório Root0700. O
guard faz lstat nesse alias e correlaciona o peer e seu WRITE FLOCK em
`/proc/locks`; não lê o lock, tabelas de FDs, bancos privados de UID1001 ou
credenciais. O bind ocorre antes da retirada de capabilities, sem mudar ACL,
modo ou proprietário do arquivo original.

## Provas que continuam distintas

`functional.py` cobre especificamente o reset sintético do observador do host:
before com callback de status e candidato sem esse callback, em unidades
isoladas, vinculados a leituras nativas do hash carregado. O resultado declara
`native_full_flow_replay: false` e saúde física desconhecida. Não substitui replay
no Node-RED real, recuperação física, execução espontânea da Eva ou continuidade
de 24 horas. Nenhuma dessas provas é inferida de um webhook 2xx ou aviso removido.

## Testes portáteis

O agregador público
[`component-runtime.test.mjs`](../../component-runtime.test.mjs) executa as
fixtures sintéticas deste diretório. Não lê caminhos privados do operador,
conecta à casa, usa Root, cria units ou credenciais. As 62 verificações Python
exercitam idempotência, reservas, falhas, publicação, fontes e recibos; os checks
Node usam clientes falsos e funções sintéticas. A execução é responsabilidade do
alvo canônico e do coordenador; a publicação destas fixtures não afirma sucesso.
Os casos de seleção de prova verificam hashes, vínculo com a operação, resultado
nativo terminal e preservação da falha anterior. A substituição de ownership nas
fixtures permite testar esses contratos sem acessar diretórios Root do host;
não representa uma dispensa dessas verificações no runtime.

Instalação, uso e revogação estão no
[runbook canônico](../../../../docs/raspberry-mcp/reference/component-repair.md#núcleo-protegido-instalado-com-perfil-inicial-do-host).
