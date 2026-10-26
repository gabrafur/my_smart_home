# Node-RED completo e diagnóstico fixo Kia pelo MCP

Referência pública desarmada da extensão somente leitura. O escopo inclui todos
os fluxos e nós Node-RED do Raspberry, não apenas Kia: inventário, conexões e
conteúdo que corresponda à revisão pública aprovada. A referência de capacidade
usou 3885 nós públicos; o escopo previsto abrange os 31 fluxos observados, sem
fixar esse número como limite. O diagnóstico Kia é uma segunda raiz fechada,
sem leitura de estados do veículo, localização, comandos, assinaturas ou testes
domésticos.

Em 26/10/2026, o cliente MCP real paginou os 31 fluxos e recebeu código e conexões de um Function node de observacao_host, além dos recibos fixos Kia. Esse aceite é do contrato autenticado; não comprova uma execução autônoma específica da Eva.

As fontes refletem a preparação e correções revisadas. Não afirmam por si que o
cliente MCP recebeu os resultados ou que cada byte está carregado em produção.
`SOURCE-MAP.json` distingue fonte preparada e exportação. O pacote anterior e
seus recibos devem ser preservados; não reaplicar uma instalação já consumida.

## Arquivos e segurança da exportação

`collector.cjs` tem destino `UNBOUND_NODERED_HOST`; as units mantêm deny-all e
somente localhost. Conta do serviço/socket é placeholder. Isso exige binding
privado específico antes de ativar comunicação com o Node-RED. Não substituir
por rede bridge inteira ou regras amplas. Em rede Docker/NAT, o pacote privado
pode precisar permitir também o peer exato de retorno do mesmo componente;
inspecionar e validar sua identidade antes de conceder essa exceção.

`root_snapshot.py` tem `PUBLIC_EXPORT_UNARMED=True`: a entrada root recusa
coleta manual. O marcador de revogação é verificado antes desse bloqueio para
manter o caso de teste de revogação. O instalador e a recuperação de rede têm
prazo/pins zero e staging substituído. Não contêm manifesto, config, políticas,
credenciais, recibos, intents, backups ou bindings operacionais reais. Não copiar
sobre arquivos root ativos. Não há comando executável de ativação neste pacote.

O `install.template.py` contém uma adaptação de referência explícita: ao criar
um novo diretório de código root, aplica chmod 0755 antes de validar o modo pelo
helper selado, evitando redução para 0750 por umask. Essa mudança é identificada
no mapa e não é apresentada como os bytes do instalador histórico executado.
Não altera modos de diretórios existentes silenciosamente.

## Usar com Eva ou outro chatbot

Conectar ao transporte MCP autenticado existente, descobrir os nomes efetivos
em `tools/list` e usar as ferramentas já disponíveis. Nenhuma ferramenta nova,
shell, comando livre, URL, path ou entidade arbitrária é exposto.

1. Chamar `project_files` com `{"host":"raspberry","category":"nodered","offset":0}`.
   Os dois registros virtuais são acrescentados à primeira página do catálogo
   estático. `pagination_semantics` esclarece que o offset do catálogo estático
   não é uma posição do inventário runtime. Falha aparece em
   `runtime_observation.collection_error` e `reason_code`; não significa ausência.
2. Ler um `file_id` retornado usando `project_read` com
   `{"host":"raspberry","file_id":"<ID opaco de 32 hex>","offset":0}`.
   `text` contém um pedaço do documento JSON, de até 4000 caracteres. Continuar
   com o `next_offset` retornado e concatenar os pedaços antes de interpretar JSON.
3. A raiz Node-RED inclui links em `resources`. Seus `resource_id` são usados
   como `file_id` na mesma ferramenta. Há inventário de fluxos, páginas por fluxo
   e uma raiz global que inclui nós de configuração. Páginas indicam continuação
   por `next_page`; nós oferecem `metadata`, `parameters` e `source`. Fontes têm
   continuação explícita `next_source_chunk`, já sanitizada integralmente.
4. Usar somente IDs descobertos; `runtime://...` é um rótulo virtual retornado,
   não URL HTTP, path de filesystem ou link de abertura. Não inventar URLs.

Os documentos têm origem, timestamp, idade, erro de coleta, cobertura, snapshot
opaco e paginação. A ordenação do inventário é por ID, não por uma atividade
inventada. `metadata` mostra IDs/tipos/conexões válidos; títulos só aparecem se
iguais à revisão pública aprovada. Configuração/código são comparados por campo;
divergências são omitidas com `redacted_fields` e motivo. Hashes de código, quando
presentes, declaram base no conteúdo público sanitizado; não são prova de
identidade do código executado nem fingerprints de valores privados divergentes.
A correspondência pública é parcial por desenho, não aprovação de todo arquivo.

O cliente Python valida proprietário/modo do inode Unix e o peer previsto:
root/systemd cria o listener frio; o processo Node nativo pode renovar a
identidade do listener aquecido. Os UIDs 0/1001 são bindings desta referência,
não uma regra portátil para qualquer conta. Não remover verificações de peer
para fazer outro host funcionar. Erros retornam somente códigos allowlisted,
sem exceções, logs, respostas brutas ou credenciais.

## Validade dos IDs e limites reais

O cache do modelo vence em no máximo 120 segundos desde a observação; uma nova
coleta usa nonce/timestamp novo. Há um snapshot, entrada runtime+revisada de no
máximo 8 MiB, 32 documentos em cache, 4096 descritores e 64 KiB por documento.
Páginas têm até 16 itens. Fontes são materializadas sob demanda em blocos de até
4096 caracteres; leitura MCP transmite o JSON em blocos de 4000. Limites causam
erros explícitos, sem descartar registros silenciosamente.

O daemon atual encerra após **30 segundos ocioso**, antes do TTL máximo de 120s,
e a unit tem RuntimeMaxSec=300. O cache da descoberta pode ser reutilizado por
até 90 segundos. Reinício, idle ou coleta nova podem invalidar IDs anteriores.
Após `snapshot_unavailable`/`resource_unavailable`, redescobrir pelo catálogo e
reiniciar a leitura do novo documento; não misturar pedaços de snapshots distintos.
Terminar uma cadeia de leituras sem pausas superiores ao idle. Isso é uma
limitação real do lifecycle, não promessa de IDs persistentes por 120 segundos.

## Diagnóstico fixo Kia e limites de evidência

A segunda raiz combina projeções sanitizadas de recibos fixos, pendências,
agendamento carregado, TZ configurado do contêiner, manifesto do loader HA e um
sensor fixo da integração. O produtor root lê somente o recibo privado fixo e
metadados Docker necessários; o processo Node não recebe o socket Docker nem
acesso ao arquivo privado root/0600. As demais fontes permitidas são filtradas
por modelos fechados antes de exportar.

O manifesto pode vir do cache do loader ou carregar a definição; não atesta
objetos Python carregados. O sensor é derivado de storage e não prova lifecycle
do worker/promoção. Data ausente, conflitante, inválida ou falha de coleta mantém
incerteza. Ausência de notificação não significa recuperação; sucesso em um
estágio não prova publicação, backup externo ou restauração. Nenhuma consulta
confirma execução da Eva, instalação de atualização ou saúde funcional geral.

## Preparação em outro host e revogação

Preparar em diretório privado fora do Git e modo0700, conferindo fontes atuais,
modos/owners, APIs, versão Node/Python e baseline. Vincular em pacote privado:

- Conta/UID do serviço/socket, grupo, paths fixos, Node-RED e seu peer exato;
  commit público previamente revisado e selado em `approved_public_head`.
- Credenciais existentes por `LoadCredential` e identidade HA existente. Não
  criar ou publicar credenciais. A sessão curta Node-RED solicita scope read,
  consulta só `/flows` e `/settings`, e tenta revogar o token; revogação incerta
  descarta dados e não repete a operação automaticamente.
- Helper root já auditado, sua cadeia de hashes, políticas privadas preservadas,
  manifesto before/after, staging, backup e validade de instalação autorizada.
  Atualizar todos os pins dependentes sem enfraquecer integridade. A exposição
  readonly até revogação é uma decisão separada do prazo administrativo de
  instalação/execução; não renova a autoridade administrativa da Eva.
- Sandbox da unit: manter `ExecStartPre=!`, capabilities vazias, proteções de
  filesystem/kernel, aliases fixos e limites de memória/CPU. `+` mudaria o modelo
  de sandbox e não é equivalente. Socket Docker montado readonly continua sendo
  API privilegiada: somente código root selado usa a rota fixa autorizada.

Revisar diff, efeitos, destinatário, validade, limites, rede e revogação antes de
ativar ampliação. O pacote requer daemon-reload e ativação do socket diagnóstico,
sem restart de HA/Node-RED ou comandos domésticos. Um erro de coleção não autoriza
reinício de componentes. Aprovação de instalação não prova leitura pelo cliente.
Depois de ativar, verificar descoberta e leitura real dos dois documentos via
MCP, sanitização, paginação e diagnóstico de falha, preservando recibos.

Revogar pelo marcador fixo `/var/lib/raspberry-nodered-diagnostics/revoked` e
parar/desabilitar socket/serviço diagnóstico conforme a decisão administrativa;
preservar históricos e credenciais. A verificação ocorre antes de retornar cache.
Restaurar somente backups e hashes conhecidos do pacote correto; intents incertos
não permitem repetir ativação ou recuperação. Os templates não são mecanismo de
recuperação geral de outro host.

## Testes e capacidade

A exportação contém 18 casos Python e 52 casos Node lógicos: 24 modelo/recursos,
9 coletor Node-RED (inclui deadline absoluto), 6 coletor HA e 13 projeção Kia.
O último usa runner próprio de asserts; a contagem de subtests TAP pode diferir.
`candidate.test.mjs` executa Python e arquivos Node serialmente. Não há tráfego
real, credenciais reais, root ou dispositivos nesses testes.

```sh
node --test scripts/raspberry-mcp/nodered-readonly-candidate/candidate.test.mjs
```

Os testes não foram executados durante esta preparação da exportação. A prova de
capacidade anterior, em processo isolado com heap128MiB, usou o arquivo público
como runtime/revisão: 4.534.284 bytes combinados, raiz e primeira página completas
em chunks4000 e uma única fonte Function. Durou cerca de1,81s, com pico RSS152,1MiB;
isso não comprova memória total do daemon em produção nem acesso real da Eva.
