# Notificações globais de falha do Node-RED

O tab `observabilidade_global` centraliza falhas de todas as abas funcionais do
Node-RED e envia notificações ao papel `resident_primary` pelo binding lógico
`mobile_primary/notify_3` do Home Assistant.

## Cobertura

O gerador `nodered/tools/install-global-flow-observer.mjs` acrescenta a cada
aba um grupo isolado com:

1. `catch` de todos os erros, inclusive os já tratados localmente;
2. `status` de todos os nós da aba;
3. identificação do tab de origem;
4. `link out` nomeado para o monitor central.

Erros emitidos com `node.error` alertam imediatamente. A mesma assinatura é
silenciada por seis horas para evitar tempestade. Para nós do Home Assistant e
MQTT, somente textos explícitos de conexão perdida, indisponibilidade ou
reconexão pendente podem abrir um incidente compartilhado; cor vermelha,
condição de domínio e erro de uma chamada de serviço não significam que a
conexão inteira caiu. Status de indisponibilidade do DuloNode continuam
considerando também erro e timeout. A condição precisa permanecer por um
minuto antes do push. Status visuais de funções de domínio não abrem alerta
global, pois seus incidentes já pertencem ao monitor específico. Conexões do
Home Assistant e MQTT são agregadas, evitando um push para cada nó quando a
dependência compartilhada cai. Uma recuperação libera o alerta do próximo
incidente.

O monitor não inclui o próprio tab na captura universal. A falha do nó que
envia o push possui um `catch` específico que apenas registra o problema, sem
realimentar o canal e criar recursão.

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
5. use `TESTE 5: enviar push real` para o smoke test do canal central.

Os quatro primeiros passos nunca chamam o Home Assistant. O quinto é a exceção
explícita `notification_delivery_under_test`: envia um único push com `TESTE`
no título e na mensagem, sem executar qualquer outro efeito residencial. O log
`NODERED_GLOBAL_NOTIFICATION_ACCEPTED ... delivery_test=true` confirma que o
Home Assistant aceitou a chamada; a confirmação visual no celular valida a
última milha.

Validação canônica:

```bash
npm --prefix nodered run flows:update-global-observer
npm --prefix nodered run flows:validate-observability
npm --prefix nodered run flows:test-global-observer
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render-strict -- observabilidade_global
```
