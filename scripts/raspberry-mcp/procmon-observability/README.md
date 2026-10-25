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
