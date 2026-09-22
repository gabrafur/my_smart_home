# Retomada dos fluxos após falta de energia

O tab `retomada_servicos` publica a autorização canônica para retomar tarefas
externas. Internet e VPN continuam sendo avaliadas pelos monitores existentes;
o coordenador consome seus estados, sem repetir pings, sondar peers ou tentar
reiniciar a rede. Portão, alarme, iluminação, resfriamento, armazenamento,
watchdogs e os próprios monitores de internet/VPN continuam independentes.

## Política visível

| Parâmetro | Padrão | Limites | Finalidade |
| --- | --- | --- | --- |
| `boot_grace_s` | 180 s | 30–900 s | Tempo mínimo desde o início do coordenador |
| `connection_stable_s` | 120 s | 30–600 s | Internet e VPN continuamente `online` |
| `source_fresh_s` | 120 s | 60–600 s | Validade da publicação dos monitores |
| `release_spacing_s` | 10 s | 1–60 s | Espaçamento entre classes de tarefa na retomada |
| `pending_ttl_s` | 1.800 s | 60–3.600 s | Validade máxima de uma intenção pendente |

Valores inválidos preservam a última política válida. A contagem usa o uptime
monotônico do sistema, pelo módulo nativo `os`, para que o ajuste do relógio
após ligar não elimine a espera. O estado inicial é `waiting_internet` ou
`waiting_vpn`; ambas online iniciam `stabilizing`; os dois prazos cumpridos
produzem `ready`. Nova queda ou fonte sem publicação atual reinicia a espera.
`unknown`, `checking`, `recovering` e mensagens retained não autorizam retomada.
A perda/reconexão MQTT invalida as observações anteriores.

O monitor de internet publica conexão, atributos e classificação a cada ciclo.
As três mensagens usam a mesma saída do nó Function; a regressão percorre essa
saída até o terminal dry-run, evitando que somente a primeira seja entregue.

O contrato fica em `global.startup_readiness_v1`, no store `memoryOnly`, e no
tópico diagnóstico MQTT “nodered/infrastructure/startup/state”. Nenhum consumidor
reconstrói os critérios de saúde da internet ou da VPN. O coordenador não muda
Docker, agendas do host ou serviços de rede.

## Tarefas que aguardam

O inventário executável é `STARTUP_GUARDS`, em
`nodered/tools/install-startup-readiness.mjs`:

- inventário periódico e agenda de updates;
- agenda de revisão documental e backup Git;
- comandos de avaliação do refresh do veículo, antes das decisões de lease,
  backoff e autorização de consulta;
- coleta periódica do monitor Tuya e sondagem passiva RTX;
- resumo diário do Codex.

O subflow `Aguardar internet e VPN estáveis` mantém uma intenção volátil por
chamador, substituída pela observação mais recente. Ao liberar, consome essa
versão uma única vez e retorna ao caminho normal, que reavalia suas condições.
Não guarda comandos físicos de abrir, desarmar, travar ou destravar. Uma
intenção vencida é descartada; agendas e polling posteriores continuam normais.
Um restart perde apenas essas intenções voláteis, não o estado persistente dos
incidentes. Não há promessa de execução retroativa de agendas perdidas enquanto
o servidor esteve desligado.

Os demais tabs foram revisados: políticas, discovery, leitura local de
resultados, histórico de notificações, saúde local e decisões residenciais
iniciam normalmente. Os hubs continuam responsáveis somente pela entrega.
Erros compartilhados HA/MQTT durante a retomada não geram uma rajada por nó;
erros de autenticação e de funções continuam acionáveis. Um status de entidade
ou valor qualquer não encerra mais um incidente de conexão compartilhada:
é necessário um status explícito de conexão.

O worker documental precisa permanecer indisponível ou parado por 60 s antes
de abrir seu incidente. Recuperação ou `unknown` cancela a confirmação pendente;
`unknown` não encerra um incidente já confirmado. Falha de execução continua
imediata. O timer de teste usa uma chave diferente do timer de produção.

## Zigbee

A rede Zigbee usa sua própria dependência local: 180 s de startup e ponte online
por 60 s antes de iniciar recuperação de rotas ou alertar componentes. Ela não
precisa da WAN ou VPN para funcionar. Disponibilidade de componente agora exige
30 s offline ou 60 s online contínuos; o tick reavalia as observações, sem exigir
outra mensagem para completar a confirmação. Incidentes persistidos sem uma
observação atual não produzem lembretes.

Um `configure` com `status: ok` inicia verificação; não encerra o incidente.
Falhas tardias com a mesma transação continuam válidas. A recuperação exige
300 s sem nova falha e uma publicação de dados do próprio dispositivo após essa
janela. Payload retained, availability e respostas de `networkmap` não são essa
prova. Uma nova falha mantém o incidente e o limite de tentativas. Mesmo após o
esgotamento, duas publicações novas separadas pela janela estável podem comprovar
a recuperação natural do dispositivo, sem iniciar outra tentativa.

A consulta `networkmap` obtém um mapa; não comprova conserto da malha. Cada
transação só pode iniciar um `configure`, mesmo recebendo mapas duplicados.
A reserva de estágio e a persistência usam comparação de versão para impedir
que mensagens concorrentes disparem a mesma tentativa. A agenda mantém cooldown
de 15 min e no máximo três tentativas por incidente, inclusive se não vier
resposta. São emitidos apenas abertura, esgotamento final e recuperação
comprovada; falhas intermediárias permanecem no lifecycle sem novo push.

Incidentes e tentativas sobrevivem a restart. Evidência de comunicação é
volátil e precisa ser renovada; um restart não transforma histórico em prova de
saúde. O flush de contexto persistente conserva a janela residual já documentada
em [Monitoramento de infraestrutura](ZIGBEE_HEALTH_NOTIFICATIONS.md).

## Verificação e operação

`flows:update-global-observer` instala também a política compartilhada e os
chamadores, mantendo cobertura para todos os tabs. O gerador Zigbee preserva
geometria aprovada e nós de outros domínios. Os adaptadores de mutação de rota
e leitura de rede excedem 2.000 caracteres por manterem atômicos a comparação de
versão e a recomposição de histórico; os testes limitam essas duas exceções a
4.000 caracteres e as demais funções Zigbee a 2.000.

No tab de retomada: reset, internet online, VPN online, renovação das duas
observações em +120 s, offline e unknown. Confira o terminal dry-run. Os testes
reproduzem as decisões reais, incluindo retenção, frescor, reinício, coalescência,
expiração e consumo único, sem publicar prontidão de produção.

No Zigbee: reset, ponte online, testes de rota 13 a 19; depois 20 (ainda sem
prova), 21 (dados novos) e 20 novamente. O erro começa após a carência inicial.
Os botões de availability agora também precisam da agenda com o instante de
confirmação. O replay automatizado cobre os limites exatos e oscilações.

```bash
node nodered/tools/test-startup-readiness.mjs
node nodered/tools/test-zigbee-startup-recovery.mjs
node nodered/tools/test-zigbee-monitor-flow.mjs
node nodered/tools/test-global-flow-observer.mjs
npm --prefix nodered run flows:validate-manual-tests
npm --prefix nodered run flows:validate-observability
npm --prefix nodered run flows:validate-layout
```

Testes de falha das abas afetadas terminam no dry-run global. Não é necessário
enviar push real para validar estas mudanças. Antes de afirmar ativação,
compare a definição em memória pela API do Node-RED e observe os ciclos nativos.
