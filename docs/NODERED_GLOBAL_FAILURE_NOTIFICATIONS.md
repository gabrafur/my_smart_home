# Notificações globais de falha do Node-RED

O tab `observabilidade_global` centraliza falhas de todas as abas funcionais do
Node-RED. Cada incidente de produção envia um push ao papel `resident_primary`
pelo binding lógico `mobile_primary/notify_3` e cria uma notificação persistente
na aba **Notificações** do Home Assistant.

## Cobertura

O gerador `nodered/tools/install-global-flow-observer.mjs` acrescenta a cada
aba um grupo isolado com:

1. `catch` de todos os erros, inclusive os já tratados localmente;
2. `status` de todos os nós da aba;
3. identificação do tab de origem;
4. `link out` nomeado para o monitor central.

Erros emitidos com `node.error` alertam imediatamente. A mesma assinatura é
silenciada por seis horas para evitar tempestade. Para nós do Home Assistant e
MQTT, erros individuais também são suprimidos enquanto a conexão compartilhada
está indisponível e por 90 segundos depois da reconexão. Assim, as leituras de
startup de várias abas não produzem uma rajada para o mesmo restart; erros de
funções não relacionados continuam alertando imediatamente. Somente textos
explícitos de conexão perdida, indisponibilidade ou reconexão pendente podem
abrir um incidente compartilhado; cor vermelha, condição de domínio e erro de
uma chamada de serviço não significam que a conexão inteira caiu. Status de
indisponibilidade do DuloNode continuam considerando também erro e timeout. A
condição precisa permanecer por um minuto antes do push. Status visuais de
funções de domínio não abrem alerta global, pois seus incidentes já pertencem
ao monitor específico. A queda compartilhada do Home Assistant exige
corroboração simultânea de pelo menos dois nós; um único nó com domínio ou
entidade indisponível não representa o servidor inteiro. Conexões do Home
Assistant e MQTT são agregadas, evitando um push para cada nó quando a
dependência compartilhada cai. Uma recuperação libera o alerta do próximo
incidente após a carência de reconexão.

O monitor não inclui o próprio tab na captura universal. A falha do nó que
envia o push ou cria a notificação persistente possui um `catch` específico que
apenas registra o problema, sem realimentar o canal e criar recursão. Cada
notificação persistente usa um identificador estável por incidente, de modo que
uma repetição atualiza o alerta existente em vez de criar cópias.

Os três nós centrais do próprio monitor — classificação, confirmação temporal e
separação de efeitos — possuem um `catch` interno dedicado. Esse caminho ignora
o processador que falhou, aplica deduplicação de seis horas e chama diretamente
os dois canais de entrega. O manipulador interno e os terminais de log ficam
fora do seu próprio escopo para impedir realimentação recursiva.

## Auditoria de cobertura

O validador exige, para cada tab funcional, um `catch` universal com erros já
tratados incluídos e um `status` universal, ambos ligados ao monitor central.
Isso cobre exceções e `node.error`, falhas reportadas pelos nós, timeout e os
estados explícitos de indisponibilidade do Home Assistant, MQTT e DuloNode.
Também são validados separadamente os dois canais de entrega e o caminho interno
do próprio monitor. A queda completa do runtime continua coberta pelo watchdog
nativo no Home Assistant, pois um Node-RED parado não consegue observar a si
mesmo.

Nós de configuração sem execução própria não emitem erro ou status diretamente;
suas falhas aparecem nos nós consumidores observados. Condições de domínio que
não geram erro nem status precisam continuar sendo modeladas pelos monitores
funcionais específicos, para não transformar estados legítimos em falsos
incidentes globais.

## Indisponibilidade dos runtimes

As chamadas ao Home Assistant usam `queue: all`. Se a conexão local com o HA
cair, o Node-RED conserva a chamada e tenta entregá-la quando a conexão voltar.
Não existe push via Home Assistant enquanto o próprio Home Assistant está fora
do ar.

O Node-RED publica `online`/`offline` retained em `nodered/status` usando birth,
close e LWT do MQTT. O package nativo
`homeassistant/packages/nodered_flow_health.yaml` observa esse tópico fora do
Node-RED. Após 90 segundos offline, o Home Assistant cria uma notificação
persistente e envia push ao `resident_primary`; no retorno, encerra o incidente
e envia a recuperação. Um deploy curto não abre incidente.

Se Node-RED e Home Assistant estiverem indisponíveis ao mesmo tempo, nenhum dos
dois pode produzir um push naquele instante. Quando o HA voltar enquanto o LWT
retained ainda estiver `offline`, ele detecta e alerta. Se ambos voltarem antes
de qualquer observador externo registrar a queda, o intervalo não pode ser
reconstruído com garantia; monitoramento fora do host é necessário para cobrir
esse caso extremo.

## Testes

No tab `observabilidade_global`:

1. use `TESTE 1: reset`;
2. use `TESTE 2: erro de nó` e confira o terminal dry-run;
3. use `TESTE 3: indisponível`;
4. use `TESTE 4: avaliar após 1 min` e confira o terminal dry-run;
5. opcionalmente, use `TESTE 5: enviar push real` para o smoke test do canal
   central quando for necessária confirmação ponta a ponta.

Os quatro primeiros passos nunca chamam o Home Assistant. O quinto é a exceção
explícita `notification_delivery_under_test`: envia um único push com `TESTE`
no título e na mensagem, sem executar qualquer outro efeito residencial. O log
`NODERED_GLOBAL_NOTIFICATION_ACCEPTED ... delivery_test=true` confirma que o
Home Assistant aceitou a chamada; a confirmação visual no celular valida a
última milha. O smoke test não cria uma notificação persistente. Esse teste não
é requisito para deploy, commit ou push de alterações Node-RED que não
modifiquem materialmente a rota de notificações.

Validação canônica:

```bash
npm --prefix nodered run flows:update-global-observer
npm --prefix nodered run flows:validate-observability
npm --prefix nodered run flows:test-global-observer
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render-strict -- observabilidade_global
```
