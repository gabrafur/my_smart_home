# Diagnóstico do heartbeat externo

Estas fontes são uma cópia auditável do emissor instalado. Não incluem a
credencial, banco, status operacional ou autorização de execução. Os hashes e
destinos estão em [SOURCE-MAP.json](../SOURCE-MAP.json). Não executar o emissor
para testar: ele envia uma requisição real ao provedor.

O timer existente executa uma tentativa por minuto. Antes da rede, o emissor
persiste uma intenção; resultados incertos não são repetidos. HTTP 200 com
resposta `OK` comprova aceite pelo provedor, sem comprovar entrega de e-mail,
execução da Eva ou saúde dos serviços residenciais.

A versão diagnóstica 3 preserva o contrato da versão 2, que grava a categoria de falha e o resultado na mesma
transação. A tabela original de amostras permanece intacta; a tabela adicional
`failure_diagnostics` armazena somente categorias fechadas. Não grava texto de
exceção, URL, UUID, resposta privada ou credenciais. A retenção anterior é
preservada.

O status local acrescenta `diagnostic_schema_version` e
`latest_failed_or_uncertain_sample`, com `observed_at`, `state`, `http_status`,
`failure_category`, `is_latest_attempt`, `sample_completion_recorded` e
`transport_outcome_not_service_health`. Uma falha anterior permanece visível
após sucesso posterior. `not_recorded` preserva a incerteza de registros antigos
ou tentativas sem conclusão. A disponibilidade desses campos no arquivo local
não implica sua exposição por uma ferramenta MCP.

As categorias são `dns_resolution_error`, `tls_certificate_error`, `tls_error`,
`timeout_exception`, `connection_error`, `http_protocol_error`, `os_error`,
`transport_exception_unclassified`, `unexpected_provider_response` e
`http_refused`. Elas descrevem a observação, sem atribuir uma causa raiz.

Para atualizar uma instalação existente, o administrador deve comparar os
hashes e instalar `loaded_identity.py`, `history.py` e `heartbeat.py`, nessa
ordem, como root:root/0644; deve
preservar os demais arquivos, credenciais, timer, banco e intenções. O próximo
ciclo natural carrega o código; não é necessário reiniciar serviços. A reversão
restaura primeiro sender e histórico e remove somente o helper novo de hash
conferido; preserva o banco e todas as tabelas adicionais. Não executar a instalação de uma nova assinatura para atualizar
essa instrumentação.

Teste isolado, sem rede ou dispositivo:

```sh
python3 -I -S -B -m unittest discover -s scripts/raspberry-mcp/runtime-source/host-heartbeat -p 'test_*.py'
```

O teste também participa de `make validate-public` pelo runner Node.js. Ele
cobre falha antiga seguida de sucesso, falha posterior, migração, tentativa
inacabada, atomicidade, categoria inválida, retenção e ausência de dados privados.

## Identidade carregada no ciclo nativo

`loaded_identity.py` calcula o fingerprint dos objetos de código do sender,
histórico, transporte e do próprio produtor da prova. Não lê credenciais,
locais/stack ou payload de rede. Um hash separado vincula constantes críticas;
as referências de History, transporte e defaults também são verificadas.
O domínio `python_code_objects_v1` inclui o cache tag do interpretador, não
se confunde com hash de arquivo e não representa todo o ambiente Python.

A tabela `loaded_identity` tem no máximo uma linha, ligada à amostra exata.
Ela não substitui amostras ou falhas históricas, não aumenta a retenção e não
é um recibo de reparo. Novo ciclo inacabado não herda a identidade anterior.
Erro na observação opcional mantém a identidade desconhecida e não repete o
heartbeat nem apaga o resultado registrado da tentativa. A publicação continua
limitada a 4 KiB; o banco mantém o limite anterior de 2 MiB.

O status privado tem `last_loaded_identity`. Um leitor protegido compara
boot/invocação/PID/intervalo monotônico com o systemd para o mesmo ciclo já
concluído e exige fingerprint e bindings revisados. Não afirma que o processo
continua vivo. O projetor sanitizado do
[candidato de reparo](../../component-repair-candidate/README.md) exclui PID,
IDs brutos e detalhes privados. Prova owner-only em ciclo natural não ativa
ferramenta MCP nem comprova execução da Eva, saúde global ou restauração.

Os 21 testes públicos cobrem também identidade do código em memória,
constantes, vínculo com amostra, singleton, compatibilidade, reinício e
falha opcional de armazenamento. Instalação/reversão foram exercitadas em
fixtures separadas. Não execute o sender para validar essas propriedades:
aguarde o timer existente e confira o resultado posterior à instalação.
