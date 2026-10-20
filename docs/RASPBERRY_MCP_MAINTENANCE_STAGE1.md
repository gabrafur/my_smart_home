# Raspberry: projetos e serviços — etapa 1

Estado: instalada, com 16 ferramentas publicadas. A Eva confirmou a descoberta, executou seis chamadas reais e repetiu as três leituras Docker após a correção. Esta etapa é parcial em relação à interface completa de manutenção solicitada.

## Escopo entregue

Cinco ferramentas novas, todas de leitura, preservando as onze anteriores:

- `maintenance_capabilities`: versão de contrato, capacidades implementadas, alvos permitidos e lacunas explícitas.
- `host_diagnostics`: amostra de CPU, memória, swap, temperatura, throttling, espaço e inodes do filesystem do projeto. Sem série histórica.
- `service_diagnostics`: estado Docker, healthcheck, reinícios, início, OOM e código de saída de Home Assistant, Node-RED ou Mosquitto. Estar em execução não prova prontidão funcional.
- `operation_status`: status e hashes de uma proposta existente, sem expor seu conteúdo ou backup. Ainda não reconcilia reinícios de resultado desconhecido.
- `change_validate`: validação sintática de proposta JavaScript, sem executar/importar o conteúdo. Markdown e YAML permanecem sem validador aprovado nesta versão.

O contrato adicional é `schema_version: 1.0.0`. Cada evidência traz origem, `observed_at`, idade, erro de coleta e cobertura. Os estados são `healthy`, `failed`, `unknown` e `stale`; dado velho não equivale a saúde atual. Medições sem limiares aprovados ficam `unknown`, mesmo quando a coleta funciona.

O resultado de sintaxe não é um gate persistido de aplicação. A ferramenta de aplicação anterior continua com o seu contrato original: editar fonte não implanta a configuração nem valida comportamento do serviço. Não foi acrescentada autorização de escrita.

## Implementação e implantação

Arquivos aditivos no Raspberry, em `/mnt/data/docker/scripts/raspberry-mcp/`:

- `maintenance_diagnostics.py`
- `diagnostics-broker.py`
- `diagnostics-server.mjs`
- `test_maintenance_diagnostics.py`
- `diagnostics-server.test.mjs`
- `install-diagnostics.py`
- `test_install_diagnostics.py`

O instalador fixa hashes da versão anterior e dos novos arquivos. Recusa divergências e instalação duplicada, adiciona dois overrides de entrada e preserva o catálogo, propostas e código anterior. Se uma etapa falhar, remove somente os arquivos que acabou de adicionar, recarrega as unidades e reabre o túnel anterior. Não altera credenciais, rede, containers ou automações. Acesso de sistema e isolamento são os já existentes.

Para ativar a versão preparada, no terminal pessoal autenticado:

```text
wsl.exe ssh -t raspberry "sudo python3 -B /mnt/data/docker/scripts/raspberry-mcp/install-diagnostics.py"
```

Nunca enviar senha ao chat. Sucesso esperado: `MCP diagnostics installed; tunnel active; 16 tools. Household services unchanged.`

## Evidência de teste

31 testes passaram no WSL e no Raspberry: 20 do diagnóstico, 5 do instalador e 6 Node. No Raspberry foram executados sequencialmente pelo wrapper de proteção de recursos. O preflight retornou `Diagnostics preflight passed; no changes made.` Os testes do instalador verificam recusa de hashes alterados, destinos existentes e symlinks, além de preflight sem escrita.

Cobertura: alvos negados, entradas adicionais negadas, symlink negado, conteúdo privado omitido, metadados inválidos, dado antigo, contador CPU inválido, ausência de healthcheck, conflitos, expiração de proposta, parser sem execução, timeout desconhecido, IDs sequenciais/concorrentes e novas sessões stdio. Um arquivo temporário percorreu proposta → sintaxe → aplicação → verificação de hash → repetição idempotente → reversão.

Esse ciclo é sintético e valida o mecanismo de edição de fonte. Não comprova implantação nem comportamento real de Home Assistant, Node-RED ou Mosquitto. Nenhum serviço residencial foi usado como cobaia.

Em leitura direta por SSH autorizado, às 13:28:35 UTC de 19/10/2026, o novo coletor observou cerca de 6,28 GB de memória disponível, 26,24 GB de disco disponível e 53,45 °C. Home Assistant e Node-RED estavam `running` com healthcheck `healthy`; Mosquitto estava `running` sem healthcheck. Os três informaram contador Docker de reinícios igual a zero. A coleta de throttling ficou indisponível e foi reportada como desconhecida. Essa execução ocorreu fora do sandbox instalado do broker; a disponibilidade de cada coleta dentro dele ainda precisa ser validada.

A ferramenta original `disk_space` também foi chamada pelo conector neste Codex/Work, com `host: raspberry`. Respondeu `observed_at: 2026-10-19T13:22:03.751Z`, total 62.477.467.648 bytes e disponível 26.244.157.440 bytes. Essa chamada não é validação das cinco novas capacidades pela Eva.

As cinco ferramentas originais preservadas são `service_health`, `service_versions`, `disk_space`, `backup_results` e `log_summary`.

## HTTP 409 e sessões

Na validação real desta etapa, a Eva não observou HTTP 409 em seis chamadas sequenciais. Isso não demonstra correção da falha intermitente nem cobre expiração no ChatGPT.

A documentação oficial do tunnel-client identifica HTTP 409, código -32002, `mcp_initialization_required` como rejeição da chamada antes de completar a inicialização stdio. Isso explica a classe do erro, mas não identifica sozinho a causa observada na Eva. O cliente é responsável pela inicialização e recuperação; chamadas rejeitadas não chegam ao processo MCP.

Os testes desta etapa comprovam roteamento local e reconexão de processos. Não comprovam expiração de sessão no ChatGPT nem resolvem o 409 do túnel. Não foi habilitada geração automática de `notifications/initialized` sem evidência de necessidade.

Referências: [Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) e [configuração oficial do tunnel-client](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md).

## Atualização e validação do plugin

Usar a conexão existente [Raspberry: projetos e serviços](https://chatgpt.com/plugins/plugin_asdk_app_6ad60e75546c81919644fc868008f7be). Após ativação, atualizar a lista de ferramentas na configuração, sem criar outro túnel ou substituir credenciais.

A Eva deve listar 16 ferramentas e chamar `maintenance_capabilities`, `host_diagnostics`, `service_diagnostics` e `disk_space` com `host: raspberry`. Conferir `observed_at`, idade, cobertura e erros. Não executar operações de escrita apenas para comprovar que aparecem. As três capacidades de operação exigem uma proposta apropriada para testes adicionais.

Atualização realizada na configuração do plugin existente: 12 ferramentas de leitura e quatro de preparação/escrita. Autorização do servidor permanece `Nenhuma`, e o túnel existente foi preservado. A Eva confirmou as 16 ferramentas nesta conversa do dot e executou as seis leituras sequenciais; `disk_space` respondeu com `observed_at: 2026-10-19T13:27:09.815Z`, total 62.477.467.648 e disponível 26.244.005.888 bytes.

## Correção da coleta Docker

A coleta funcionava por SSH, mas falhava dentro do broker. Um teste isolado com a consulta completa e entrada por socket reproduziu `returncode: 2` e falha de criação de threads com `TasksMax=8`; sob as mesmas restrições, `TasksMax=32` retornou código zero e estado saudável do Home Assistant. Uma consulta simplificada anterior funcionou com ambos os limites, portanto não bastava para reproduzir a falha.

Foi aplicado somente `/etc/systemd/system/raspberry-mcp-operations@.service.d/80-diagnostics-task-budget.conf`, com `TasksMax=32`. O usuário executou o instalador preparado `fix-diagnostics-task-budget.py`, que exige três consultas reais bem-sucedidas pelo socket e reverte se alguma falhar. Não altera usuário, grupos, rede, memória, catálogo ou ações; não reinicia serviços. O override foi relido e túnel/socket seguem ativos. As unidades transitórias usadas na investigação foram coletadas e não permanecem ativas.

A Eva repetiu as três chamadas pelo plugin e confirmou `collection_error: null`, `age_seconds: 0`, contador de reinícios zero e ausência de OOM nos três serviços. Home Assistant foi observado às `2026-10-19T13:35:47 [228045 microssegundos]+00:00`, Node-RED às `2026-10-19T13:35:50 [628215 microssegundos]+00:00` e Mosquitto às `2026-10-19T13:35:56 [314395 microssegundos]+00:00`. Os dois primeiros retornaram `running/healthy`; Mosquitto retornou `running/none`, com estado `unknown`. Prontidão funcional continua `not_probed` nos três. Não houve HTTP 409 nessa repetição.

A indisponibilidade de throttling foi reproduzida fora do sandbox: `vcgencmd get_throttled` não consegue abrir `/dev/vcio_gencmd`. Esse dispositivo está com proprietário root e modo 0600; o broker usa usuário não privilegiado e PrivateDevices. Não foi ampliado o acesso a dispositivos nem alterado o sistema operacional para contornar essa limitação.

O caso de falha de coleta percorreu diagnóstico → reprodução isolada → correção do orçamento de tarefas → aplicação administrativa restrita → verificação pelo socket e pela Eva. A aplicação foi realizada pelo usuário com o instalador preparado, não por uma nova ferramenta de implantação da Eva. O ciclo autônomo de implantação por componente permanece pendente de projeto e aprovação de escopo.

## Próximas etapas e limites

Inventário de tarefas/dependências, logs paginados e sanitizados, diagnósticos de backups/atualizações, busca e diferenças de projeto, auditoria ampliada, persistência de validações e reconciliação após timeout ainda não foram entregues. Não há autorização implícita para novos deploys, reloads, updates, backups com publicação, restaurações ou mudanças de segurança.

Antes de habilitar cada operação de escrita nova, apresentar alvos, pré-condições, efeitos, timeout, sucesso e recuperação para aprovação. Um caso real seguro de implantação pode usar um componente inerte específico, após aprovação desse escopo. Não equiparar edição de arquivo ao controle efetivo de um serviço.

Observação externa é necessária para detectar queda total do Raspberry, mas nenhum observador externo foi provisionado nesta etapa.

Os valores entre colchetes são a fração de segundo em microssegundos dos horários imediatamente anteriores. Todos os dígitos originais foram preservados; não são coordenadas.
