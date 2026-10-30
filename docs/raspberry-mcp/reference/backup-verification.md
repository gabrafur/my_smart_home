# Verificação de backup e limites de restore

Referência temática de implementação e aceites históricos. Datas identificam
evidências; não são autorização vigente nem prova de cobertura atual. Consulte
o [índice operacional](../README.md) e as capacidades reais antes de agir.

## Verificação do backup e entrada do contêiner

Upload, hash do ciphertext, autenticação criptográfica e recuperação funcional
precisam de provas próprias. O último produtor de backup pode reportar sucesso
enquanto a verificação independente termina antes de autenticar o arquivo.
`credential_input_limit` com stdin vazio não prova corrupção nem senha inválida.

No fluxo `docker create` seguido de `docker start --attach --interactive`, o
create precisa de `--interactive`. Conferir OpenStdin=true, Tty=false e UID
antes de solicitar a chave. Testar só a função de criptografia ou `docker run`
não cobre esse transporte. Há regressão do fluxo completo usando somente
fixtures, sem chave, backup ou mount residencial. O código auditado e os testes
ficam em [offsite-integrity](../../../scripts/raspberry-mcp/runtime-source/offsite-integrity/README.md).

Uma recuperação preparada mantém ID e recibos, exige falha anterior comprovada
antes da criptografia, limpeza e hashes exatos, e bloqueia resultados incertos.
Leituras consumidas não são liberadas apagando intents: exceção de orçamento
precisa de aprovação específica vinculada ao manifesto. Não concede novo
acesso MCP nem renova a validade administrativa. Snapshot público usa bindings;
não instalá-lo diretamente sobre a política vigente. A autenticação real e
a exposição do resultado pelo MCP continuam aceites separados.


## Aceite independente do backup de 26/10/2026

Após a exceção limitada aprovada pelo proprietário, a verificação do mesmo
artefato externo terminou `verified_cleaned`: o hash esperado do ciphertext
foi confirmado e todo o fluxo securetar v3 foi autenticado. A cópia e o
contêiner temporários foram removidos; os sete serviços mantiveram os horários
de início. A falha anterior e os recibos continuam preservados.
Isso comprova a integridade daquele artefato, sem afirmar restauração ou
recuperação funcional dos serviços. Não repetir a leitura consumida da chave
ou a transferência para reproduzir esse aceite.
