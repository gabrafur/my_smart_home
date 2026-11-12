# Cadência do snapshot básico do MCP

Override revisado para o timer existente, sem reinstalar o MCP. Os valores são
segundos: primeiro disparo no boot em `60`, recorrência em `55`, precisão em
`1` e atraso aleatório em `0`. A recorrência mantém o valor já aprovado no
runtime; o instalador genérico continua com seu padrão de cinco minutos.

Uma atribuição vazia em qualquer diretiva de disparo limpa toda a lista
anterior, inclusive o `OnBootSec` da unidade base. Por isso o arquivo recoloca
`OnBootSec=60` **depois** do reset e antes da recorrência. Sem um disparo inicial
e sem ativação anterior do serviço neste boot, `OnUnitActiveSec` sozinho pode
deixar o timer em `elapsed`, com próximo disparo infinito e snapshot ausente.
A semântica está documentada em
[systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).

Aplicação em instalação existente exige a autorização e os gates vigentes do
operador. Conferir bases, preservar o override anterior e registrar o intent.
Parar somente `raspberry-mcp-collect.timer` antes de substituir o override em
`/etc/systemd/system/raspberry-mcp-collect.timer.d/60-sampling.conf`, como
root:root/0644. Recarregar o manager e iniciar somente esse timer. A parada
prévia evita que o reload e a reativação produzam dois disparos iniciais.
Não iniciar diretamente o coletor, fabricar snapshot ou reiniciar serviços
residenciais para testar a alteração.

Conferir todas as linhas de `TimersMonotonic`, `LastTriggerUSec` e
`NextElapseUSecMonotonic`: o systemd pode repetir uma propriedade para cada
timer, e um dicionário que guarda só o último valor perde evidência. Confirmar
o produtor e as ferramentas pelo MCP real, em mais de um ciclo natural. O
aceite inclui uma próxima execução finita e os dois disparos configurados.
Snapshot presente isoladamente não comprova recorrência.

## Orçamento da coleta

O publicador importa o coletor no mesmo processo Node.js, evitando um segundo
runtime dentro do limite de memória da unidade. As seis chamadas Docker
permitidas compartilham um orçamento monotônico de oito segundos; cada chamada
recebe no máximo 1,5 segundo e nunca é repetida. Esgotar esse orçamento impede
novas chamadas e mantém os campos sem evidência como desconhecidos. A leitura
limitada do resultado do backup e o `statfs` continuam usando caminhos fixos.

O limite de 15 segundos da unidade também inclui seu `ExecStartPost`. O
orçamento Docker não é uma garantia de duração total: agendamento, acesso ao
disco e publicação ainda podem atrasar. Falhas expõem no journal somente fases,
contadores e durações limitados, sem saída Docker ou texto de exceções. Esses
diagnósticos não ampliam o contrato MCP nem transformam dados ausentes em saúde.
A publicação mantém o arquivo temporário exclusivo e a troca por rename;
uma falha no diagnóstico posterior não desfaz um snapshot já publicado.

A regressão isolada fica em `../collection-budget.test.mjs`, junto dos testes
básicos em `../../raspberry-mcp.test.mjs`. Ela não consulta Docker, arquivos de
runtime ou dispositivos. Instalação existente exige CAS dos dois módulos,
pausa apenas do timer, conclusão da coleta em andamento e reversão das próprias
imagens. Depois, conferir ciclos naturais e a leitura real pelo MCP; testes
isolados não comprovam ausência futura de timeout.

A reversão preparada restaura os bytes originais com CAS e o mesmo ciclo de
parada/reload/início do timer. Não remove snapshots, não troca IDs e não desfaz
histórico. Como a base anterior contém o defeito de inicialização, não aplicá-la
rotineiramente depois da recuperação. A reversão desta correção está preparada;
não foi executada como parte do aceite.

O [aceite sanitizado](../basic-snapshot-cadence.acceptance.json) distingue a
falha MCP observada, a aplicação nativa, os ciclos naturais e as fontes dos
cinco diagnósticos consultados. `service_health`, `service_versions` e
`disk_space` usam o snapshot compartilhado. As rotas atuais de `backup_results`
e `log_summary` possuem produtores próprios: sua leitura posterior foi
validada, sem atribuir a elas uma falha anterior não observada.

O reparo não data o início da indisponibilidade histórica, não preenche lacunas,
não valida 24 horas e não substitui prova de execução da assistente.
