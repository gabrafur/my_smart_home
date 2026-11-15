# Erros de linha na listagem de tarefas

`derive.py` contém a derivação pura da correção: o trecho exato trocado em
`task_list.py` e a atualização mínima do pin na política de tarefas e do hash
da política na inscrição do peer. Não lê nem grava arquivos, não observa o
peer e não produz prova.

Antes da correção, uma única thread registrada sem metadados do daemon marcava
a listagem inteira como `partial_collection_failure` com `collection_errors`
vazio. Depois dela, o erro global reflete somente falhas do coletor e as
lacunas por linha aparecem em `row_collection_errors`.

```bash
cd scripts/raspberry-mcp/task-list-row-errors
python3 -B -m unittest test_derive
```

A instalação é uma transação de quatro alvos (módulo, política, inscrição e
prova do peer) sob as travas compartilhadas, com plano de validade finita,
verificação de leitura e reversão própria. O operador deve conferir os hashes
atuais, exigir que o peer observado seja o mesmo da prova vigente e recusar
qualquer mudança de escopo, cota ou identidade. Este diretório não instala
nada sozinho.
