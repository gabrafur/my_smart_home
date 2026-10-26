# Verificação criptográfica e transporte de stdin

Snapshot auditado de uma recuperação preparada. Não está registrado como
ferramenta MCP nem autoriza download, chave, conta, sudo ou implantação.
Identidades, recibos, caminhos operacionais e metadados do artefato foram
substituídos por bindings e fixtures. Não instalar esse snapshot sobre código
ou políticas vigentes. SOURCE-MAP.json informa hashes de origem/exportação.

Uma tentativa real transferiu o ciphertext e terminou antes de autenticar:
`credential_input_limit`. Seu `docker create` não habilitava stdin. O processo
recebia zero bytes mesmo com `docker start --attach --interactive`. A falha
não comprova corrupção ou chave inválida; a causa de uma falha histórica cujo
motivo não foi retido continua desconhecida.

A correção inclui `--interactive` no create e confere `OpenStdin=true`,
`Tty=false` e UID não root antes de pedir a chave. O leitor exige esse marcador.
A chave existente segue somente por pipe privado/memória/stdin. Nenhuma
credencial em argv, env, arquivo, log ou recibo; nenhum Docker root exec.

O gate de recuperação aceita somente a falha anterior comprovada antes da
criptografia, com limpeza confirmada, hashes de código/recibos preservados e
mesmo ID. Uma exceção explícita pode permitir uma leitura adicional do arquivo
e da chave. Sem aprovação root vinculada ao manifesto, não há nova execução.
Não troca ID, zera contador, remove intent ou repete efeito incerto. O novo
ciphertext deve corresponder ao hash já verificado. O resultado adicional fica
em sidecar, preservando o recibo original. Sem reinício ou controle de serviços.

Os testes públicos são offline: `make validate-dependencies` e as dependências
Node-RED existentes precedem `node --test --test-concurrency=1
scripts/raspberry-mcp/offsite-stdin-transport.test.mjs`. Cobrem 33 casos Python e
10 casos de seleção. Não precisam de Docker, HA, chave, arquivo real ou rede.

`test_crypto.py` e os scripts em `integration/` são somente para uma execução
isolada explicitamente preparada pelo operador com a imagem local revisada e
bindings de teste. Não fazem parte da validação pública automática. Reproduzem
stdin fechado/aberto, autenticação securetarv3 de fixture e o `main` do parent
real com portas sintéticas de download/chave. Contêineres: UID não root, rede
none, capabilities vazias, no-new-privileges, filesystem read-only e limites de
CPU/processos. Mounts apenas de código revisado e fixtures. Não montar dados de
produção para testar transporte nem provocar falha com credencial real.

Os testes de transporte e criptografia sintéticos passaram na imagem revisada;
a autenticação do arquivo real continua sem comprovação. Aceite exige o
resultado real do fluxo completo, limpeza e recibo. Mesmo uma autenticação GCM
integral não comprova recuperação funcional dos serviços. Status healthy,
reinício bem-sucedido e restauração de arquivos são provas de escopos distintos.

Para outros chatbots, usar o MCP já documentado em
[RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md](../../../../docs/RASPBERRY_MCP_ADMIN_AND_PORTABILITY.md).
Este diretório não cria API de shell, caminhos livres ou autorização geral.
