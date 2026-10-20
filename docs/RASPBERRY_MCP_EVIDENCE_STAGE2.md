# Raspberry: projetos e serviços — evidências, contrato 1.1.0

## Entrega instalada

As 16 ferramentas e as quatro operações preexistentes foram preservadas. Esta atualização não habilita novas operações de escrita, não altera grupos, acesso a dispositivos, rede, credenciais, catálogo editável ou permissões do broker. O limite de tarefas já validado permanece 32.

`backup_results` agora consulta os resultados dos produtores Git e offsite, mantendo `data.git` e `data.offsite`. Acrescenta motivo sanitizado, código de saída, horários originais, idade, estado de pedido/processing, ID correlacionável derivado do pedido, observação dos locks e último sucesso Git verificável no trecho limitado do log. Registros antigos são classificados como stale. O próximo retry permanece desconhecido quando a agenda vigente não foi comprovada; o comentário do worker sobre execução por minuto não é tratado como prova da agenda.

O resultado Git mostrou `deferred`, `reason: maintenance_busy`, código 75. Há um pedido em processing com mtime de 19/10/2026 às 12:56:02 UTC. O último sucesso encontrado no log limitado foi em 19/10/2026 às 12:16:03 UTC, do tipo `no_changes`. Essa evidência não significa restauração comprovada nem novo envio de dados.

O antigo `unknown` do offsite era fixado no coletor anterior, que não consultava o resultado offsite. O produtor contém `failed`, código 1, encerrado em 15/10/2026 às 04:08:13 UTC. É um registro antigo, não uma falha recém-executada. O motivo específico da execução não está informado em campo aprovado. Não há evidência de integridade, cópia remota ou restauração nessa fonte; os campos ficam nulos com explicação. Nenhum manifesto privado, credencial ou arquivo de backup foi aberto.

`log_summary` mantém host/service obrigatórios e adiciona argumentos opcionais `window_minutes` (15, 60 ou 240), `window_end`, `offset` e `expected_digest`. Até 1.000 linhas/256 KiB por serviço, cinco grupos por página. Nas páginas seguintes, reutilizar a janela final e o digest anterior; se a fonte mudar, a chamada recusa a continuidade em vez de combinar páginas inconsistentes. Timestamps, categoria, componente aprovado, primeira/última ocorrência e contagem acompanham os trechos representativos.

As mensagens são projeções em formatos aprovados, não logs brutos com tentativa genérica de remover senhas. Exemplos observados: `Error fetching [alvo omitido]: Invalid response; Timeout`, `Unexpected exception`, `KeyError: [chave omitida]`. Valores privados, chaves de exceção, caminhos, URLs, nomes, calendários e identificadores não são copiados. Mensagens não reconhecidas são contabilizadas como omitidas, com horário e cobertura explícita. Isso limita a investigação; ampliar um padrão deve exigir revisão e teste de privacidade.

`host_diagnostics` agora explica o erro de throttling como indisponibilidade do dispositivo ao broker não privilegiado com PrivateDevices. Foi observado `/dev/vcio_gencmd` com root:root e modo 0600; não houve escalada de permissões.

O frontend adiciona `observed_at`, `age_seconds`, `source`, `collection_error` e `coverage` às respostas estruturadas bem-sucedidas. Os resultados individuais preservam sua própria origem e idade; a hora de resposta não substitui o horário do produtor. Erros de coleta em evidências filhas continuam explícitos. As operações antigas não ganharam garantia adicional de implantação por receber esse envelope.

## Arquivos e validação

Código aditivo em `/mnt/data/docker/scripts/raspberry-mcp/`: `maintenance_evidence.py`, `evidence-broker.py`, `evidence-server.mjs`, `install-evidence.py` e respectivos testes. Entradas instaladas por overrides `90-evidence.conf`; as versões anteriores foram preservadas. Instalador com hashes fixados, recusa de divergências, probe somente de leitura e rollback de seus próprios arquivos em caso de falha.

29 testes: 21 de evidências, cinco de preflight do instalador e três de protocolo. Cobrem dados privados sintéticos, mensagens não aprovadas, ausência de resultados, timestamps antigos, pedidos, sucesso verificável, paginação e rotação, timeout com encerramento do processo, limites de saída e preservação dos nomes/argumentos existentes. Testes em WSL e no Raspberry com execução sequencial protegida. Não executam backup, atualização, automação ou notificação real.

O plugin existente foi atualizado pela interface autenticada. A Eva confirmou o critério mínimo com chamadas reais nesta conversa do dot, sem repetir a coleta Docker já aprovada:

- Backups observados às `2026-10-19T13:51:30 [063719 microssegundos]+00:00`: Git deferred por maintenance_busy; offsite failed antigo, com origem do unknown anterior explicitada.
- Logs: três páginas (offsets 0, 5 e 10), com a mesma janela `12:51:31 [610127 microssegundos]–13:51:31 [610127 microssegundos] UTC` e digest. Última página sem continuação, 12 grupos, 493 linhas amostradas, sem truncamento.
- Trechos reconhecidos: um timeout IPP; sete Unexpected exception do WebSocket; sete KeyError; oito avisos de integração customizada; dois registros de encerramento incompleto do Recorder; um valor enum inválido. Grupos distintos não foram tratados como incidentes automaticamente correlacionados.
- Seis grupos permanecem com texto omitido por falta de padrão aprovado; sua existência, recorrência e horários ficam visíveis.
- Throttling observado às `2026-10-19T13:51:34 [579846 microssegundos]+00:00`, unknown com causa específica de indisponibilidade ao broker isolado.
- Nenhum HTTP 409 ocorreu nessas chamadas da Eva; isso não encerra a investigação de sessões.

A Eva confirmou que recebeu o motivo do deferred, a origem do antigo unknown e mensagens sanitizadas dos erros. Também destacou que ainda faltam a manutenção responsável pelo lock histórico e a causa específica da falha offsite antiga; nenhuma correção operacional foi aplicada com base em inferência.

## Sessões e HTTP 409

A documentação oficial atribui `mcp_initialization_required` à chamada stdio que chega antes da inicialização e da notificação correspondente. O guard rejeita antes de encaminhar ao servidor; a recuperação pertence ao cliente. O shim opcional não foi habilitado sem evidência de que o chamador omite a notificação. Referência: [configuração oficial do tunnel-client](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md).

Nesta rodada, uma primeira dupla concorrente apresentou erro em `disk_space`, sem classificação capturada no resumo do ensaio. Não é possível atribuí-lo a HTTP 409. Uma chamada sequencial e uma segunda dupla concorrente responderam normalmente. Isso não encerra a investigação. Expiração de sessão e reprodução instrumentada do guard continuam pendentes; nenhuma repetição bem-sucedida foi apresentada como correção.

## Lacunas que permanecem

- Causa operacional exata do lock ocupado no instante do adiamento: a observação posterior de um lock livre não contradiz o evento anterior e não identifica seu detentor histórico.
- Motivo da falha antiga offsite e histórico de sucessos/restauração não presentes nas fontes permitidas.
- Inventário completo de agendas e próximas execuções, tendências persistidas e estado detalhado de atualizações.
- Catálogo de fontes de manutenção, validações isoladas por componente, prontidão funcional e ferramentas novas de implantação/reload/manutenção de backups.
- Auditoria persistida e reconciliação completa de ações cujo resultado seja desconhecido.

Nenhuma dessas lacunas autoriza automaticamente novos acessos ou ações. A edição de fonte, sintaxe aprovada, aplicação administrativa e comportamento verificado continuam estados distintos.

Os valores entre colchetes são a fração de segundo em microssegundos dos horários imediatamente anteriores. Todos os dígitos originais foram preservados; não são coordenadas.
