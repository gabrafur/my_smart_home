# MCP Raspberry

O MCP expõe observações e operações delimitadas do servidor residencial. O
cliente de IA pode mudar; a autoridade continua na política local, com os mesmos
alvos, cotas, identidades, validade e registros duráveis. Esta documentação não
renova concessões nem certifica a execução de um cliente recém-conectado.

| Necessidade | Documento canônico |
| --- | --- |
| Entender fronteiras, dependências e portabilidade real | [Arquitetura e autoridade](architecture.md) |
| Instalar a base ou conectar outro cliente, sem expor credenciais | [Instalação e conexão](installation.md) |
| Descobrir ferramentas e validar argumentos | [Ferramentas e esquemas](tools.md) |
| Detectar, diagnosticar, corrigir, reverter e verificar | [Operação e recuperação](operations.md) |
| Entender mudanças de caminhos e preservação das evidências | [Migração documental](migration.md) |

As referências são organizadas por função: [base de leitura](reference/read-only-base.md),
[tarefas](reference/task-control.md), [observação da coordenadora](reference/task-observation.md),
[Git e workers](reference/git-and-workers.md), [observação do host](reference/events-and-host-observation.md),
[protocolo Events](reference/events-protocol.md), [notificações](reference/notifications.md),
[reparo por componente](reference/component-repair.md),
[vínculo do leitor Node-RED](reference/nodered-reader-binding.md), [backup](reference/backup-verification.md)
e [continuidade](reference/continuity.md). As [etapas de manutenção](maintenance/matrix.md),
[primeira entrega](maintenance/stage1.md), [evidências posteriores](maintenance/evidence-stage2.md)
e [propostas](maintenance/proposals.md) registram escopos históricos; propostas
não habilitam ferramentas.

A [comunicação com threads existentes](reference/workspace-communication.md)
é uma admissão separada nas ferramentas atuais, sem criar threads substitutas
ou mudar o perfil da destinatária. Sua validade e disponibilidade são informadas
por `codex_task_list`; um catálogo atualizado não concede essa autorização.

A [proposta de administração geral do Node-RED](reference/nodered-administration.md)
separa o grafo, a revisão de efeitos e a admissão de deploy. O código candidato
permanece fechado e não instalado até confirmação específica; não amplia o
perfil protegido `observacao_host` nem autoriza testes com equipamentos.

O [núcleo protegido por componente](reference/component-repair.md#núcleo-protegido-instalado-com-perfil-inicial-do-host)
já expõe admissão real pelo MCP para o perfil inicial `observacao_host`, usando
as ferramentas de tarefas existentes. Outros perfis, recorrência, replay nativo
completo e execução proativa da Eva continuam sendo aceites separados.

O transporte MCP e a identidade do cliente são separados do executor. O backend
de tarefas implementado continua sendo o daemon Codex; não há segundo backend
de execução aceito. As ferramentas `codex_*` e o prefixo legado `eva-admin-`
permanecem por compatibilidade, sem exigir uma persona ou modelo no cliente.
O gateway HTTP opcional é local e não certifica acesso por qualquer fornecedor.

Descoberta, saúde, webhook aceito e conclusão de turno são evidências diferentes.
O ciclo autônomo completo exige correlação do incidente, execução admitida,
recibo e verificação funcional do componente. Consulte as capacidades e o estado
reais: disponibilidade do MCP não comprova que a ponte de execução esteja admitindo
trabalho. Resultados de restore isolado e aceites de produção também são distintos.
