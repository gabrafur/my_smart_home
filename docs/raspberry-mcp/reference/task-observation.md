# Observação da tarefa coordenadora

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Consultar a tarefa coordenadora pelo cliente MCP

A referência autorizada `coordenacao_meta` agora integra a observação, além de
`principal` e `backup`. A alteração corrige a recusa anterior do leitor limitado
a duas referências; não cria uma tarefa substituta nem repete o envio do cliente MCP autorizado.
A identidade privada da coordenadora é um binding da instalação, representado
por `${AUTHORIZED_THREAD_ID_3}` nas fontes públicas.

No catálogo atualmente disponível ao cliente MCP autorizado, chamar:

```json
{"host":"raspberry"}
```

na ferramenta `maintenance_capabilities`. Ler
`evidence.data.authorized_thread_observations.threads` e
`evidence.data.authorized_thread_observations.coordination_checkpoint`.
Esse caminho já foi aceito pelo cliente MCP conectado, sem o PC. Não depende
que o cliente receba imediatamente descritores novos.

Clientes com catálogo atualizado também podem usar `codex_thread_read` ou
`codex_thread_status` com `host` e o `thread_id` autorizado da coordenadora,
**sem `operation_id`**. O resultado contém metadados atuais do daemon e
`coordination_checkpoint`. O `codex_task_list` instalado inclui essa referência
na paginação do inventário autorizado. O leitor direto exige o schema novo;
um catálogo antigo que ainda enumere duas referências deve usar o caminho por
`maintenance_capabilities`, sem forçar argumentos fora do schema do cliente.

O resumo de coordenação informa trabalho declarado, revisão Git declarada,
componentes reservados, avanços e pendências em campos enumerados. Ele permite
comparar propostas e evitar duplicidade, sem expor mensagens, prompts ou logs.
`installed_source_fingerprints` contém hashes dos dois produtores Events fixos,
calculados sobre arquivos root, sem exportar seu conteúdo.

O relatório vem de um arquivo fixo já acessível ao broker, com UID 1001, modo
0600 e máximo de 16 KiB; não há caminho recebido pela API nem nova montagem.
Ao portar a instalação, o operador define esse binding junto das identidades
antes de selar código e hashes. O produtor atualiza o relatório ao mudar de
fase ou concluir trabalho, com horário e revisão reais. Não renovar o horário
apenas para aparentar progresso. Após 300 segundos, `state=unknown`,
`collection_error=coordinator_report_stale` e `scope_fresh=false`; as reservas
antigas permanecem visíveis e não são liberadas automaticamente. Ausência,
falha de leitura, schema inválido ou data futura mantêm a observação desconhecida.

O relatório não comprova execução, conclusão da meta nem autorização:
`execution_receipt`, `goal_completion_verified` e
`administrative_authority_from_report` são sempre falsos. A declaração de meta
pausada também é preservada. Para um resultado efetivo, consultar os recibos da
operação correspondente; uma proposta não implementada continua proposta.

A coordenadora recebe observação somente por essa extensão, com
`adapter_send_admission=coordinator_observation_only`. Estar tecnicamente apta
no daemon não autoriza envio; enquanto ativa, a projeção informa
`serial_execution_gate=busy`. Os dois destinatários legados de envio, os
limites compartilhados, a expiração e os gates existentes continuam valendo.
Nenhuma consulta chama `resume`, inicia inferência ou lê histórico bruto.
`notLoaded` não é término. Links permanecem nulos enquanto a integração não
fornecer ou validar um link e sua plataforma.

O aceite real observou 38 ferramentas no servidor padrão, enquanto o catálogo
nativo conectado ainda tinha 31. A listagem percorreu cinco páginas de dois
itens, com nove identidades autorizadas, sem duplicidade. Uma identidade antiga
não carregada manteve erro explícito de coleta; a cobertura continua parcial.
Última criação e última execução vêm dos registros do adaptador; não são a
thread coordenadora apenas por ela estar ativa. A execução mais recente tinha
protocolo concluído e resultado da tarefa bloqueado, sem novo envio nesta
correção.

A instalação preservou os recibos da primeira recusa por um pin de política
não atualizado e da reconciliação desse pin. A cadeia inclui hashes do código,
`legacy_policy_sha256` e dependências da política de reparo; atualizar somente
os hashes de fonte não basta. Não se remove um pin para fazer uma chamada passar.
O aceite posterior confirmou a cadeia completa, sem reiniciar serviços.
As [regressões isoladas](../../../scripts/raspberry-mcp/owner-thread-access.test.mjs)
e o [recibo público sanitizado](../../../scripts/raspberry-mcp/owner-thread-access.acceptance.json)
registram o escopo validado; os recibos privados permanecem no plano central.

## Observador limitado de resultados registrados

A fonte `registered_task_terminal_observer_v1` acrescenta uma etapa ao coletor
já existente; não cria timer, tarefa de IA ou rotina de reparo. Lê somente o
registro local e consulta no máximo um envio pendente por amostra. O adaptador
selado permite apenas `observe` do par thread/turno já registrado. Não cria,
envia, retoma, reconcilia ou grava no ledger. O orçamento adicional é inferior
a dois segundos, com timeout de transporte; falha permanece desconhecida.

A instalação confere política, boot, inode, proprietário e peer do socket
aprovado. O arquivo visível no host pode ser um placeholder: o socket real é
fornecido pelo namespace da unit. Não aceitar identidade nova com base nesse
placeholder. Uma montagem somente leitura de socket não restringe métodos;
a restrição de protocolo depende do adaptador fixo e de seus hashes.

O snapshot privado contém metadados e referência opaca do recibo; publicação
atômica não altera o ledger. O worker recebe somente uma montagem do diretório
de metadados, sem socket ou checkout. Montar apenas o arquivo prenderia um
inode antigo após substituição atômica. Diretório e grupo devem permitir leitura
pelo worker, sem escrita. A preparação de boot cria somente o diretório fixo.

Terminais reconciliados são retidos na janela móvel de 24 horas após o início
do escopo; há limite de 64 resultados por amostra. Truncamento, clock incoerente,
coordenador ocupado, identidade alterada, coleta falha ou atraso permanecem
explícitos. A janela não garante recuperar uma indisponibilidade prolongada.
O hash usa exatamente a serialização do recibo nativo. O horário terminal vem
do resultado nativo, sem reutilizar o horário de uma atualização posterior do
ledger, evitando eventos duplicados após consulta ou reconciliação.

O consumidor precisa de política recorrente aprovada separadamente e de
admissão atual do backend antes de novo envio. Expiração não cria autoridade;
revogação fecha a observação nova conforme o marcador fixo. Descoberta ou
`continuation_ready` não comprovam execução do assistente. Veja o
[contrato Events](events-protocol.md) para migração, deduplicação e verificação.
As fontes e os testes sintéticos ficam em
`scripts/raspberry-mcp/runtime-source/task-terminal-observer/`; políticas,
identidades, referências reais e recibos permanecem privados na instalação.
