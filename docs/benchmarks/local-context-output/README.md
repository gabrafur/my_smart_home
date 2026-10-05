# Formatação local de saídas de testes

Medição de 05/10/2026. O [agregado](summary.json) contém somente metadados;
nenhuma saída de teste ou dado residencial foi incorporado ao relatório.

| Entrada | Tokens antes | Tokens depois | Redução |
| --- | ---: | ---: | ---: |
| Testes reais durante desenvolvimento, com falhas | 2.906 | 2.228 | 23,33% |
| Testes reais aprovados, 32 casos | 1.429 | 861 | 39,75% |
| Fixture com Unicode, falha multilinha e texto desconhecido | 3.448 | 1.696 | 50,81% |
| Formato desconhecido | 1.500 | 1.500 | 0% — preservado |
| Saída pequena | 2 | 2 | 0% — preservada |

O tokenizer local foi `tiktoken 0.14.0`, encoding `o200k_base`, aplicado ao
texto inteiro entregue, incluindo o cabeçalho. Não é uma medida de faturamento
do Codex, de qualidade de resposta do modelo ou de redução da conversa inteira.
O agregado `AGENTS.md` ficou com os mesmos 7.355 tokens nesse encoding antes e
depois da mudança; a regra nova não aumentou esse custo inicial.

Todas as entradas reconstruíram exatamente os bytes originais. Mensagens de
erro, assertions, warnings e linhas desconhecidas permaneceram literais.
Somente a representação repetida de sucessos TAP foi compactada. O teste com
falhas veio de uma execução durante a edição de instruções; as verificações
correspondentes passaram após regenerar o agregado e respeitar seu limite.

O tempo p95 da transformação ficou entre 0,53 e 1,22 ms nos casos compactados.
Em cinco pares alternados de replay por entrada, o custo mediano do lançador
ficou entre 16 e 43 ms. Esses replays não reexecutam validações: leem a mesma
saída local, com e sem o wrapper. Houve zero chamadas de inferência e nenhuma
mudança no rollout do canário RTX.

Os gates definidos antes da medição final exigiram reconstrução exata, nenhuma
ampliação de tokens no fallback, redução mínima de 15% nos casos compactados,
p95 de transformação abaixo de 10 ms e overhead mediano abaixo de 100 ms.
Todos passaram. A redução de texto é comprovada nessa amostra; cobertura de
outros formatos, economia de faturamento e qualidade da resposta final do
modelo não foram medidas. O uso é destinado a saídas extensas de suítes; não
adicione o lançador a comandos pequenos ou interativos.

Validação da integração: 12 testes do formatador, 32 testes de memória/privacidade
e os checks de segurança, privacidade, memória, documentação e integração Local
AI passaram. A validação ampla parou na classificação de fixtures sintéticas de
um teste Windows; a marcação foi corrigida e os checks afetados foram reexecutados.
As demais suítes amplas não foram repetidas no servidor residencial.

## Reprodução

O runtime requer somente Python padrão. A contagem de tokens do benchmark usa
`tiktoken==0.14.0` em diretório temporário isolado, fora das dependências da casa.
Capture saídas de testes públicos sem segredos em arquivos temporários. As
duas entradas reais vieram dos testes de memória, privacidade e do formatador;
contagens e tempos podem variar com os casos presentes e o hardware.

```bash
./scripts/run-resource-safe.sh python3 -m unittest discover -s scripts/local-ai -p 'test_*.py'
./scripts/run-resource-safe.sh python3 scripts/local-ai/benchmark_output.py /tmp/local-context-tokenizer /tmp/public-tests.tap
```

O benchmark retorna não zero se qualquer gate falhar e emite somente hashes,
tamanhos, contagens e tempos. O wrapper de uso normal é
`python3 scripts/local-ai/run.py -- COMMAND [ARG ...]`; preserve os alvos
canônicos e as restrições de recursos do comando original. Para desfazer,
omita o wrapper. Consulte o [contrato operacional](../../LOCAL_AI_RTX_4070.md).
