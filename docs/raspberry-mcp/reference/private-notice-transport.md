# Transporte de incidentes técnicos privados

O canvas `observacao_host` classifica explicitamente cinco incidentes técnicos
para o operador: monitor de processos, coleta MCP, heartbeat externo, bridge
e leitura do relatório do host. Demais incidentes preservam seus destinos.
Não se deduz audiência privada de `mobile_notification=false`, que também pode
representar recuperação ou condição esperada de outro domínio.

A classificação segue ao monitor global. Produção gera uma revisão fechada na
outbox de `/data`; um consumidor host, sem rede nem acesso a dispositivos,
transporta essa revisão para a fila privada existente. Em `exclusive`, o aviso não é criado no Home Assistant nem enviado ao celular;
`shadow` conserva a fonte HA anterior até a prova substituta. O teste sintético
normal termina no dry-run compartilhado antes da escrita da outbox. A exceção
explícita de entrega privada descrita abaixo tem identidade própria.

## Decisões visíveis e comunicação com o proprietário

O grupo Eva do canvas contém parâmetros validados; valores inválidos preservam
a última política válida:

| Parâmetro | Padrão | Limites | Finalidade |
| --- | --- | --- | --- |
| `delivery_mode` | `shadow` | `shadow` / `exclusive` | Manter fonte anterior até prova da substituição |
| `owner_escalation_ms` | 86.400.000 ms | 3.600.000–604.800.000 ms | Comunicar incidente ainda sem solução |
| `transport_confirm_ms` | 120.000 ms | 30.000–600.000 ms | Confirmar ausência de recibo do transporte |
| `audit_retention_days` | 30 dias | 7–90 dias | Retenção dos recibos detalhados concluídos |

A cada minuto o Node-RED reavalia seus incidentes privados; o switch visual de
prazo autoriza a comunicação ao proprietário. Uma intenção durável por incidente
impede duplicação após reinício. Recuperação remove o lifecycle do incidente.
Esse registro é intenção, não confirmação de entrega: recibos dos hubs continuam
necessários para afirmar que o aviso foi aceito ou entregue.

O monitor confere revisão e recibo a cada 30 segundos. Pendência além do limite
gera alerta de domínio ao proprietário, fora da própria rota privada. Quando o
recibo exato aparece, o incidente é encerrado e o aviso sai do Home Assistant
(dismiss pelo observador global, sem novo aviso no celular). Erro real de leitura/escrita usa a rota
interna do monitor, com dedupe e proteção contra recursão. Ausência de ack nunca
autoriza repetir um reparo: observar a operação existente.

## Identidade, custódia e recuperação

O nome do arquivo privado deriva do papel lógico, com prefixo `eva_private_`.
O coletor contém cinco aliases fixos e atestados: converte esse nome no mesmo
identificador canônico anterior do Home Assistant. O hash `object_id` não muda;
incidentes, tarefas e histórico mantêm a referência original. Nenhum alias livre
fornecido pelo produtor é aceito. A revisão vincula papel, sequência, antecessor,
conteúdo exato e horário de entrada da revisão na fila.

Inicialmente `shadow` preserva a fonte HA e produz a cópia privada. Um produtor pode marcar `payload.shadow_fallback=false` para dispensar essa cópia HA: o canvas `observacao_host` faz isso para todos os seus incidentes (containers, serviços, recursos e observação), que por decisão do proprietário são diagnóstico só para a Eva. Reinício planejado de um container não chega ao celular nem ao HA, e nem vira incidente: parada (`die`/`destroy` sem `start` posterior) só é confirmada após `stop_confirm_ms` (5 min), salvo loop de quedas (`crash_loop_stops`=3 em `crash_loop_window_ms`=15 min), que mantém a confirmação curta de evento; escalonamento após o prazo continua chegando ao proprietário. O coletor
prioriza o conteúdo privado para o mesmo ID canônico e ignora atualizações ou
remoções concorrentes da fonte HA enquanto o alias estiver sob sua custódia.
Após comprovar pela sessão do assistente o mesmo `object_id`, revisão/conteúdo
e recibos independentes, a mudança explícita para `exclusive` retira a rota de
produção HA. Só então retirar os avisos HA legados pelo mecanismo autorizado.

Recuperação grava um tombstone durável no spool: representa remoção do incidente,
mas conserva a custódia do alias. Assim um snapshot HA antigo não ressuscita o
incidente após reconexão ou reinício. O tombstone não é apresentado como aviso.
Se o spool inicial não puder ser lido, a conexão recusa a projeção em vez de
interpretar ausência como recuperação. Inversão explícita pode liberar a custódia
e restaurar a fonte anterior.

Node-RED escreve somente sua outbox. O consumidor lê cinco papéis de incidentes e um papel fechado de teste e escreve
somente recibos, ledger e fila privada. Diretórios e arquivos têm dono/grupo
fixos; links e permissões abertas são recusados. O contêiner usa o volume `/data`
existente: instalar o transporte não requer alteração da rede nem recriação.

O consumidor grava intent antes do efeito. Se interrompido, aceita como já
aplicado somente o conteúdo exato desse intent; divergência de bytes exige
investigação. O ack só aparece depois de verificar o arquivo no spool. O ack
prova transporte local, não execução ou reconhecimento do assistente.

A outbox preserva até 64 revisões pendentes por papel. Compactação só alcança
revisões com ack correspondente. O ledger retém recibos concluídos dentro do
prazo explícito enviado pelo produtor; expiração mantém contagem e digest
encadeado dos registros retirados. Nunca expira intent pendente. O limite de
8.192 recibos detalhados falha fechado, sem descartar entradas ainda retidas.

A última escrita de cada papel guarda sua própria inversa. Revogar o transporte
e aplicar a inversa exige revisão exata e CAS do conteúdo atual. A inversão
revoga novos efeitos; recuperação da mesma inversão interrompida é idempotente.
Não remover avisos para simular recuperação, nem apagar ledger/recibos durante
rollback.

## Testes e instalação

Sequência manual no canvas: reset → novo → tick (não escala) → vencer → tick
(escala em dry-run) → tick (dedupe) → recuperar. O estado de teste é separado do
persistente de produção. Testes automatizados cobrem roteamento privado,
escalonamento, reinício, recuperação, falha do transporte e dedupe.

A instalação deve usar o operador fixo revisado, com manifestos, beforeimages,
CAS e recibos. Revalidar os bytes atuais e a custódia; manter confirmações
obrigatórias da interface para o deploy Node-RED. Instalar a ponte primeiro,
verificar o serviço/path e só então publicar o produtor. Comprovar o novo
aviso pela sessão do assistente e por recibo independente antes de retirar o
aviso legado. Reversão preserva outbox e ledger e restaura apenas alterações
próprias. O serviço pode ser iniciado explicitamente para recuperar o mesmo
intent; isso não cria nova operação residencial.

## Prova real de transporte privado

O grupo de entrega privada oferece dois controles explícitos, sem agenda:
`host_obs_eva_delivery_create` e `host_obs_eva_delivery_cleanup`. O primeiro
produz um aviso com título e mensagem `TESTE`, contrato
`notification_delivery_under_test` e identidade `eva_private_delivery_test`.
Esse papel não tem alias de incidente real e jamais entra no registry dos cinco
incidentes. O guard envia somente à outbox, inclusive em modo shadow: nenhuma
saída Home Assistant ou móvel é acionada para esse teste.

O estado persistente próprio passa create_pending → active pelo recibo exato do
consumidor. Repetir um pedido pendente preserva conteúdo e revisão. Active não
reenvia. A leitura e o reconhecimento reais pela sessão do assistente são provas
separadas; o recibo de transporte não substitui essas provas. Só depois delas
acionar cleanup: o consumidor retira exclusivamente o spool de teste e preserva
auditoria, recibos e tombstones reais. A conclusão cleanup_pending → complete
exige revisão cujo antecessor coincide com a criação aceita. Reinício conserva
identidade e estado; uma operação incerta deve ser consultada, não recriada.

Esta prova exercita produtor, guard, outbox, consumidor e assistente sem inventar
uma falha residencial. Ela comprova transporte real; observação natural e
associação das cinco famílias continuam sendo evidências distintas.
