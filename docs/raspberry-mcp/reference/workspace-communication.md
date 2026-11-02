# Comunicação com threads existentes

O cliente pode encaminhar mensagens a threads do mesmo projeto e daemon
quando a política Root `workspace_thread_communication` estiver habilitada.
`codex_task_list` informa essa admissão e seu prazo. A aprovação de comunicação
não transfere permissões de execução entre threads nem renova a concessão.

Use `codex_task_send` com uma nova referência de operação e o UUID conhecido
da destinatária sem hífens em `task_id`. Um registro de tarefa existente com
esse ID sempre tem prioridade; não há fallback para contornar sua admissão.
A descoberta continua parcial: referências fixas, tarefas registradas e até
64 referências de comunicação já utilizadas; não enumera conversas privadas.

A ponte verifica o proprietário e a identidade exata do socket, projeto fixo,
thread persistente, provider `openai` e assinatura incluída. No estado `active`,
envia uma única `turn/steer` com `expectedTurnId`; em `idle`, uma única
`turn/start` sem alterar modelo, permissões ou aprovações. Não interrompe,
retoma, clona nem recria a destinatária. `notLoaded` é recusado: os metadados
atuais não comprovam o perfil necessário para uma retomada fiel. Não significa
thread concluída. Contrato nativo: [OpenAI App Server](https://learn.chatgpt.com/docs/app-server).

O registro usa o namespace interno `workspace:<UUID>` na tabela de envios
existente, sem criar tarefa ou mudar o esquema SQL. Cotas, intervalo, bloqueio
serial, revogação, prazo e confirmações da interface permanecem compartilhados.
O intent é persistido antes do envio. Resposta perdida continua incerta;
repetir a mesma referência só consulta o recibo, nunca reenvia. Uma operação
pendente ou incerta também pode impedir comunicação com outra thread.

`codex_task_status` consulta somente o turno registrado. Uma resposta pública
do assistente é limitada a 4 KiB, sanitizada e exportada somente quando sua
posição posterior à fronteira pós-envio for comprovada. Segredos, endereços,
códigos de autenticação, conteúdo de ferramentas e histórico ficam ocultos.
A referência exata da operação em uma resposta posterior comprova ACK; aceite
RPC, término do turno e ausência de erro não o substituem. ACK também não
comprova a execução da solicitação nem a recuperação funcional da casa.

O observador terminal exporta apenas referência opaca, hash, estado e horários;
o namespace e os IDs das threads não atravessam o evento. Após registrar o
resultado terminal no checkpoint, reconcilie seu hash exato. Nunca reconcilie
um turno ativo nem use outra referência para contornar entrega incerta.

As regressões sintéticas ficam nos agregadores `owner-thread-access.test.mjs`
e `task-terminal-observer.test.mjs`. Elas usam bancos temporários e transporte
simulado. Instalação, aceite RPC, ACK real e execução funcional exigem provas
separadas pela interface MCP; os testes não acessam dispositivos da casa.
