# Segurança e dados locais

- Nunca versione credenciais, tokens, coordenadas, chaves, registros de
  dispositivos, bancos ou outros dados de runtime. `.gitignore` e os guias de
  instalação e segurança são a fonte de verdade.
- Use arquivos privados documentados em vez de inserir segredos em código,
  flows, documentação ou memória. Nunca imprima valores de credenciais.
- Autorizações de conversas anteriores não substituem confirmação para ações
  sensíveis, destrutivas, externas ou irreversíveis.

<!-- memory-record {"id":"raspberry-mcp-fronteira-de-leitura","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-25","evidence":[{"file":"scripts/raspberry-mcp/core.mjs","sha256":"f3e476b7e4027c68b4e987d12798c93714033e34e46fa33d2dfe13c9863f69d2"},{"file":"scripts/raspberry-mcp/server.mjs","sha256":"1b69e9269cddc289979aabf954a2f8ad5b6b2a2419b42b844df6d72a254fb30c"},{"file":"scripts/raspberry-mcp/install-local.py","sha256":"f259e148d218bf21401025cf40d4b7ec6d8f2a6589dfeb1f992a866e25b7f8cc"},{"file":"docs/RASPBERRY_READONLY_MCP.md","sha256":"6083b6f86422165e2bc06190e71d99b1a403fc9e912782a9f815c1b913652326"}]} -->
## Fronteira da base de leitura do MCP Raspberry

A base original de scripts/raspberry-mcp/core.mjs e server.mjs separa coleta local e atendimento stdio e define cinco leituras de snapshot sanitizado. Esse contrato histórico não representa sozinho o catálogo das camadas posteriores de manutenção e tarefas. Consulte tools/list e maintenance_capabilities na integração ativa para conhecer interfaces, limites e autorização realmente disponíveis. O instalador administrativo install-local.py prepara isolamento e socket Unix sem configurar túnel ou credenciais; não deve ser reaplicado sobre uma instalação existente. O relay tem destino fixo. docs/RASPBERRY_READONLY_MCP.md documenta a base e ampliações; instalação, catálogo do cliente e execução real exigem evidências distintas. Acesso remoto do Codex não comprova disponibilidade na conversa de outro chatbot.

<!-- /memory-record -->

<!-- memory-record {"id":"procmon-modo-atomico-e-evidencia-interrompida","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-26","evidence":[{"file":"scripts/raspberry-mcp/procmon-observability/README.md","sha256":"d7f097b1ee3f827b71338e4cf047c277d6b95497c1232e5bdfbeb66596c302f4"},{"file":"scripts/raspberry-mcp/runtime-source/procmon-observability/observed_collector.py","sha256":"ed57092bac9d87e6f78964f904bca4dc9caff71389a2d1956e1ecdfa24e9ca53"},{"file":"scripts/raspberry-mcp/procmon-observability/test_atomic_mode.py","sha256":"baee47a64490ffad5a0416c426c8dece95ec5e651ecebf8eb01b4ce5780c53a0"},{"file":"scripts/raspberry-mcp/procmon-observability/invocation_audit.py","sha256":"40731a78e5d3876113a3124946e09b108604546f0bef87e508b1179e018fc783"},{"file":"scripts/raspberry-mcp/procmon-observability/test_signal_io.py","sha256":"03271049fb61115fa03674baa4bc7736ca7d31a2e3633d0fd2b1258924d347a2"},{"file":"scripts/host-observation/test_accounting.py","sha256":"0b0365c3d6980b8fb73dd8627b3486d79e616f954d19bd5799002e756831c418"}]} -->
## Modo atômico e preservação da coleta interrompida

Na instrumentação do procmon, o arquivo público deve nascer com o modo exigido pelo próprio coletor: uma interrupção antes do fchmod pode deixar um temporário vazio que o gate estrito corretamente rejeita. O wrapper ajusta apenas o umask durante a chamada atômica e o restaura; não modifica o coletor original nem relaxa modos, limites de CPU/memória ou gates. Recuperação administrativa confirma identidade e preserva o temporário intacto em quarentena, sem promovê-lo a amostra. Retorno de ciclos naturais não preenche lacunas históricas nem comprova continuidade de 24h. A regressão isolada prova a janela de criação, não o sinal ou caller histórico.

Conclusão de invocação e amostra durável são evidências distintas: publicação pode falhar depois da gravação da amostra. Correlacione início, fim e telemetria por boot e invocação; ausência de telemetria não implica custo zero. Distinga CPU desde o observador, CPU do processo até a emissão e CPU da unidade inteira. Memória sem contador continua desconhecida. Adaptadores de sinais e fsync preservam handlers, agenda e limites de CPU/memória. O envelope de parede para I/O pertence explicitamente ao wrapper: rearma o alarme após os limites originais, sem retry nem redução de durabilidade. Alteração de orçamento exige telemetria e ciclos naturais; não equivale a recuperar a cadência. Aumentar frequência exige verificar retenção antes.

<!-- /memory-record -->

<!-- memory-record {"id":"mcp-observacao-e-contagem-nao-provam-execucao","category":"ARCHITECTURE","kind":"VERIFIED_FACT","last_verified":"2026-10-26","evidence":[{"file":"docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md","sha256":"e8d951d4053ca7f7ea3b9273783ded1057ce6d97f9f4de9f29279ecad83352b8"},{"file":"scripts/raspberry-mcp/runtime-source/repair-control/health_summary.py","sha256":"90782c07c2d19d38e46df9877236f9fbaed4953855a5a671d0e4d8d9c3f154a9"},{"file":"scripts/raspberry-mcp/runtime-source/native-events/registry.py","sha256":"e12cedbbb5370be4faf63788f22b7528727b862b8b213441c27b5f8d5ce73df7"},{"file":"scripts/raspberry-mcp/event-delivery-health.test.mjs","sha256":"77e02abe62408a822f6309c788e05b0ed0ef943d41489a625a256af66e5e7d9e"},{"file":"scripts/raspberry-mcp/runtime-source/ha-notices/notification_reader.py","sha256":"4cd5dd21a76e17c902aa3c1a6d7bcb97a764aa348628db9f36c2e102ef8dc147"},{"file":"scripts/raspberry-mcp/runtime-source/ha-notices/content_sanitizer.cjs","sha256":"e9cd563639916e442dc8ba430f79bb5ce1835a40927936ac38389f46b1c3820a"},{"file":"scripts/raspberry-mcp/runtime-source/frontend/repair-server.mjs","sha256":"9884a6ca3f25f3089bbcd894657d512573703e3265e82c62b730d51890f71292"},{"file":"scripts/raspberry-mcp/runtime-source/native-events/delivery_summary.py","sha256":"f73291ae36821e27db087df38f71d727648c4838f2df793949d55e914ae1c7b0"},{"file":"scripts/raspberry-mcp/runtime-source/frontend/events-server.mjs","sha256":"a58dbf0d07feb95efe7b2d8f19bd4e42da75a75c32bed50728ae16059afd68ed"},{"file":"scripts/raspberry-mcp/runtime-source/offsite-integrity/verify.py","sha256":"c5b14b5d86c9e06d3918b565ea2e2cc1a1e3d6fef76a1a7fa64ca4b795aa5c53"},{"file":"scripts/raspberry-mcp/component-repair-candidate/heartbeat_effect.py","sha256":"8b3fc3e1279c02eeab96f9c1e993719849a04d7820364a9918b1a67ac625b418"},{"file":"scripts/raspberry-mcp/component-repair-candidate/test_heartbeat_effect.py","sha256":"b9e990465d6ca8020d8b862e10739b989026fa60371fb8f090e7ee0ed64bb904"},{"file":"scripts/raspberry-mcp/runtime-source/ha-notices/diagnostic_templates.json","sha256":"db852e558f2c1546d277041a29443d634c109761d91c2c7cb5785d96382cc1fa"},{"file":"scripts/raspberry-mcp/component-repair-candidate/heartbeat_observer.py","sha256":"625bfcb387080e3a9e3bda6f28cbe5f4839450179724e6b55800a3683197f1d2"},{"file":"scripts/raspberry-mcp/icloud-readiness-candidate/operator_workspace.py","sha256":"8f33313e9ec3c0eb20d5c3554fc05202a062c00381ef53b3cfeee98eff1e332e"},{"file":"scripts/raspberry-mcp/icloud-readiness-candidate/test_operator_workspace.py","sha256":"99d6e17d7103b3f3cb78e1ff25d661286776cc9139ad8dcd89b64e7286c31b4f"},{"file":"scripts/raspberry-mcp/icloud-readiness-candidate/README.md","sha256":"acc5dca79628cad6bc2db3c5ae03765bf03e850a3a2771e18e598467970d316f"}]} -->
## Observação MCP, conteúdo e execução são evidências distintas

As projeções do MCP usam arquivos fixos protegidos, com owner/modo/limite e schema; state observed descreve disponibilidade da observação, sem provar saúde global ou autoridade. Contexto da aplicação não é aprovação administrativa. O resumo sanitizado da coordenadora exposto por maintenance_capabilities tem validade de cinco minutos e informa trabalho declarado; quando stale mantém reservas sem liberar trabalho, e não autoriza envio nem comprova execução. Registros retidos de Events incluem eventos já enviados; pendência elegível usa o mesmo principal ativo, tópico, janela e início da assinatura do dispatcher. Qualquer intent existente exclui o evento, inclusive resultado incerto, sem virar retry. Respostas antigas com apenas o total mantêm pendência desconhecida. Orçamento disponível, callback aceito, entrega ao destino e execução do assistente continuam provas separadas. Consultas de contagem não podem apagar histórico nem alterar assinatura, IDs ou limites.

ha_notifications reconstrói cláusulas diagnósticas de um vocabulário revisado antes de persistir ou exportar conteúdo. Categorias e revisões legadas de Events permanecem estáveis; o conteúdo diagnóstico é um contrato separado. Erros associados exigem o mesmo ID canônico, horário e stack limitada; associação não prova o disparo original nem recuperação. Código desconhecido e coleta falha mantêm incerteza explícita. Catálogo MCP padrão atualizado pode aceitar argumentos que um cliente com cache ainda descarta: validar o resultado e o query_kind da chamada real, não só o descritor.

Entrega agrupada preserva eventos e membros sob intent atômico antes da rede; nenhum membro de tentativa incerta pode ser reenviado em outro resumo. Agregados de fila, arquivo e próximo slot não provam entrega nem execução. Import ESM de frontend persistente pode continuar antigo após atualizar o arquivo: validar o resultado MCP real e, quando necessário, reconectar o transporte existente sem trocar autenticação/assinatura. Teste de import isolado não prova versão carregada na conexão ativa.


O contrato Events deve validar a saída do produtor real: um resumo agregado
não satisfaz o schema fechado de um evento individual. Aceite do webhook não
prova validação desse schema nem consumo pela Eva. Conferir as duas variantes
anunciadas e o hash do contrato carregado; cache remoto continua desconhecido
sem evidência própria. Não reenviar membros de uma entrega para testar cache.

Autenticação de backup deve testar o caminho create/start/stdin inteiro.
Habilitar stdin no create e verificar Tty=false antes de pedir a chave; teste
direto da função ou docker run não cobre o mesmo caminho. Erro de entrada antes
da leitura do ciphertext não prova corrupção ou chave inválida. Preservar o
recibo falho e os limites; reconciliação específica não troca IDs nem apaga
intents e continua bloqueada para efeito incerto.

Worker candidato e código carregado também são evidências distintas: journal de
escrita atômica preserva intent e backup, e reconciliação exige fonte e nova
invocação nativa sem repetir escrita. Hash compilado sem executar a proposta
não substitui revisão, binding protegido ou prova funcional do destino.

HomeAssistantError com Service not available não identifica sozinho serviço
ausente no registro do HA. Preserve origem desconhecida e diferencie catálogo
recebido, disponibilidade do handler e dependência remota; entry ready não
comprova o sucesso funcional da chamada.

Probes de registro consultam somente presença do serviço fixo, sem executar o
handler. Falha posterior torna o estado atual unknown e mantém o último sucesso
como histórico. Revogação em /run precisa de marcador persistente e recriação
do link no boot; perda de /run não pode liberar um escopo revogado. Preparação
de pacotes privados recusa qualquer ancestral .git, inclusive worktrees;
modo 0700 sozinho não impede publicação acidental em outro checkout.

<!-- /memory-record -->

<!-- memory-record {"id":"mcp-nodered-fonte-carregada-sanitizada","category":"OPERATING_PROCEDURE","kind":"PROJECT_DECISION","last_verified":"2026-10-26","evidence":[{"file":"scripts/raspberry-mcp/nodered-readonly-candidate/nodered_model.cjs","sha256":"d79d65245efc3800e8ec8c553db1344648e9832efe6507f499ecce0a48228082"},{"file":"scripts/raspberry-mcp/nodered-readonly-candidate/runtime_client.py","sha256":"e10e3cfb521d715755cb357f0b5a51963370324fb1a562a9c9958f626b7168cc"},{"file":"scripts/raspberry-mcp/nodered-readonly-candidate/kia_model.cjs","sha256":"bd3da3d64dc616ab7ec61446d9c8cead1c7f754c2c1bf6514a3d0ecb0b6bccd2"},{"file":"scripts/raspberry-mcp/nodered-readonly-candidate/README.md","sha256":"19d8ad4c644bfa3d7384311dafe5a43e7285da707eb7e9da1ecf954755b02dd4"},{"file":"scripts/raspberry-mcp/runtime-source/administrative-recovery/apply_kia_promotion_evidence.py","sha256":"1c542c255bac9658a8ce60b80aeec4ee5197853a49a022eb1e1bcb3dc4836c3a"},{"file":"scripts/raspberry-mcp/nodered-readonly-candidate/test_kia_deployment.py","sha256":"f86c73c034ea5705da147fe9b2124bff52392ef08ce1195302a8105603bbf497"}]} -->
## Diagnóstico carregado Node-RED com conteúdo revisado

O MCP descobre todos os fluxos e nós necessários pelo inventário carregado e usa IDs opacos para conexões, parâmetros e fonte sanitizada. Conteúdo exige correspondência com commit público aprovado; drift privado fica retido com motivo, sem hash de valores privados. Seguir next_offset até reconstruir o JSON, depois resources/next_page. Cache perdido ou expirado exige redescoberta; não inventar caminhos ou interpretar indisponibilidade como remoção. Leitura é separada de preparação, implantação controlada e prova funcional. O diagnóstico Kia preserva falha antiga ao lado do audit posterior, mantém reason_code desconhecido quando ausente e não prova o ciclo pelo último mtime ou versão.

Aplicação administrativa pelo perfil existente exige pacote fixo selado e validação da tarefa/envio admitidos, sem dispensar qualquer outra pendência ou editar ledgers. A exceção do próprio envio é delimitada pelo manifesto e não cria identidade criptográfica por conversa. Conferir hashes e leitura MCP nova entre aplicação, reversão e estado final; campos de diagnóstico não comprovam recuperação funcional. Efeito incerto exige reconciliação antes de repetir fase.

<!-- /memory-record -->

<!-- memory-record {"id":"icloud-contrato-carregado-sem-chamada-diagnostica","category":"OPERATING_PROCEDURE","kind":"PROJECT_DECISION","last_verified":"2026-10-26","evidence":[{"file":"homeassistant/custom_components/icloud/loaded_contract.py","sha256":"1df61757cd4f8be0a3a852af6783724f2e831b1c1cb82c4830fe1a51561e4f36"},{"file":"scripts/raspberry-mcp/loaded-contract-candidate/test_observation_freshness.py","sha256":"bd6450fca98a5cf9febcb1ea27d153f26d8b39703c97e729b7106486f8bdc687"},{"file":"scripts/raspberry-mcp/loaded-contract-candidate/test_client_contract.py","sha256":"20d9c749fa9b646e1255efd4b925240ff55572816347105d7187a1501da5aae5"},{"file":"scripts/raspberry-mcp/loaded-contract-candidate/README.md","sha256":"59b9e8d793475cd935003c59f5042add09d2480b0b47e72277af37c8b1c2d7ef"}]} -->
## Contrato iCloud carregado sem chamada ao provedor

O diagnóstico usa prova nativa, nonce e hashes de código/setup para publicar booleanos dos dois papéis lógicos e a última etapa natural allowlisted. A coleta não chama o handler nem propriedades do provedor e preserva o horário observado antes de publicação assíncrona. Binding, API presente e serviço registrado não comprovam saúde Apple. Tentativa concluída é histórica; prova antiga, extra privada ou schema inválido mantém unknown. entry_waiting_user requer reautenticação manual na interface HA, preservando a política de OTP somente manual e sem senha ou código no chat.

<!-- /memory-record -->
