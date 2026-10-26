# Diagnóstico candidato de integridade offsite

Somente projeção pura do envelope de erro sanitizado do filho. Não baixa,
abre backup, lê chave, descriptografa, extrai arquivo, executa conteúdo,
controla serviço ou registra ferramenta MCP. Ainda não está integrado a um
verificador de produção.

O verificador anterior registrava a razão segura do download, mas descartava
o envelope seguro do filho de autenticação. A causa daquela falha continua
desconhecida. Este parser não recupera dados antigos, não altera recibos e não
autoriza repetir uma operação consumida, mesmo com outro ID.

Para uma próxima verificação legítima de um novo artefato natural, integrar
`project(stdout, returncode)` somente à etapa de autenticação, depois de
confirmar a identidade do filho. Não aplicar ao stdout da leitura da chave.
A forma esperada tem somente authenticated, error, exception_kind,
raw_error_withheld e automatic_retry. O envelope limita-se a 2 KiB; campos,
razões e classes não revisados são ocultados ou recusados. Nenhum texto bruto
é devolvido. Sinal de término não é classificado como timeout, OOM ou chave
inválida sem evidência.

Os seis testes usam somente bytes sintéticos. Não comprovam autenticação de
backup real, upload, integridade ou recuperação dos serviços. Os limites de
tamanho e os gates criptográficos existentes não foram alterados. Antes de
nova operação, preservar as evidências do ciclo natural, revisar a integração,
limites, identidade do novo artefato e limpeza, com idempotência e sem retry
incerto. A operação histórica consumida permanece encerrada.
