# Recuperação e backup do coordenador Zigbee

[Português (principal)](ZIGBEE_COORDINATOR_RECOVERY.md) · [English summary](ZIGBEE_HEALTH_NOTIFICATIONS.en.md)

A aba `recuperacao_zigbee` é a fonte das decisões de recuperação. O adaptador
nativo coleta fatos sanitizados a cada 15 segundos e executa somente pedidos
fixos de backup, reconexão ou restauração do Zigbee2MQTT. Ele não controla
dispositivos, não abre pareamento e não instala firmware.

## Política e proteção dos dados

O canvas avalia a fonte a cada 30 segundos. Aguarda cinco minutos após o início
do serviço e confirma uma falha em observações separadas por 60 segundos. Uma
queda do serviço, perda total do cadastro ou erros `INVALID_PARAM` repetidos
podem solicitar recuperação. A indisponibilidade de um dispositivo isolado não
reinicia a rede inteira.

A reconexão preserva o banco atual. A restauração do banco só é permitida
quando todos os dispositivos desapareceram. O adaptador valida novamente os
fatos, a identidade da rede, os hashes e as condições antes de executar. Há
cooldown mínimo de 15 minutos e no máximo duas recuperações em 24 horas.
Manutenção do host, fonte desconhecida, configuração incompatível e operação
interrompida bloqueiam novos efeitos. Um pedido consumido não é repetido.

O backup usa a API nativa `bridge/request/backup` e exige resposta correlacionada.
Só uma observação saudável, com telemetria real recente, permite promovê-lo.
Banco vazio, entrevista incompleta, perda de dispositivos e mudança de
identidade não substituem a última cópia boa. PAN, identificador estendido,
chave, endereço do coordenador, canal e membros precisam ser consistentes.

O Z-Stack pode omitir da tabela nativa um roteador sem chave individual,
mesmo quando ele continua respondendo. Nesse caso, a captura pode preservar
somente seu endereço e vínculo já presentes no último bundle com hash válido,
desde que ele continue como roteador no banco atual. A identidade nativa e
todos os contadores novos continuam obrigatórios; chaves individuais antigas,
dispositivos desconhecidos e tabela nativa vazia não são completados.
`preserved_membership_count` explicita essa composição nos fatos e no bundle.
Isso preserva o cadastro; não comprova que todos os dispositivos estão online.

Após migração de canal, Z-Stack pode registrar o canal ativo correto e manter
uma máscara antiga no backup. O adaptador alinha a máscara somente quando o
canal ativo do backup já corresponde à configuração; nunca altera chaves ou
identidade para forçar uma restauração.

Os bundles privados ficam em `/var/lib/zigbee-coordinator-recovery`, com
permissões restritas, hash e até 32 versões. Evidências anteriores à recuperação
também são preservadas. O Node-RED recebe apenas fatos e recibos em
`/data/zigbee-recovery`; os arquivos não contêm chaves nem credenciais.

Um backup é renovado a cada 15 minutos enquanto elegível. O botão
**PRODUÇÃO: validar e salvar backup agora** usa as mesmas validações e pode
antecipar a captura após manutenção ou pareamento. Pedido aceito não prova
recuperação: o retorno depende de telemetria real posterior.

## Instalação e verificação

No checkout residencial canônico:

```sh
sudo sh scripts/install-zigbee-coordinator-recovery.sh
sudo node nodered/tools/install-zigbee-recovery-flow.mjs
sudo node nodered/tools/install-global-flow-observer.mjs
sudo node nodered/tools/apply-left-margin.mjs
```

O host precisa de Node.js, Docker e `js-yaml`. Publique os flows pela API
versionada do Node-RED, preservando a revisão e os nós de outras abas. O
instalador não publica flows nem arma uma recuperação por conta própria.

Validação direcionada:

```sh
scripts/run-resource-safe.sh node --test scripts/zigbee-coordinator-recovery.test.mjs
scripts/run-resource-safe.sh node nodered/tools/test-zigbee-coordinator-recovery.mjs
npm --prefix nodered run flows:validate-observability
npm --prefix nodered run flows:validate-manual-tests
npm --prefix nodered run flows:validate-layout
```

No canvas, use RESET e os testes numerados. Eles atravessam as decisões de
produção até o gate final e terminam com `simulated:true`, `dispatched:false`.
Não derrube a rede da casa para testar. Confira o timer, a idade dos fatos,
`last_good_available` e um recibo `snapshotted` de um ciclo natural.

## Firmware nas atualizações diárias

A aba `atualizacoes_diarias` decide a atualização às 03:00, na janela já
existente, ou pelo controle manual de produção dessa aba. O atualizador
interno do SMLIGHT deve continuar desligado. O `update.install` genérico não
instala firmware de coordenadores; eles têm um caminho visual próprio.

O inventário `update.*` identifica as entidades do SMLIGHT associado ao endereço
TCP configurado no Zigbee2MQTT. Um produtor nativo somente de leitura consulta
o canal **release** pelo SDK `pysmlight` instalado no Home Assistant, a cada
30 minutos. Ele publica versões de core e rádio Zigbee, sem instalar nada.
Isso evita que o canal de desenvolvimento ou uma versão ignorada no Home
Assistant esconda futuras versões estáveis. Não altera a integração do HA.

O canvas compara versões: exige release estável mais recente, não faz downgrade
e rejeita desenvolvimento/beta. A idade máxima dos fatos do host (300 segundos,
limites 30–600) e do inventário (40 minutos, limites 30–120) fica nos parâmetros
visuais, com preservação do último valor válido. Uma intenção elegível entra em
fila privada de manutenção. O worker usa o mesmo lock da manutenção diária;
uma manutenção já em andamento não perde o pedido nem permite atualizações
simultâneas.

Antes de qualquer instalação, o adaptador confirma novamente a versão atual e
a última release do fabricante, o destino registrado, a implementação de restore
revisada e uma resposta Zigbee real, sem mudar o estado das cargas. Obtém novo
backup nativo, valida identidade e membros e salva uma cópia com hash. Só então
para o Zigbee2MQTT e solicita o firmware pelo SDK oficial. A URL precisa ser do
diretório HTTPS de firmware do fabricante; o pedido do Node-RED não aceita URL,
comando nem credenciais.

Depois da versão confirmada, restaura a memória do rádio pelo mesmo
`zigbee-herdsman` revisado da imagem instalada, recupera o banco protegido,
reinicia somente o Zigbee2MQTT e exige resposta real de um dispositivo para
registrar sucesso. O código do restore é revisado para herdsman 11.2.0: uma
versão diferente bloqueia a instalação antes de parar o serviço, até revisão.
Os contadores Zigbee são preservados/avançados; não se deve copiar um backup
antigo diretamente para uma rede ativa.

O diário privado grava a intenção antes da chamada de firmware. Resposta perdida
não repete a instalação: o próximo ciclo apenas observa a versão. Resultado
incerto mantém a proteção e gera alerta no monitor global. Depois da recuperação
confirmada, o alerta é encerrado. Falhas de integridade e limites de restauração
exigem intervenção; nenhuma condição desconhecida autoriza nova gravação.

Os timers `zigbee-firmware-inventory` e `zigbee-firmware-maintenance` somente
produzem fatos e executam pedidos admitidos pelo canvas. Não constituem uma
segunda agenda de instalação. O instalador habilita esses timers e o de
recuperação, mas não instala firmware por conta própria.

Teste manual: RESET do coordenador → estável (dry-run) → beta, downgrade e sem
janela (bloqueados) → RESET → manutenção ocupada (intenção em dry-run) → falha
(alerta em dry-run). Os testes usam entidades sintéticas e contexto de teste;
nenhum firmware ou dispositivo residencial é acionado. Execute também:

```sh
scripts/run-resource-safe.sh node --test scripts/zigbee-firmware-maintenance.test.mjs scripts/lellki-startup-behavior.test.mjs
scripts/run-resource-safe.sh node nodered/tools/test-firmware-auto-update.mjs
```

## Limites físicos e comportamento após falta de energia

Backups locais não protegem contra perda física do armazenamento. Firmware
incompatível, defeito físico e dispositivos que saíram voluntariamente da rede
podem exigir intervenção ou novo pareamento. O mecanismo não promete restaurar
automaticamente esses casos e nunca abre o portão como teste.

O conversor externo `lellki-jz-zb-001-v201.mjs` é limitado ao fingerprint
LELLKI JZ-ZB-001, aplicação 5 e firmware 2.0.1. Esse firmware rejeita o atributo
Tuya usado pelo conversor padrão e expõe `startUpOnOff` somente para leitura.
A propriedade `power_outage_memory` mostra o valor real (`off`/`on`), sem comando
de escrita na interface. A confirmação idempotente de um valor já existente
não grava o atributo. Não generalize esse comportamento a outros firmwares.
