# Reautenticação manual do iCloud

[Português (principal)](ICLOUD_MANUAL_AUTH.md) · [English](ICLOUD_MANUAL_AUTH.en.md)

`homeassistant/custom_components/icloud/` é uma adaptação pequena da integração
nativa. Preserva domínio, config entry, serviços, plataformas e armazenamento
`/config/.storage/icloud`; não cria outra conta nem substitui os dados do usuário.
As plataformas e o fluxo original vêm do Home Assistant Core instalado.

Falhas de transporte na inicialização (incluindo DNS, conexão e timeout encapsulados
pelo pyicloud) viram `ConfigEntryNotReady`, para o Home Assistant repetir o setup
com seu backoff nativo. Erros de autenticação sem causa de transporte e erros de
programação continuam no caminho original; nenhum OTP é solicitado pelo retry.

Inicialização, renovação de sessão e falha de polling usam `pause_2fa=True`.
Como o fallback do pyicloud 2.7.0 ainda pode pedir um OTP quando o login com
token pausado falha, `ManualOtpService.request_2fa_code()` também bloqueia esse
envio. Não altera validade da autenticação, não aceita OTP automaticamente e
não declara uma sessão confiável sem a verificação da Apple.

Quando a Apple exigir nova autenticação, o reparo fica pendente. Abrir o reparo
ou informar um código inválido não envia outro código. Quando estiver pronto:

1. Abra **Configurações → Dispositivos e serviços → Apple iCloud → Reautenticar**
   ou o reparo correspondente.
2. Marque **Solicitar um novo código de verificação** e envie o formulário.
3. Informe o código recebido da Apple, deixando a opção de novo código desmarcada.

Só essa submissão explícita chama `request_manual_2fa_code()`. O fluxo legado
2SA mantém sua seleção explícita de dispositivo. Sessões e tokens confiáveis
continuam persistidos pela biblioteca; a Apple pode invalidá-los futuramente.

## Compatibilidade e manutenção

Compatibilidade verificada com Home Assistant Core 2026.10.1 e pyicloud 2.7.0.
A adaptação troca as fábricas de cliente nos módulos nativos `account`
e `config_flow`, registra uma subclasse do fluxo e envolve o setup nativo
para classificar falhas transitórias de transporte. Não modifica
arquivos do container nem aplica um patch global a outros consumidores pyicloud.
Após atualizar Core ou pyicloud, execute os testes dentro do container antes de
considerar o runtime validado. A dependência pyicloud permanece fixada no manifest.

Os recursos de interface foram extraídos da imagem oficial registrada em
`upstream.json`; os hashes registram os bytes anteriores às alterações locais.
O texto da etapa de verificação foi alterado em inglês e português; exemplos de
conta nos serviços usam o domínio reservado `example.invalid`.
`LICENSE.upstream` preserva Apache-2.0 do Home Assistant Core.

```sh
scripts/run-resource-safe.sh python3 -m unittest homeassistant.tests.test_icloud_manual_auth
scripts/run-resource-safe.sh docker exec -w /config homeassistant python tests/test_icloud_manual_auth.py
```

Os testes simulam falha, retry, envio manual e código inválido, sem contatar a
Apple nem gerar OTP. Para carregar a adaptação pela primeira vez, valide a
configuração e reinicie somente o Home Assistant; depois confira entidades,
Recorder e ausência de reparos inesperados. Para rollback, remova apenas a
adaptação local e reinicie o Home Assistant, preservando `.storage` e os registros.

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
