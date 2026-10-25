# Diagnóstico do heartbeat externo

Estas fontes são uma cópia auditável do emissor instalado. Não incluem a
credencial, banco, status operacional ou autorização de execução. Os hashes e
destinos estão em [SOURCE-MAP.json](../SOURCE-MAP.json). Não executar o emissor
para testar: ele envia uma requisição real ao provedor.

O timer existente executa uma tentativa por minuto. Antes da rede, o emissor
persiste uma intenção; resultados incertos não são repetidos. HTTP 200 com
resposta `OK` comprova aceite pelo provedor, sem comprovar entrega de e-mail,
execução da Eva ou saúde dos serviços residenciais.

A versão diagnóstica 2 grava a categoria de falha e o resultado na mesma
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
hashes, instalar `history.py` antes de `heartbeat.py` como root:root/0644 e
preservar os demais arquivos, credenciais, timer, banco e intenções. O próximo
ciclo natural carrega o código; não é necessário reiniciar serviços. A reversão
restaura somente os dois módulos anteriores, preservando o banco e a tabela
adicional. Não executar a instalação de uma nova assinatura para atualizar
essa instrumentação.

Teste isolado, sem rede ou dispositivo:

```sh
python3 -I -S -B scripts/raspberry-mcp/runtime-source/host-heartbeat/test_diagnostics.py
```

O teste também participa de `make validate-public` pelo runner Node.js. Ele
cobre falha antiga seguida de sucesso, falha posterior, migração, tentativa
inacabada, atomicidade, categoria inválida, retenção e ausência de dados privados.
