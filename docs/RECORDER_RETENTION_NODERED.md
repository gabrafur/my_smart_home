# Retenção do Recorder no Node-RED

A aba `recorder_retention` é a fonte canônica da política de compactação e
purga seletiva do histórico. Os alvos continuam visíveis em um nó `change` e
os serviços continuam sendo `recorder.purge_entities` e `recorder.purge`.

## Parâmetros visuais

| Parâmetro | Padrão | Limite | Uso |
| --- | ---: | ---: | --- |
| Retenção bruta | 2 dias | 1–14, inteiro | Janela mantida nas entidades compactadas |
| Retenção compacta | 30 dias | 7–180 e maior que a bruta | Janela global mantida após repack |
| Intervalo de baseline | 6 h | 1–24 | Frequência mínima dos pontos de referência |
| Tolerância absoluta | 0,5 | 0,1–10 | Mudança numérica mínima absoluta |
| Tolerância relativa | 1% | 0,1–10% | Mudança mínima proporcional |
| Multiplicador MAD | 3 | 1–10 | Detecção robusta de outliers |
| Aquecimento | 2 dias | 0–14, inteiro | Período antes de aplicar compactação adaptativa |
| Espaço mínimo para repack | 256 MiB | 64–4.096 MiB, inteiro | Evita compactação sem ganho absoluto relevante |
| Percentual mínimo para repack | 20% | 5–80% | Evita compactação quando as páginas livres são uma fração pequena do banco |

O validador persiste `recorder_retention_policy_v2`. Um valor inválido não
substitui a última política completa. As decisões baseline/mudança/outlier/
descarte, o plano de purga, a fila, o rate limit de uma purga a cada dois
minutos e a espera de cinco minutos antes do repack aparecem separadamente no
canvas. Depois que a fila esvazia, o produtor publica os bytes e o percentual
de páginas livres do SQLite; o Node-RED só libera o repack quando os dois
limites mínimos são atingidos. Caso contrário, encerra o ciclo como
`repack_skipped` sem executar I/O pesado.

O ciclo automático começa diariamente às 08:15, após a janela do backup nativo
do Home Assistant (04:45–05:45) e sua margem de retry. Isso evita que backup,
purga e repack disputem o lock do Recorder.

O cálculo estatístico da série compacta continua em JavaScript porque agrega
amostras e calcula mediana/MAD; ele recebe todos os parâmetros pela política e
não chama serviços. Produção e teste compartilham o cálculo e as decisões até o
gate final. O replay sintético termina no terminal dry-run e nunca chama o
Recorder.

O deploy não remove entidades nem apaga o contexto de ciclo existente. A
migração conserva as chaves de estado e deixa um ciclo já enfileirado terminar
segundo a política anterior, sem iniciar purga na reinicialização.
