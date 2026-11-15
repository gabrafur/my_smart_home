# Orçamento do snapshot básico do MCP

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


O observador de resultados em `ExecStartPost` aplica um prazo único desde a
leitura das fontes seladas até a publicação do snapshot. O sinal usa uma exceção
própria que não é absorvida pelos tratamentos de erro de coleta. Ao vencer, o
journal registra somente fase e duração; não exporta IDs ou conteúdo privado.
Timeout anterior à publicação não atualiza o snapshot. Timeout durante publicação
pode ocorrer após o rename: releia o mesmo snapshot e não infira ausência de
escrita. O prazo do systemd continua sendo o limite externo; I/O ininterruptível
e falta de escalonamento não têm garantia de interrupção em Python.

O drop-in do observador também é dependência da política de tarefas. Seu hash
novo exige fechamento transitivo das políticas e renovação da prova nativa do
peer, sem substituir identidade nem fabricar atestação. Instalar somente
bootstrap, configuração e drop-in quebra a admissão das tarefas.
