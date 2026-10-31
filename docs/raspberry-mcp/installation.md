# Instalação e conexão de clientes MCP

## Instalação da base e autenticação

Para uma instalação nova, revisar o [instalador da base](../../scripts/raspberry-mcp/install-local.py)
e o [procedimento histórico](reference/read-only-base.md#instalação-administrativa-local).
Ele prepara coletor, isolamento e socket; não instala todas as extensões atuais,
não configura o túnel nem concede o perfil administrativo. Não reaplicar esse
instalador sobre uma instalação ativa. As [fontes exportadas](../../scripts/raspberry-mcp/runtime-source/SOURCE-MAP.json)
documentam o código sanitizado, sem políticas ou bindings privados.

No socket local, a identidade Unix e suas permissões controlam acesso. No túnel
existente, a autenticação pertence ao transporte; uma opção de autenticação MCP
`None` nesse conector não significa endpoint público sem proteção. O gateway
opcional abaixo usa bearer local pré-configurado e não implementa OAuth. Confirmar
o mecanismo realmente aceito pelo cliente antes de provisionar qualquer acesso.

Inserir credenciais diretamente no armazenamento seguro do cliente/transporte.
Usar apenas marcadores como `<TOKEN_DO_CLIENTE>` na documentação; não enviar
tokens pelo chat, argumentos de processo, URL, Git ou logs. O processo MCP e o
cliente não precisam receber credenciais do executor, Docker ou sudo geral.
Preservar as confirmações da interface: elas são independentes dos gates locais.

## Instalar em outro cliente de IA

### Cliente com suporte a stdio no Raspberry

1. Confirmar suporte a MCP stdio e JSON Schema no cliente escolhido.
2. Dar ao processo de conexão uma identidade sem privilégios, autorizada apenas
   a conectar ao grupo do socket `raspberry-mcp`. Não conceder Docker, sudo geral,
   a identidade do tunnel-client ou leitura das suas credenciais.
3. Configurar o processo abaixo como servidor stdio. O formato do invólucro JSON
   depende do cliente; `mcpServers` é uma convenção comum, não uma chave universal.

```json
{
  "mcpServers": {
    "raspberry": {
      "command": "/usr/bin/python3",
      "args": ["-I", "-S", "-B", "/usr/local/lib/raspberry-mcp/relay.py"]
    }
  }
}
```

4. Iniciar `initialize`, enviar `notifications/initialized`, descobrir
   `tools/list` e testar `maintenance_capabilities` com `{"host":"raspberry"}`.
5. Confirmar a identidade autorizada e seguir o
   [aceite do novo cliente](operations.md#aceite-do-novo-cliente) antes de
   confiar correções ao novo cliente.

O relay não é servidor TCP e não recebe host, caminho ou comando do chatbot.
O cliente precisa conseguir iniciar esse processo no Raspberry. O processo de
conexão não precisa de privilégios administrativos; quem aplica a autoridade
aprovada é o executor local por trás do broker.

### Cliente em outra máquina

O socket Unix não é um endereço remoto. Usar um transporte autenticado que leve
o stdio até o relay no Raspberry. Uma implantação por SSH precisa de conta
dedicada, chave mantida exclusivamente no cliente, verificação da chave do host
e comando forçado exclusivamente para o relay, sem terminal, encaminhamentos
ou shell interativo. Não reutilizar a conta com sudo total para essa conexão.
O cadastro de uma nova chave deve ocorrer no servidor por administrador; não
copiar chaves privadas para este projeto ou para o chat.

Não foi instalado nem validado um novo acesso SSH para outro chatbot. O
transporte atual continua sendo o túnel já existente. A autenticação efetiva
desse túnel identifica o proprietário, não uma identidade criptograficamente
exclusiva do cliente MCP autorizado ou de cada chatbot que o proprietário habilitar.

### Cliente hospedado que aceita somente URL HTTP

O túnel OpenAI atual não é, por isso só, um endpoint Streamable HTTP genérico
para outro fornecedor. Não copiar seu endereço privado nem inventar uma URL.
Esse cliente precisará de um gateway MCP autenticado compatível com ele.
O pacote opcional [`portable-http`](../../scripts/raspberry-mcp/portable-http/gateway.py) implementa um gateway local autenticado. A inicialização,listagem das38ferramentas e leitura das capacidades passaram contra o socket real. Ele não foi ativado como serviço permanente e não comprova conexão com um fornecedor externo. O guia de preparação e ativação está abaixo.

Essa implantação deve validar TLS, identidade de acesso, Origin, limites,
revogação e encaminhamento ao mesmo socket sem acesso Docker ou credenciais
do executor. O gateway local usa uma única chave bearer por instância, sem
cadastro ou revogação individual de clientes. Se mais de um cliente compartilhar
a chave, sua rotação revoga todos os portadores. Identidade e revogação por
cliente exigem uma camada adicional revisada e aceita. Não expor o socket ou
um listener sem autenticação na internet.
O suporte de um fornecedor específico só pode ser declarado após teste nesse
cliente. A assinatura, disponibilidade e custo do cliente são independentes
das restrições de custo do executor do Raspberry.

## Preparar o transporte HTTP opcional

Este pacote estende o transporte de uma instalação MCP existente. Não instala
Docker,Codex,túnel,dependências NPM,assinatura ou uma concessão administrativa.
Usa somente a biblioteca padrão Python. Seu próprio processo não recebe sudo
ou acesso Docker. O endereço é fixo `127.0.0.1:8765/mcp` e é somente local;
não é uma URL que outro fornecedor hospedado consiga acessar pela internet.

Arquivos versionados:

- `scripts/raspberry-mcp/portable-http/gateway.py`: transporte;
- `scripts/raspberry-mcp/portable-http/install.py`: preparação root sem ativação;
- `scripts/raspberry-mcp/portable-http/release.json`: hashes dos arquivos;
- `scripts/raspberry-mcp/portable-http/raspberry-mcp-http.service`: unidade;
- `scripts/raspberry-mcp/portable-http/test_gateway.py`: testes isolados.

O administrador deve revisar esses arquivos e o manifesto,conferir o Git HEAD
e copiar o pacote para o staging root antes de executar. A instalação abaixo
cria uma identidade sem login e sem sudo,arquivos root e um token novo local.
A chave não é mostrada no terminal nem no recibo. Uma instalação anterior com
arquivos diferentes é recusada;revisar a atualização antes de substituir.

```sh
sudo /usr/bin/install -d -o root -g root -m 0755 /run/raspberry-mcp-http-review
sudo /usr/bin/install -o root -g root -m 0644 scripts/raspberry-mcp/portable-http/gateway.py scripts/raspberry-mcp/portable-http/install.py scripts/raspberry-mcp/portable-http/release.json scripts/raspberry-mcp/portable-http/raspberry-mcp-http.service /run/raspberry-mcp-http-review/
sudo /usr/bin/python3 -I -S -B /run/raspberry-mcp-http-review/install.py
```

Executar a partir da raiz do checkout revisado. Esses comandos exigem
administração local;nenhum deles solicita que uma senha seja armazenada ou
entregue ao chatbot. O recibo fica em
`/var/lib/raspberry-mcp-http/install.json` e deve indicar
`prepared_not_activated`. Não confundir preparação com serviço em execução.

Se houver necessidade de ativar o cliente local,validar a unidade e depois:

```sh
sudo /usr/bin/systemd-analyze verify /etc/systemd/system/raspberry-mcp-http.service
sudo /usr/bin/systemctl daemon-reload
sudo /usr/bin/systemctl enable --now raspberry-mcp-http.service
sudo /usr/bin/systemctl show raspberry-mcp-http.service --property=ActiveState,SubState,MainPID
```

A unidade exige o socket existente. Um erro de porta ocupada,permissão ou
isolamento deve ser corrigido pela causa;ela não tem reinício automático.
O instalador não executa esses comandos de ativação. Não habilitar dois
listeners sobre a mesma porta.

## Configurar um cliente HTTP compatível

No cliente local,cadastrar transporte Streamable HTTP,endpoint
`http://127.0.0.1:8765/mcp` e cabeçalho `Authorization: Bearer <TOKEN_DO_CLIENTE>`.
O marcador é exemplo,não uma credencial. O token está em
`/var/lib/raspberry-mcp-http/token`,root0440,legível apenas pelo grupo privado
do transporte. O operador deve transferi-lo diretamente ao armazenamento
seguro do cliente,sem chat,repositório,URL ou argumentos de processo.

Este adaptador usa bearer pré-configurado;não implementa um servidor OAuth.
Clientes que exigem descoberta OAuth ou acesso por navegador precisam de uma
camada de autenticação/TLS própria e não estão certificados por esse teste.
Cabeçalhos Origin de navegador são recusados. GET não oferece SSE e retorna405.

O cliente deve negociar `2025-06-18`,enviar Accept com `application/json` e
`text/event-stream`,guardar o `Mcp-Session-Id` devolvido e reenviá-lo com
`MCP-Protocol-Version` nas chamadas seguintes. Notificações retornam202 sem
corpo. Há uma sessão por vez para preservar capacidade do túnel existente;
uma sessão inativa por60s é encerrada. Uma nova sessão deve consultar os
mesmos IDs duráveis para recuperar resultados,sem repetir efeitos.

A desconexão ou DELETE encerra o transporte,sem cancelar o trabalho já aceito.
Resposta HTTP504 após encaminhamento significa resultado incerto:reconciliar
os IDs originais. O adaptador nunca tenta novamente automaticamente.

Para desativar somente este transporte:

```sh
sudo /usr/bin/systemctl disable --now raspberry-mcp-http.service
```

Isso preserva o MCP original,seus bancos e o túnel. Não apagar recibos nem
reutilizar IDs. Para rotação de chave, parar este transporte e substituir a chave
local por 32 bytes aleatórios representados por 64 caracteres hexadecimais
minúsculos, seguidos de uma única quebra de linha. Preservar arquivo regular,
proprietário root, grupo privado do transporte, modo 0440 e um único hard link.
Atualizar o armazenamento seguro dos clientes que continuarão autorizados e
iniciar novamente: a chave é lida somente na inicialização. Confirmar a recusa
da chave antiga e a aceitação da nova sem executar operações com efeito.
Remover a chave antiga dos clientes revogados. Não rotacionar a chave do túnel
por engano.

## Validar antes de confiar correções

```sh
./scripts/run-resource-safe.sh python3 -B -m unittest discover -s scripts/raspberry-mcp/portable-http -p 'test_*.py'
```

O teste isolado cobre autenticação,Origin,inicialização,notificação,listagem,
expiração,limites,versão,framing inválido,JSON ambíguo e timeout sem repetição.
Os testes de expiração administrativa adicionais executam o código capturado
com bindings sintéticos e recusam criação/envio/resume após o gate temporal.
No código instalado,uma simulação da falha temporal preservou o hash do banco
e o resultado terminal sem contatar o daemon;isso não é uma observação do
prazo real já transcorrido nem uma alteração do relógio de produção.
O aceite temporário contra o servidor real comprovou descoberta e capacidade
administrativa configurada. O aceite administrativo independente comprovou
UID0 no executor e deduplicação de criação/envio. Nenhum desses resultados
certifica uma nova conta de cliente,proxy externo ou outro chatbot ainda não
conectado. Registrar esse aceite quando o cliente escolhido estiver disponível.
