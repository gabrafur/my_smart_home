# Arquitetura e autoridade do MCP Raspberry

| Camada | Contrato e limite |
| --- | --- |
| Cliente e modelo de IA | Escolhem objetivos e interpretam respostas; sua identidade não amplia permissões |
| Protocolo MCP | Inicialização, descoberta, JSON Schema e chamadas; não concede autoridade administrativa |
| Transporte | Socket/relay, túnel existente ou gateway opcional; autentica o acesso sem renovar o escopo |
| Política local protegida | Define alvos, bindings, hashes, validade, cotas, gates, revogação e auditoria |
| Adaptador executor | Implementação atual de tarefas via daemon Codex, com identidade e perfil conferidos |
| Produtores e efeitos | Fatos naturais continuam com seus produtores; políticas residenciais pertencem ao Node-RED |

Trocar o cliente ou seu modelo não exige outra concessão Root, novas cotas ou
credenciais do executor. Credenciais de transporte só mudam quando a conexão
escolhida realmente as exigir. Um novo principal exige autorização de acesso ao
transporte, sem herdar poderes de uma conversa. Para substituir o executor,
será necessário implementar um adaptador, preservar idempotência, reconciliação,
perfis, quotas e evidências e obter seu aceite. Essa troca ainda não está entregue.

As observações abaixo descrevem a instalação e seus aceites registrados. O
estado corrente e a admissão devem vir das ferramentas reais. Um serviço saudável
com lease expirada continua sem autorização para executar novos efeitos.

## Autoridade e funcionamento

A autoridade vem exclusivamente da política local aprovada e vigente. O cliente
MCP encaminha objetivos administrativos ao executor local pelas ferramentas
existentes; a documentação, a identidade do cliente e o modelo não concedem acesso. O cliente pode solicitar diagnóstico,
correção de código, implantação revisada e recuperação de serviços dentro da meta;
não fica limitado ao verificador `repair_health_summary`.

Não há ferramenta MCP de shell livre. O executor local tem acesso administrativo
pela conta já autorizada, e a API recebe objetivos, critérios de aceite e IDs,
não comandos ou configurações de privilégio. A propriedade root do código e das
políticas impede que parâmetros de uma chamada ampliem essa autorização.

O aceite real confirmou UID nativo 1001 e UID administrativo 0. Isso prova a
rota de autoridade; não comprova a conclusão de todas as correções futuras nem
a autonomia proativa de ponta a ponta.

Validade, escopo, quota e concessões são consultados na política local protegida.
Instalar ou trocar um cliente/modelo não os renova. Admissão expirada permanece
bloqueada até autorização específica; preservar custos e trabalhos existentes.

A expiração fecha novas criações,envios,preflights e mudanças de perfil.
Consultas das identidades já registradas e reconhecimento de hashes terminais
continuam disponíveis. Essas leituras ainda validam código e políticas root;
uma consulta ao daemon exige o mesmo boot e a identidade de peer aprovada.
Se o peer não puder ser confirmado,um envio em andamento mantém o estado
armazenado com erro de coleta explícito. Isso não o transforma em concluído.
Uma reconciliação de criação que ainda dependa de `resume` permanece bloqueada.
Na listagem,o daemon pode continuar ocioso e capaz de receber entrada enquanto
`adapter_send_admission=closed` e `can_accept_input=false` indicam o bloqueio
real do adaptador. O cursor considera essa mudança de admissão.

## Componentes instalados

As [fontes ativas exportadas](../../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json)
permitem auditar as extensões de tarefas,administração,projeções,Events e
instrumentação. O manifesto registra hashes da origem e do arquivo publicado.
Identidades privadas foram substituídas por marcadores e representações de
constantes temporais foram normalizadas sem alterar seus valores. Esse conjunto
é uma captura de fontes com bindings removidos,não um instalador sobre a
política ativa. Políticas,credenciais,bancos e recibos privados não pertencem
ao pacote público. Não copiar esses arquivos diretamente sobre a produção sem
revisar os bindings e atualizar os hashes da política root.

O candidato anterior em `scripts/raspberry-mcp/task-control/` foi preservado.
Ele tem implementação e baseline diferentes,usa `codex_threads_list` e não
deve substituir a versão ativa apenas por estar no mesmo repositório.

| Componente | Local / função |
| --- | --- |
| Frontend MCP | `/var/lib/raspberry-mcp/root/app/`; JSON-RPC e descritores |
| Socket local | `/run/raspberry-mcp/mcp.sock`; acesso por permissões Unix |
| Relay stdio | `/usr/local/lib/raspberry-mcp/relay.py`; destino fixo, sem argumentos |
| Broker de operações | Instâncias `raspberry-mcp-operations@.service` |
| Adaptador de tarefas | `/usr/local/lib/raspberry-task-control/` |
| Projeções e reparo fixo | `/usr/local/lib/raspberry-repair-control/` |
| Executor de inferência | Daemon Codex existente no Raspberry; assinatura incluída |
| Conta administrativa | binding lógico `executor_admin`; concessão local com validade própria |
| Transporte remoto atual | OpenAI Secure MCP Tunnel; autenticação existente |
| Auditoria durável | Banco de tarefas, recibos e checkpoint central do plano |

O protocolo entre chatbot e MCP é independente do modelo do cliente. O backend
de tarefas desta instalação continua usando o daemon Codex existente. Trocar o
chatbot cliente não troca esse executor nem cria autorização para API paga.
Trocar também o executor requer um adaptador próprio, revisão e aceite; não
está comprovado nesta instalação.

## Pendências que não devem ser ocultadas

No aceite descrito, o conector OpenAI ainda não publicava os sete nomes novos de listagem/reparo,
embora o servidor os liste. A administração acima usa ferramentas já publicadas.
O caminho Events descrito recebe somente avisos sanitizados do Home Assistant;
falhas diretas do host ainda não são encaminhadas por ele. O backend fixo,
o aceite administrativo e a descoberta stdio não comprovam comportamento
proativo completo,24h de cobertura,PC desligado,backup offsite ou recuperação.

## Referências de interoperabilidade

- [MCP: transportes](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP: descoberta e chamada de ferramentas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

As referências definem o protocolo; não certificam este servidor ou um cliente
específico. A evidência local e o aceite real determinam o que está comprovado.

