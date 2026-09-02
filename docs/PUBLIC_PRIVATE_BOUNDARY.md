# Fronteira pública e privada

[Português (principal)](PUBLIC_PRIVATE_BOUNDARY.md) · [English](PUBLIC_PRIVATE_BOUNDARY.en.md)

Esta fronteira permite restaurar a arquitetura pública sem acoplar a lógica a
uma residência específica.

## Arquivos e fluxo de configuração

| Tipo | Caminho | Git |
| --- | --- | --- |
| schema | `bindings/public-bindings.schema.json` | rastreado |
| exemplo sintético | `bindings/private-bindings.example.json` | rastreado |
| entidades e serviços reais | `bindings/private/private-bindings.json` | ignorado |
| tópicos MQTT reais | `bindings/private/node-red-bindings.json` | ignorado |

O Compose monta `bindings/private/` como `/run/private-bindings`, somente para
leitura, nos containers do Home Assistant e Node-RED. Nenhum binding depende de
`.storage`, altera registries ou migra `entity_id` automaticamente.

Mantenha os JSON privados com modo `0640` e configure
`PRIVATE_BINDINGS_GID` no `.env` com o GID proprietário desses arquivos. O
Node-RED recebe esse grupo suplementar somente para leitura. Se um documento
existir mas não puder ser lido ou contiver JSON inválido, o runtime agora falha
explicitamente no startup em vez de iniciar com tópicos MQTT literais/inativos.

Valide o exemplo público ou um arquivo privado sem imprimir valores:

```bash
node scripts/public-bindings-check.mjs
node scripts/public-bindings-check.mjs --private bindings/private/private-bindings.json
```

Os campos `entities`, `services`, `topics` e `mqtt_topics` são opcionais por
papel. Entidades exigem um alvo; serviços exigem um serviço alvo; tópicos MQTT
podem ser strings quando o próprio fluxo define o payload, ou objetos com
`topic`, `payload_on` e `payload_off` quando o binding também define o comando.
O carregador do Node-RED normaliza strings para `{ topic }`. O exemplo público
contém todos os oito papéis obrigatórios.

## Consumo pelo Home Assistant

`homeassistant/custom_components/public_bindings` lê o arquivo privado e:

- projeta estados em IDs públicos baseados em papel;
- copia somente atributos explicitamente allowlisted;
- normaliza presença e estados booleanos quando configurado;
- encaminha ações allowlisted pelo serviço `public_bindings.call`.

Aliases públicos de `device_tracker` devem usar `state_mode: passthrough`. Isso
preserva estados de zonas nomeadas, como `chegando`; `home_away` reduziria essas
zonas a `not_home`. Os atributos de localização necessários por automações
(`latitude`, `longitude`, `gps_accuracy` e `source_type`) também precisam estar
na allowlist do binding privado. Os valores continuam apenas no runtime e não
são versionados.

Quando uma pessoa possui mais de uma fonte GPS, o binding consolidado usa
`target_entity_ids` com `selection_mode: best_location`. A escolha segue o
mesmo contrato de `localizacao_pessoas`: prefere fonte atual, coordenadas
confiáveis, atualização materialmente mais recente e melhor precisão. Cada
entidade `person` privada deve apontar somente para o tracker público
consolidado do respectivo papel.

O painel nativo Mapa omite entidades cujo estado atual é `home`. Por isso, o
arquivo YAML `dashboards/location.yaml` usa um card `map` com `show_all: true`:
ele inclui automaticamente toda entidade atual ou futura que exponha uma
localização numérica, inclusive em casa. Os nomes de exibição e os rótulos
públicos das fontes ficam no binding privado; o veículo é exibido como
`Creta`.

Bindings de localização podem declarar `source_names`, na mesma ordem dos
alvos. O adapter publica apenas o rótulo vencedor em
`selected_location_source` e uma lista sanitizada `location_sources` com o
rótulo, o último heartbeat real e a última observação de localização de cada
fonte. O adapter mantém `location_observed_at` separado de
`source_reported_at`: mudanças de bateria ou outros metadados podem provar que
a fonte ainda reporta, mas não renovam uma posição GPS. O heartbeat original é
propagado através de aliases intermediários, em vez de ser substituído pelo
horário de republicação no startup. Na inicialização, o horário GPS é recuperado do
histórico do Recorder comparando somente estado, coordenadas e precisão. Dois
cards Markdown dinâmicos mostram essas informações sem expor IDs privados.

Bindings consolidados usam `hide_targets: true` para ocultar da descoberta
visual somente os trackers privados que alimentam o consolidado. Eles continuam
ativos e disponíveis para o adapter e para o Node-RED, mas não viram marcadores
duplicados. Um terceiro card dinâmico preserva o estado `home`, `not_home`,
`chegando` ou qualquer zona atual. Entidades novas com coordenadas continuam
entrando automaticamente no mapa por `show_all`.

Todos os bindings de `vehicle_primary` também usam `hide_targets: true`. Assim,
as entidades nativas do Bluelink continuam ativas como alvos internos, enquanto
somente os aliases públicos do veículo aparecem na descoberta visual, sem pares
duplicados como `creta_*` e `vehicle_primary_*`.
Um binding usado somente para resolver uma ação pode declarar
`expose_state: false`: seu ID público continua disponível internamente para
`target_public_entity_id`, mas não cria um segundo botão visível. O refresh do
veículo usa esse modo; a interface exibe somente o `input_button` que entra no
coordenador único.

O componente `consolidated_map` aplica o mesmo arquivo YAML ao dashboard nativo
`/map` durante a inicialização, de forma idempotente. O arquivo não é registrado
como outro painel lateral: a aba nativa Mapa é a única interface exposta e não
implementa outra seleção de fontes.

Os aliases intermediários consumidos por `localizacao_pessoas` mantêm
`latitude`, `longitude` e `gps_accuracy` em `string_attributes`. O Node-RED os
normaliza explicitamente com `Number(...)`, mas o frontend do Mapa aceita como
localização apenas coordenadas numéricas. Isso impede que Mobile App e iCloud
apareçam como marcadores adicionais sem retirar os dados do normalizador. O
normalizador usa `location_observed_at`, e nunca o `last_updated` genérico, para
decidir freshness e precedência entre as fontes. O heartbeat é usado
separadamente para reconhecer fontes ativas e estacionárias, sem liberar
automação de chegada com localização antiga.

Uma ação pode apontar diretamente para `target_entity_id` ou reutilizar uma
entidade do mesmo papel por `target_public_entity_id`. A segunda forma mantém o
alvo privado em um único binding e é adequada para pares seguros como
`switch.turn_on` / `switch.turn_off`.

Pushes simples usam `notify.send_message` com uma entidade `notify.*`. O schema
desse serviço aceita apenas título e mensagem. Botões, tags e
`clear_notification` usam a ação lógica `notify_actionable`, cujo alvo privado
é o serviço legado específico do Mobile App; somente essa ação pode usar um
`notify.mobile_app_*`. Assim os parâmetros móveis permanecem funcionais sem
expor o nome privado do serviço nos flows.

Arquivo ausente, versão inválida, papel desabilitado ou ação não configurada
resultam em ausência de proxy/ação. O adapter falha fechado e não revela o alvo
privado em atributos públicos.

## Consumo pelo Node-RED

`nodered/settings.js` mescla os documentos JSON do diretório privado no contexto
global `publicBindings`. Functions de portão, iluminação e notificações consultam
esse contexto; nós MQTT estáticos recebem apenas variáveis derivadas dos
bindings. Binding ausente bloqueia o comando ou deixa o nó sem tópico real,
preservando degradação segura.

No editor autenticado, `nodered/tools/nodes/private-flow-labels.*` projeta os
`source_alias` privados nos cabeçalhos dos dois nós que notificam aproximação
entre residentes. A projeção é somente visual, tem resposta `no-store` e não
altera o modelo do editor: `nodered/flows.json`, exports e deploys continuam
contendo apenas `resident_primary` e `resident_secondary`. Sem os dois aliases,
os rótulos públicos permanecem inalterados.

## Bootstrap e restauração

1. Execute `make bootstrap-test` e, quando autorizado, `make bootstrap`.
2. Substitua somente os placeholders pelos alvos da instalação.
3. Mantenha os arquivos em `0640`, ajuste `PRIVATE_BINDINGS_GID` e confirme que
   continuam ignorados.
4. Execute o checker privado e os scanners públicos.
5. Use `restore/private-state-manifest.yaml` como autoridade para o backup
   privado e valide bundles com `restore-verify`.
6. Valide Compose com `.env.example` e `config --quiet`.
7. Faça a ativação operacional separadamente, com aprovação local e rollback.

Módulos opcionais podem permanecer `enabled: false` ou sem binding. A lógica
pública não presume que veículo, segundo morador, portão ou iluminação estejam
disponíveis.

O contrato completo está em [RESTORE_CONTRACT.md](RESTORE_CONTRACT.md), e a
seleção de módulos em [BOOTSTRAP_DEMO.md](BOOTSTRAP_DEMO.md).

## Compatibilidade e futura renomeação

Bindings preservam os IDs reais existentes e evitam alterações automáticas em
registries. Uma futura migração física de entidades é um projeto separado e deve
conter inventário de consumidores, ordem de mudança, backup, rollback, testes
antes/depois, riscos de indisponibilidade e aprovação presencial. Esta etapa não
executa essa migração.

## Limitações

- O schema valida forma e papéis, não a existência do alvo na instalação.
- Atualizar um binding exige validação e ativação operacional explícitas.
- O proxy do Home Assistant é de runtime; ele não renomeia nem recria entradas
  no entity registry.
- Arquivos privados devem ser incluídos no backup privado da instalação; eles
  nunca fazem parte do pacote público.
