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

