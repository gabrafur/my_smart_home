# Continuidade, cadência e observação passiva

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Sexta captura fixa de continuidade

A programação de aceite acrescenta uma única captura somente de leitura às
20UTC de 26/10/2026, sem mudar o coletor, sua instrumentação ou os critérios.
Os cinco recibos anteriores permanecem imutáveis. `window-2000.json` também é
imutável: uma falha de coleta mantém `unknown` e não provoca repetição ou
fallback para sucesso antigo. O horário observado continua sendo o da coleta
real, inclusive em eventual catch-up tardio. Nenhuma autoridade foi renovada.

A auditoria da janela anterior separou os custos correlacionados das execuções
da cobertura temporal. CPU/RSS presentes para todas as execuções observadas
não eliminam um intervalo maior que 60 segundos entre inícios. Cadência dos
snapshots, parcialidade da amostra, custo, latências e PC desligado continuam
aceites separados. O resultado da nova captura precisa ser consultado pelo
MCP real; a programação não prova que a janela passou.


## Recuperação do snapshot básico após boot

Uma consulta real a `service_health` retornou `snapshot_unavailable`: o snapshot
compartilhado estava ausente, com timer ativo em `elapsed`, sem último disparo
nem próxima execução. A configuração efetiva continha somente a recorrência
relativa de 55 segundos. O reset da lista no override havia removido o disparo
de boot da unidade base. Essa evidência prova o mecanismo da falha observada,
sem datar o começo da lacuna histórica.

O [override canônico](../../../scripts/raspberry-mcp/collector-cadence/60-sampling.conf)
recoloca o disparo inicial depois do reset. Uma tarefa MCP nativa aplicou a
única linha adicional, preservando intervalo, precisão, atraso, produtor,
autenticação e limites existentes. Somente o timer foi parado e reativado;
o coletor publicou pelas ativações naturais. Nenhum snapshot foi fabricado
e nenhum serviço residencial foi reiniciado. A propriedade `TimersMonotonic`
pode aparecer várias vezes: preservar todos os valores ao interpretar a saída.

O [aceite sanitizado](../../../scripts/raspberry-mcp/basic-snapshot-cadence.acceptance.json)
registra snapshots naturais distintos e consultas reais bem-sucedidas aos
cinco diagnósticos. Saúde, versões e disco compartilham esse snapshot; as rotas
atuais de backups e logs usam fontes separadas. Não atribuir às duas últimas
uma falha anterior que não foi consultada.

O [procedimento de aplicação/reversão](../../../scripts/raspberry-mcp/collector-cadence/README.md)
preserva o override anterior e a história. A configuração antiga está guardada
para reversão, que não foi executada neste aceite. A cobertura é curta: não
comprova reboot do host, 24 horas ou execução natural da assistente.

## Contagem passiva de eventos e amostras

`maintenance_capabilities.evidence.data.host_observation.passive_timing` expõe
o resultado canônico do [grupo de medição no Node-RED](../../../nodered/tools/HOST_OBSERVER.md#medição-passiva-e-janela-de-cobertura).
Conta eventos e amostras saudáveis, além dos incidentes; sequências do produtor
permitem declarar registros ausentes sem transformar ausência em zero latência.
A projeção mantém limites, máximos conservadores, desconhecidos, épocas e
contadores anteriores, com até 25 âncoras horárias internas para a janela.
O campo `invalid_reason_history` conserva motivos canônicos após recuperação,
com contagens fechadas e até 16 observações recentes. Contagens antigas sem
motivo permanecem sem atribuição. A migração e a retomada após rollback não
reiniciam a janela nem deduzem causas retroativas. A projeção rejeita histórico
incoerente ou campos privados; não declara cobertura de 24h por esse histórico.
O [aceite dos motivos inválidos](../../../scripts/raspberry-mcp/passive-invalid-reasons.acceptance.json)
registra o replay nativo e a migração observada sem reiniciar a época.

O [aceite sanitizado](../../../scripts/raspberry-mcp/passive-host-timing.acceptance.json)
registra aplicação, reversão e reaplicação em três tarefas MCP seriais. Cada
fase confirmou sete passos nativos de dry-run, dedupe, limpeza e revogação da
sessão. Somente o observador passivo reiniciou; início dos sete serviços e
políticas residenciais foram preservados. O hash da fonte de projeção mudou
na política existente, sem ampliar acesso, dependências ou validade.

A chamada real posterior comprovou contadores de systemd e recursos na janela
curta. A reversão interrompeu a medição; a reaplicação abriu outra época e
preservou contadores anteriores. Consultas iniciais de status tiveram falhas
transitórias, mantidas nos recibos, sem repetição do efeito e sem RCA presumida.
O replay de medição usa relógio sintético separado; conflitos nos recibos de
notificação continuam explícitos. Não comprova 24h naturais, latência de Docker
sem ocorrências, fontes HA/MQTT, chegada de push, execução do cliente MCP autorizado ou restore.

Para outro servidor, seguir a [ordem compatível de atualização/reversão](../../../scripts/host-observation/README.md#testes-e-aceite),
revisar caminhos e allowlists e preparar novos hashes/IDs e autorização local.
Não copiar os selos, políticas privadas, operação consumida ou validade deste
host. O builtin `perf_hooks` reutiliza a configuração Function já existente;
não exige instalação npm ou mudança de segurança. O leitor continua fechado
no relatório protegido e acrescenta apenas a leitura do identificador público
do boot para verificar o relógio do próprio host.

## Margem da cadência e captura observacional posterior

O [timer do procmon](../../../scripts/raspberry-mcp/runtime-source/procmon-observability/raspberry-procmon.timer)
usa alvo nominal de 50s depois de uma violação medida com o alvo anterior de
55s; o aceite continua em 60s. Código, envelope e histórico foram preservados.
Uma tarefa MCP alterou somente o parâmetro do timer, com verificação de hash,
intent imutável e início dos sete serviços preservado. Amostras naturais
posteriores passaram no teste curto; a causa do atraso anterior continua
desconhecida. A margem nova não apaga a falha nem comprova 24h por configuração.

Outra tarefa MCP acrescentou 28/10/2026 às 10:00 UTC ao job de captura somente
de leitura. Mantém 27/10 às 23:00 UTC como próxima ativação e todas as datas e
recibos anteriores. Atualizou apenas a data fixa, a seleção correspondente e
hashes existentes de fonte/dependências, com reload sem reinícios. Nenhuma
captura foi antecipada; a validade administrativa permanece igual. A execução
observacional futura usa o escopo já existente e não admite reparos depois
de expirar a autorização administrativa.

O [runbook e os limites de retenção](../../../scripts/raspberry-mcp/procmon-observability/README.md#margem-do-timer-e-janela-posterior)
e o [aceite sanitizado](../../../scripts/raspberry-mcp/procmon-cadence-headroom.acceptance.json)
distinguem configuração ativa, janela curta e captura futura. Outro servidor
exige revisão do período, capacidade de retenção, datas e autorização local;
os selos e operações consumidos deste host não são transferíveis.
