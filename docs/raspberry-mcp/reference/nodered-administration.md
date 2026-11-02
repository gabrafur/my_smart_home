# Administração geral do Node-RED

O contrato administrativo tem implementação, validação e instalação separadas.
Publicar ou importar o código não ativa acesso: consulte `nodered_admin_read`
com `view=policy` para conhecer a concessão real. As fontes e os templates ficam
em `scripts/raspberry-mcp/nodered-admin-candidate/`, nome preservado por
compatibilidade; o perfil protegido de `observacao_host` permanece separado.

## Capacidade e autoridade

A implementação oferece um contrato administrativo único para os fluxos do mesmo
Node-RED: leitura, criação, edição, desativação recuperável, validação, deploy e
reversão. Não exige criar outro contrato de componente para cada função.
A administração pode ser feita por qualquer cliente autorizado; o nome Eva não
é uma identidade de segurança nem uma dependência de modelo.

O acesso atual de diagnóstico e a delegação administrativa não tornam o
catálogo de arquivos um instalador: `new_source_edits` continua desabilitado e
`file_apply`/`file_revert` continuam bloqueados por
`atomic_compare_replace_unavailable`. O perfil inicial protege apenas
`observacao_host`; não será ampliado artificialmente para iluminação.

A ativação exige confirmação específica do proprietário sobre o delta de
segurança. Depois, mudanças ordinárias dentro dessa política podem ser
revisadas e admitidas pelo executor delegado, sem nova concessão por função.
A aprovação da interface do cliente continua obrigatória quando exigida.
Metadados opcionais de transporte MCP (`_meta`) são limitados e descartados
antes da aplicação; não representam concessão, revisão ou aprovação de efeito.
Efeitos novos sobre equipamentos sensíveis precisam de autorização específica;
administração de fluxos não autoriza acionar luzes, portão ou fechaduras como
prova. A análise estática de JavaScript não é uma sandbox nem prova de ausência
de efeitos.

## Operações propostas

| Ferramenta `nodered_admin_*` | Comportamento |
| --- | --- |
| `read` | Páginas de até 16 nós, diff ou campo público revisado em fragmentos de até 8 KiB; snapshot/plano/nó vinculados por hash |
| `prepare` | Cria plano com edição por ID, CAS de nó e do snapshot, beforeimage privada, diff e inventário de efeitos |
| `validate` | Exige provas isoladas de sintaxe, grafo, layout, observabilidade, tipos instalados e fontes canônicas |
| `preflight` | Revalida fontes, política, revisão, locks, recursos, cotas, autorização e guardas; não aplica |
| `apply` | Um único deploy `nodes`, API v2, com revisão opaca obrigatória; recibo durável antes da rede |
| `status` | Consulta o mesmo recibo, inclusive após expiração ou revogação |
| `verify` | Relê configuração e guardas; não converte incerteza em sucesso nem comprova dispositivos |
| `rollback` | Prepara novo plano inverso da própria operação; exige validação e admissão próprias |
| `revoke` | Fecha novas sessões/efeitos, preservando histórico e observação |

A vista `policy` de `read` informa a concessão específica, a validade e a
permissão de manutenção ordinária por eventos, sem ler credenciais. Essa
autorização é separada do monitor antigo e não transforma saúde em execução.

As entradas não aceitam shell, comandos, caminhos, URLs, credenciais, políticas
ou flags de aprovação. Tipos que oferecem shell, escrita por caminho livre,
instalação de módulos ou novos listeners ficam fora da candidata inicial;
nós existentes fora do diff são preservados. Alterar o JavaScript de uma
função continua sendo uma operação poderosa e exige revisão de efeitos.

## Transporte, executor e proteção de dados

O frontend usa um novo socket AF_UNIX fixo no canal privado existente. Não
amplia a rede pública, não altera autenticação do Node-RED e não transforma o
leitor atual em escritor. O executor é um serviço Root com código,
política e dependências selados, gramática fechada e contenção systemd; não é
uma ferramenta de Root genérico. Essa nova superfície privilegiada é parte
explícita da aprovação de ativação, não um privilégio já concedido à candidata.

A senha existente do Node-RED chega somente por `LoadCredential`, sem token do
Home Assistant. Sessões usam leitura para observar e escrita para aplicar,
com revogação após cada requisição. Uma recusa anterior ao envio só é
classificada como não despachada quando comprovada pelo transporte selado exato;
perda de resposta após o envio continua incerta. O usuário subjacente tem administração
ampla: comprometer o executor ou sua sessão pode comprometer os fluxos. Perda
do recibo de login ou falha de revogação fecha novas sessões; não se afirma
revogação de um token que nunca foi recebido.

O serviço grava apenas seu journal privado, com arquivos Root `0600`, sem
copiar senha ou chave de credenciais para resultados. Configurações privadas
ficam no executor. Campos opacos são preservados por hash; código legível só é
exportado após correspondência exata com fonte pública revisada por um
catálogo Root, sem flag de publicidade fornecida pelo cliente.

A exclusão inicial é lógica: mantém os IDs e desabilita os nós/tabs. Não há
purge, remoção de volumes, redefinição de contexto, troca de chave ou edição
de credenciais. A recuperação exige evidência da versão instalada; contexto
retornado pela API pode estar truncado, e `{}` para nó desabilitado significa
informação desconhecida. Não é prova de contexto vazio nem de igualdade
integral. O guard identifica separadamente a preservação por construção do
Core, o ciphertext de credenciais e os limites da observação.

A prova do backend é produzida inline antes de cada HTTP, sob os locks reais,
vinculada a PID e nascimento, namespace de rede, IP local e socket de escuta
pertencente ao processo. Não há renovador, agenda, prova estática reutilizada ou
aceite automático de identidade nova. Essa observação não afirma autenticação;
a resposta real do endpoint comprova o login separadamente.

Ancestrais dos cinco arquivos fixos têm identidades completas revisadas. Uma
permissão de escrita para grupo só é elegível com GID0 e pin exato; escrita
pública, outro grupo com escrita, symlink ou divergência continuam bloqueados.
O executor não altera permissões do runtime para passar na verificação. Essa
exceção restrita e os pins fazem parte da confirmação específica de ativação.

## Transação e recuperação

Cada plano registra IDs, campos e hashes antes/depois, revisão atual, diff,
origem e cobertura. O array integral preserva ordem, nós e campos não editados.
A revisão da API é **opaca**; SHA-256 é uma identidade de conteúdo separada.
Nunca se omite a revisão para forçar deploy. A API responde conflito quando a
revisão mudou; consulte [GET /flows](https://nodered.org/docs/api/admin/methods/get/flows/)
e [POST /flows](https://nodered.org/docs/api/admin/methods/post/flows/).

Locks compartilhados ficam mantidos durante preflight, intent, deploy,
verificação e recibo. Provas nativas se vinculam à geração imprevisível dos
locks e ao PID atual; uma leitura antiga do ledger não prova exclusão. O
Node-RED editor não participa desses locks, por isso o CAS continua obrigatório.
A comparação de processo preserva nascimento, usuários/grupos, root, namespace
e mountinfo; alternância normal entre `R` e `S` não muda identidade. Ambas
as observações precisam continuar vivas; processos mortos e divergências dos
vínculos continuam recusados.

Um intent ou resultado incerto bloqueia novos efeitos, inclusive com outra
chave. Não há retry, novo deploy ou reversão automática. A reversão própria
exige revisão e hash integral da configuração posterior ainda iguais; mudanças
posteriores de terceiros impedem sobrescrita. A reversão de criação mantém os nós novos desabilitados, com os mesmos IDs e
dados. Config nodes sem quarentena comprovada não são removidos nem apresentados
como reversão bem-sucedida; não se elimina contexto silenciosamente.

Mesmo `nodes` para e inicia nós alterados. `initialize`, `finalize`, timers,
catch/status, reconexões, mensagens retidas, subflows e dependências de nós de
configuração fazem parte da revisão. Um plano que possa disparar equipamento
sensível não pode ser admitido apenas por um teste de sintaxe bem-sucedido.

## Primeiro reparo: confirmação da iluminação

A correção canônica da iluminação está nos geradores, funções e testes do
Node-RED. `lighting.patch` preserva o artefato de revisão anterior à promoção;
não deve ser reaplicado a fontes já corrigidas. Geração, canvas e testes
continuam disponíveis em cópia pública isolada.
O diagnóstico anterior permanece reconciliado e não é repetido. A associação
entre o defeito sintético e um aviso real continua sem comprovação.

A política canônica usa janela visual de 60 segundos, maior que a acomodação e
limitada a 300 segundos. A confirmação exige operação pendente exata, mesma
emissão e leitura estritamente posterior, dentro da janela. Callback
substituído não altera estado; sucesso, mismatch válido e expiração encerram
a expectativa. Mudança manual posterior não é comparada a comando antigo.
O epoch volátil invalida expectativa persistida após reinício. Expiração é
checada no próximo callback/evento, sem agenda nova; dados antigos ou
inconclusivos não geram mismatch. Recuperação após um mismatch exige novo
comando confirmado, sem atribuí-la a uma mudança manual.

O novo controle de janela tem inicialização de configuração no deploy. Isso
precisa constar no plano concreto, mesmo sem comando residencial. O deploy
pode cancelar timers anteriores dos nós alterados; não reinicia o serviço
Node-RED. O reparo não inclui execução de injects de teste em produção.

## Ativação e aceite

O escopo proposto dura 48 horas a partir da ativação, limitado pelo prazo
administrativo existente, sem renovação automática. Limites: quatro deploys
por 24 horas incluindo reversões, intervalo de 60 segundos, plano de até
15 minutos, até 128 nós/1 MiB por mudança, 64 operações e 256 MiB de journal.
Não há purge automático de beforeimages ou recibos. Provas nativas têm teto adicional de 64 MiB, até 32 gerações de locks por operação; o journal de autenticação admite até 1.023 sessões por concessão, sem apagar recibos para liberar cota.

Antes da instalação, o operador deve fechar o manifesto com hashes exatos,
identidades nativas, recursos, fontes públicas, política, arquivos novos e
reconexão do frontend. O proprietário confirma esse delta. A instalação não
comprova admissão: política, produtor nativo, provas isoladas, guardas e
aprovação da operação precisam estar efetivamente disponíveis.

O aceite exige consulta MCP real, preflight e recibo exatos, releitura da
configuração carregada, guardas e observação de um ciclo natural. Teste
isolado, commit, catálogo visível ou tarefa aceita não provam correção em
produção. Até a ativação confirmada e a admissão concreta, nada é aplicado.

O vencimento ou a revogação da concessão administrativa fecha novos efeitos e
preserva recibos. Não reverte automaticamente fluxos já aplicados.
