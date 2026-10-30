# Protocolo e conclusão do transporte Events

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Contrato de payload dos resumos Events

`events/list` anuncia `smart_home.observation` com duas alternativas fechadas:
o evento individual legado e `notification_summary_v1`. O schema completo
está em `scripts/raspberry-mcp/runtime-source/frontend/events-server.mjs`,
exportado como `eventPayloadSchema`. `inputSchema`, identidade autenticada,
assinatura, transporte e intervalo de 600s permanecem; o limite local atual
é de 144 tentativas/24h pela cadência `grouped_minimum_spacing_v2`.

O resumo contém `project`, `topic`, `source`, `delivery_kind`,
`source_observed_at`, `summary_as_of`, `notifications`, `covered_event_records`,
`remaining_notification_groups`, `recovery_proven`, `assistant_execution` e
`history_semantics`. Cada grupo contém hash opaco, estado/revisão atuais, última
fase conhecida, ambiguidade histórica, primeiro/último horário, contagens por
fase, prévia limitada de transições e quantidade omitida. Até oito grupos e
256 registros; nenhum título, mensagem, credencial ou localização nesse payload.
Remoção mantém recuperação não comprovada; execução continua desconhecida.

O cliente chama `events_status` com `{"host":"raspberry"}` e consulta
`frontend_payload_contract`: versão, hash SHA256 do schema e variantes
carregadas no frontend que respondeu. Essa informação não comprova atualização
do cache de outro cliente, entrega do webhook ou execução do assistente. Um
cliente novo deve redescobrir Events; não criar assinatura adicional nem trocar
IDs ou chave para tentar resolver cache. Preservar a assinatura existente.

Quando o catálogo ou `payloadSchema` mudar, execute **Rescan** do servidor na
página do plugin no ChatGPT e confira o evento anunciado. Reconectar o frontend
carrega seus módulos locais; isso não comprova que o catálogo remoto foi
reexaminado. A [documentação oficial de MCP Events](https://developers.openai.com/plugins/build/mcp-events)
separa descoberta, assinatura, aceite HTTP e resposta do assistente, e exige
Rescan após mudanças em ferramentas ou eventos.

Diagnostique os trechos separadamente: valide o envelope persistido e seu
`data` contra o schema anunciado; confira o catálogo do plugin e a tarefa no
destino; depois correlacione evento, execução e resultado reais. `2xx` confirma
somente o recebimento do webhook, processado assincronamente pelo ChatGPT.
`assistant_run_confirmed=false` informa ausência de recibo de execução neste
servidor, não uma resposta de falha emitida pela plataforma. Permissão para
usar ferramentas também não comprova que a tarefa de evento está ativa.
Não use ausência de linhas em um journal indisponível ou truncado como prova
de que a descoberta ou execução não aconteceu. Preserve o limite derivado de
144 tentativas/24h, o intervalo de 600s, IDs e resultados incertos durante essa
conferência.

Uma entrega agrupada natural foi observada no MCP e no ledger: há batch e
vínculos duráveis dos eventos cobertos, com webhook aceito. O contrato antigo
ainda anunciado aceitava apenas evento individual; a regressão reproduz essa
incompatibilidade sem atribuir a ela uma rejeição da plataforma não observada.
O schema corrigido aceita os dois formatos. Aceite continua sem prova de cliente MCP autorizado.

Testes públicos usam o produtor Python puro e Ajv fixado no lockfile de
`validation`; `make validate-dependencies` instala as dependências de teste,
sem scripts npm. Não precisa de Ajv no daemon de produção. Execute
`node --test --test-concurrency=1 scripts/raspberry-mcp/event-payload-contract.test.mjs`.
Os testes não usam o PC, callback, assinatura, dispositivos ou credenciais.

Para atualizar esse frontend privilegiado, conferir a cadeia de hashes das
políticas task-control e repair-control. Mudam somente o pin do frontend e o
pin transitivo da política; orçamento, prazo e aprovação não são renovados.
Recarregar apenas a conexão existente do MCP. Reversão exige comparação das
bases e preserva todos os dados/intents/membros de Events, inclusive incertos.
Nunca repetir uma entrega para testar o schema ou comprovar consumo externo.

## Conclusão durável do transporte Events

`events_status.webhook_transport_timing` expõe duração monotônica da chamada
ao sender e horário civil de conclusão. A tabela adicional não modifica as
quatro colunas originais de dispatch, IDs, assinatura ou orçamento. Só registra
observação para um intent existente, uma vez; falha na observação não libera
reenvio. Registros sem observação continuam desconhecidos, com horários nulos.
A duração exclui fila e persistência, e não mede decisão ou execução do cliente MCP autorizado.

O [aceite sanitizado](../../../scripts/raspberry-mcp/event-transport-timing.acceptance.json)
registra uma medição natural, 19 conclusões históricas desconhecidas e a
preservação dessa medição através de reversão/reaplicação pelo MCP real. O
primeiro helper terminou sem confirmação porque sua fotografia antecedeu a
criação da tabela; a observação posterior reconciliou o efeito sem repeti-lo.
O estado ativo do systemd exige uma barreira adicional de prontidão do worker.
Uma recusa posterior de reaplicação ocorreu antes de intent porque o verificador
exigia um campo ausente no recibo anterior; a correção vincula o hash exato do
recibo ao intent original, preservando ambos. Somente após provar a ausência
de efeito foi usado um envio novo. Nenhum evento artificial foi gerado.

Essa reversão é compatível com a base imediata que já suporta resumos e membros.
Código anterior ao suporte a resumos continua exigindo Events parado e revisão
específica antes da retomada, para evitar replay. Limites, validade e acesso
permanecem os existentes. Entrega aceita ainda exige prova própria de execução
do assistente; a medição de transporte não conclui a meta de latência ponta a
ponta nem a cobertura de 24 horas.
