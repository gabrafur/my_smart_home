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
preservam os handlers, os limites de recursos e a agenda; não alteram
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

## Envelope de parede para concluir I/O

Em 26/10/2026 seis interrupções recentes em escrita foram comprovadas com
`SIGALRM`; esperas de `fsync` ainda pendentes foram observadas acima de cinco
segundos. Isso não identifica uma falha física de armazenamento nem explica a
lacuna histórica de 112 segundos.

O wrapper agora chama os limites originais uma vez, preserva seus handlers e
rearma explicitamente o alarme de parede de 5 para 15 segundos. A unidade
existente passa de `TimeoutStartSec=7` para `20`. CPU por invocação de 2 segundos,
quota de 15%, memória, descritores, durabilidade, locks e timer de 55 segundos
permanecem. O coletor original continua com os mesmos bytes e alarme de cinco
segundos; o novo envelope pertence ao wrapper. Não existe retry automático.

A aplicação às 22:22 UTC carregou a unidade sem iniciar o coletor ou reiniciar
serviços. Os dois primeiros ciclos naturais concluíram, com aproximadamente
56 segundos entre eles. Isso comprova execução posterior à aplicação, ainda
sem provar que uma escrita acima do limite antigo completará ou que a
cadência de 24 horas foi recuperada. Reutiliza-se a evidência anterior de
CPU/RSS; as falhas e lacunas históricas continuam preservadas.

A captura fixa de 27/10/2026 às 23:00 UTC acrescenta uma janela posterior à
correção. Somente lê histórico e journal e escreve o recibo sanitizado; pode
rodar após expiração administrativa, sem admitir reparos nem depender de PC
ou conversa. Os seis relatórios anteriores são imutáveis. Ausência, falha ou
lacuna continuam impedindo aceite. A projeção MCP seleciona a nova janela
quando devida, sem substituir resultado ausente por sucesso antigo.

As fontes de referência dos dois pacotes ficam em
[apply_procmon_runtime_budget.py](../runtime-source/administrative-recovery/apply_procmon_runtime_budget.py)
e [apply_procmon_post_budget_capture.py](../runtime-source/administrative-recovery/apply_procmon_post_budget_capture.py).
São operações fixas seladas, com before/intent/recibos privados, não comandos
arbitrários fornecidos ao MCP. A reversão compara os hashes conhecidos e
recarrega apenas a unidade ou o timer correspondente; edição externa ou
política posterior exige reconciliação antes. Os testes usam diretórios e
fronteiras sintéticos para falha parcial, resultado incerto, recusa de
repetição e reversão, sem serviço residencial.
