# Reautenticação manual do iCloud

[Português (principal)](ICLOUD_MANUAL_AUTH.md) · [English](ICLOUD_MANUAL_AUTH.en.md)

`homeassistant/custom_components/icloud/` adapta a integração nativa, preservando
seu domínio, config entry, serviços, plataformas e armazenamento de sessão em
`/config/.storage/icloud`. Não cria outra conta nem substitui dados do usuário.

Inicialização e polling só podem reutilizar a sessão salva. Login com credenciais,
renovação que exija autenticação e envio de código precisam de submissão explícita.
O cliente usa `pause_2fa=True` e bloqueia `request_2fa_code()` automático, inclusive
quando a biblioteca tenta esse fallback. Abrir um formulário, restaurar a entrada
ou informar um código inválido não solicita outro OTP.

Falhas tipadas de transporte que chegam ao setup, incluindo DNS, conexão e timeout
encapsulados, viram `ConfigEntryNotReady` para o backoff do Home Assistant. Erros
sem causa de transporte não são classificados pelo texto da mensagem. O retry
não autoriza login nem envio de código. Falha ao carregar a proteção persistida
interrompe o setup antes de criar um cliente.

Quando for necessário reautenticar:

1. Abra **Configurações → Dispositivos e serviços → Apple iCloud → Reautenticar**.
   Abrir o reparo apenas mostra o formulário.
2. Envie o formulário de reautenticação para preparar a sessão. Essa etapa carrega
   o contexto do desafio, mas não envia código automaticamente.
3. Quando houver um desafio disponível, escolha **Solicitar um novo código de
   verificação** e envie uma única vez. Na modalidade 2SA, selecione explicitamente
   o dispositivo confiável apresentado pelo fluxo.
4. Somente após confirmação do envio, informe o código no formulário correspondente.
   O formulário já não oferece uma nova solicitação durante esse desafio.

Código vazio ou inválido não dispara outro envio. Em timeout ou resultado de
entrega desconhecido, o estado persistido bloqueia repetição, inclusive após
reinício: reconcilie o resultado antes de tentar novamente. Formulários antigos
não podem atuar sobre uma entrada que já foi recarregada. Se o provedor exigir
chave de segurança ou não oferecer uma rota compatível, não há garantia de OTP.

O fluxo só conclui a reautenticação depois do reload e da fase `entry_ready`.
Esse estado comprova prontidão local; não comprova sozinho sincronização recente
com a Apple. Sessões e tokens continuam sob armazenamento da biblioteca.

## Compatibilidade e manutenção

Compatibilidade revisada para Home Assistant Core 2026.10.1 e 2026.10.4, com pyicloud 2.7.0.
`manual_auth.ManualOtpService` é um nome de compatibilidade para `GuardedService`;
`config_flow.py` registra `ManualIcloudFlow`, implementado em `manual_flow.py`.
O adaptador substitui a fábrica de cliente em `account` e usa um fluxo local
protegido. Não troca a fábrica global do fluxo nativo. `auth_gate.py` mantém a
política persistida e `native_bridge.py` adapta as interfaces nativas.

As plataformas só são carregadas quando a sessão está pronta. Uma entrada
aguardando ação manual pode ser descarregada sem tentar remover plataformas que
não foram carregadas. As proteções locais não alteram arquivos da imagem nem
outros consumidores de pyicloud.

```sh
scripts/run-resource-safe.sh python3 -m unittest discover -s homeassistant/tests -p 'test_icloud*.py'
```

Os testes carregam o pacote local real com fronteiras HA/pyicloud simuladas e
bloqueiam sockets externos. Exercitam estado persistido, abertura sem efeito,
preparação sem envio, entrega única, código inválido, resultado incerto, wiring e
retry de transporte. Rodam no host sem instalar Home Assistant ou pyicloud e não
substituem a compatibilidade nativa: após atualizar versões, valide também na
imagem fixada, isolada, sem rede e sem mounts de dados privados.
A classe `NativeRuntimeContractTest` mantém os casos de compatibilidade real;
ela é pulada somente quando o runtime nativo não está instalado e deve ser
executada na imagem isolada, além dos casos simulados do host.

Recursos de interface e licença têm proveniência em `upstream.json` e
`LICENSE.upstream`. Uma implantação exige conferir hashes, guardar cópias
recuperáveis e reiniciar somente o Home Assistant quando necessário para carregar
o código aprovado. Rollback deve usar o pacote verificado da operação e preservar
`.storage`; não remova a integração como tentativa de renovar autenticação.

## Reinício seguro e botões manuais

Os cinco gatilhos `input_button` do Node-RED usam `ignorePrevStateNull: true`
e `outputInitially: false`. Restaurar uma entidade no início do Home Assistant
produz `old_state: null`; isso não é um clique. `ignorePrevStateUnknown: false`
preserva o primeiro clique real, pois um botão ainda não usado já existe com
estado `unknown`. A restauração nunca deve iniciar lock/unlock, refresh do
veículo, manutenção de armazenamento ou revisão documental.

As fontes geradoras mantêm esse contrato. Para reaplicá-lo sem reorganizar os
canvases, use `node nodered/tools/install-input-button-restoration-guards.mjs`,
seguido dos gates normais de observabilidade e layout. Execute
`node nodered/tools/test-input-button-restoration.mjs` para reproduzir três
restaurações, primeiro clique, duplicata, entidade alheia e desconexão no
controlador nativo instalado, sem chamar serviços nem dispositivos. Os testes
dry-run dos tabs cobrem o restante do caminho de decisão e a fronteira de efeitos.

## Verificação antes de atualizar a imagem

O atualizador executa `scripts/icloud-image-preflight.py` na imagem candidata
fixada por digest, antes de escrever o Compose ou recriar o Home Assistant.
O container transitório não tem rede, privilégios nem configuração residencial;
somente o verificador e `device_owner.py` são montados para leitura. O processo
também fixa limites próprios de memória virtual, CPU, arquivos e duração, pois
este host não oferece controle de memória por cgroup.

Uma versão não revisada, hash de construtor divergente, versão diferente de
pyicloud ou falha de coleta bloqueia a promoção. Não remover a allowlist para
aceitar automaticamente uma versão nova. O modo dry-run informa `not_checked`
e não inicia container nem comprova compatibilidade. Outros serviços não
precisam desse verificador específico do iCloud.

A revisão de 2026.10.4 comparou os 15 arquivos do diretório iCloud da imagem
com os blobs do commit oficial identificado em `upstream.json`; não houve
mudança nesse diretório desde a base revisada. O hash do construtor permanece
obrigatório. A provenance original de 2026.10.1 e a licença foram preservadas;
`validated_compatibility` registra a nova revisão sem reescrever essa base.

Depois de carregar o código, conferir prova nova do processo HA com nonce e
revisão correspondentes, `ha_running` e `manual_auth_guard_loaded`. Uma prova
anterior ao início do processo não serve. `entry_waiting_user` comprova a espera
protegida, e não sessão Apple pronta: o usuário ainda deve concluir a autenticação
manual no Home Assistant. Não enviar OTP por automação nem apagar `.storage`.
HTTP 200, carregamento do guard e sincronização remota são evidências distintas.


## Transporte da sessão salva e concorrência

A validação de token salvo preserva `probe_cached_session` ou `session_valid`
quando encontra uma falha de transporte tipada, inclusive encapsulada numa
exceção da API. A conversão ocorre antes do catch nativo que apagava essa causa.
Setup usa o backoff existente do HA; keep-alive aguarda seu próximo ciclo, sem
retry imediato. Não há login primário, renovação autenticada ou OTP nesse caminho.

O gate serializa a validação e oferece um snapshot sob lock para outros
consumidores. Uma validação concorrente adia o trabalho em vez de interpretar
o checkpoint temporário como sessão expirada. O contexto da própria validação
e a submissão manual não tentam adquirir novamente o mesmo lock.

Expiração real, desafio, causa desconhecida e entrega incerta continuam
bloqueados. Estados bloqueados de antes da correção não são reabertos. O teste
`test_icloud_cached_transport.py` cobre transporte encapsulado, recuperação no
próximo ciclo, expiração, concorrência e preservação do OTP manual. O modelo do
provider no teste público não substitui o ensaio isolado da biblioteca nativa.
Uma prova de código carregado confirma a versão; não comprova recuperação Apple.
