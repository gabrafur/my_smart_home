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

## Firmware e limites

Desative o atualizador interno do coordenador: ele pode apagar a memória do
rádio enquanto o Zigbee2MQTT está ativo. Updates devem passar pela orquestração
canônica, com backup validado e parada coordenada. Uma versão que causou perda
da rede deve permanecer marcada como ignorada na entidade `update` até revisão.

Firmware incompatível, defeito físico e dispositivos que saíram voluntariamente
da rede podem exigir intervenção ou novo pareamento. O mecanismo não promete
restaurar automaticamente esses casos e nunca abre o portão como teste.
