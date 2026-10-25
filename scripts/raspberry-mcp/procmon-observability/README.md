# Regressão de criação atômica do procmon

`collector.source.py` é uma fixture byte a byte do coletor original instalado,
SHA-256 `d53a173123b0d6d96406e56bd73559fd5fd00d6dd040bf36cf2c21b978e1b277`.
Não é instalador e nunca deve substituir o coletor em produção. Os testes
importam a instrumentação canônica de
[observed_collector.py](../runtime-source/procmon-observability/observed_collector.py).

Em 25/10/2026 uma interrupção observada em `publish_snapshot` foi seguida por
188 recusas `unsafe_interrupted_sample`: um arquivo temporário público vazio
estava com modo 0600, enquanto o gate exige 0640. Os testes isolados reproduzem
a janela entre criação e `fchmod`; não provam o sinal/caller histórico exato.
A causa da lacuna antiga de 112 segundos permanece desconhecida.

A correção altera somente o wrapper já instalado: restringe temporariamente o
umask aos bits necessários para criar o arquivo imediatamente com o modo que o
próprio coletor exige. Restaura o umask e preserva os modos privado/público,
os prazos, limites e verificações de recuperação. O coletor original permanece
inalterado. O processo original é serial, sem threads concorrentes.

Na recuperação administrativa única, com intent antes do efeito e lock do
coletor, a identidade completa do temporário foi confirmada e o arquivo vazio
foi movido intacto para quarentena privada de root. Não houve promoção a amostra,
exclusão de evidência, chamada manual do coletor ou restart de serviço. Uma nova
execução usa naturalmente o wrapper revisado. Não repita a operação consumida.

O journal real registrou última conclusão em 05:22:00Z e nova conclusão em
08:19:03Z: lacuna de 10.623 segundos entre conclusões. Nove ciclos naturais
posteriores estavam concluídos às 08:26:35Z. Isso comprova recuperação atual,
com perda histórica explícita; não comprova 24h de cobertura contínua.

A evidência pública sanitizada está em
[procmon-mode-recovery.acceptance.json](../procmon-mode-recovery.acceptance.json).
Os intents, identidade de inode e recibos originais permanecem privados.


## Sinais, gravação e custo por invocação

O wrapper observa `SIGALRM` e `SIGTERM` recebidos pelo handler original e o
intervalo de `fsync` de arquivo/diretório. Adaptadores privados do módulo
preservam os handlers, o alarme original, os limites e a agenda; não alteram
`os` ou `signal` globalmente. O quadro sanitizado continua limitado a 768 bytes.
Não contém caminhos, descritores, mensagens de erro nem remetente do sinal.
Um sinal observado no futuro não identifica a causa de uma falha antiga.

`cpu_us` preserva a semântica anterior: delta desde a criação do observador.
`process_total_cpu_us` mede o processo até a emissão da telemetria, incluindo o
bootstrap anterior ao observador. Não inclui o trabalho posterior à emissão.
O [observador do host](../../host-observation/README.md) também lê o contador
systemd da invocação encerrada, com identidade correspondente, para medir o
custo completo da unidade. Memória indisponível permanece desconhecida.

[invocation_audit.py](invocation_audit.py) é um leitor fixo, sem argumentos,
instalado como root em
`/usr/local/lib/raspberry-procmon-observability/invocation_audit.py`. Não é uma
nova ferramenta de comandos MCP. Correlaciona início/fim do gerenciador,
telemetria e custo da unidade pelos identificadores internos de boot/invocação;
exporta somente contagens e métricas sanitizadas. Detecta ausências, duplicatas,
execuções em andamento, estados conflitantes e truncamento da coleta. Não
trata invocação sem telemetria como custo zero. A cobertura temporal, o custo
completo e a correlação são campos separados; a meta completa e PC desligado
continuam sem aceite automático.

Um novo intervalo de 112 segundos entre conclusões bem-sucedidas foi analisado
separadamente: havia amostra durável no ciclo intermediário que falhou depois,
com intervalos de amostragem de 55–56 segundos nesse trecho. Isso não elimina a
lacuna histórica real de 112,01 segundos. Aumentar a frequência sem orçamento
de retenção reduziria a janela preservada; a agenda original foi mantida.

Os testes isolados cobrem handlers e limites originais, isolamento dos
adaptadores, interrupção propagada, tamanho do quadro, correlação, coleta
incompleta, CPU legado/completa e ausência de memória. A janela sintética de
24h dos testes não constitui evidência de produção.
