# Integracao Moni Mobile / Intelbras

Hoje a central em `alarmsystem.dyndns.biz:7000` aceita conexao TCP, mas nao respondeu a HTTP nem TLS. Isso indica que o aplicativo Moni Mobile provavelmente usa um protocolo TCP proprio.

Para integrar com o Home Assistant com controle real de zonas, armar e desarmar, o caminho confirmado e mapear o protocolo TCP proprietario do aplicativo.

## Credenciais

Guarde as credenciais em `homeassistant/secrets.yaml`. Esse arquivo ja fica fora do Git neste repositorio.

Use estes nomes:

```yaml
moni_mobile_host: alarmsystem.dyndns.biz
moni_mobile_port: 7000
moni_mobile_username: "SEU_USUARIO_DO_MONI_MOBILE"
moni_mobile_app_password: "SUA_SENHA_DO_APLICATIVO"
moni_mobile_alarm_code: "SENHA_PARA_ARMAR_DESARMAR_A_CENTRAL"
```

Nao coloque essas senhas em `configuration.yaml`, `packages/*.yaml`, `docker-compose.yml` ou neste documento.

## Capturar o protocolo

1. Descubra o IP local do servidor onde este Docker roda.
2. Inicie o proxy:

   ```bash
   python3 tools/moni_mobile_proxy/moni_proxy.py --listen-port 17000
   ```

3. No Moni Mobile, altere temporariamente o endereco da central para o IP local do servidor e a porta para `17000`.
4. Use o app nesta ordem:

   - entrar com usuario e senha;
   - abrir a tela de zonas;
   - armar;
   - desarmar.

5. Pare o proxy com `Ctrl+C`.

Os logs ficam em `.local-secrets/moni-captures/`. Eles podem conter usuario, senha e eventos da central, por isso essa pasta fica fora do Git.

## Captura mantendo o endereco original

Se o app mostra `Nao comunicado` quando o endereco e trocado para o IP local, teste mantendo o app configurado com `alarmsystem.dyndns.biz:7000` e usando DNS local para apontar esse nome ao proxy.

Em um terminal, suba o proxy na porta original:

```bash
python3 tools/moni_mobile_proxy/moni_proxy.py --listen-port 7000
```

Em outro terminal, suba o DNS temporario:

```bash
python3 tools/moni_mobile_proxy/moni_dns_override.py --ip 192.168.0.205
```

No iPhone, na rede Wi-Fi atual:

1. Abra os detalhes da rede Wi-Fi.
2. Em DNS, escolha configuracao manual.
3. Remova servidores existentes temporariamente.
4. Adicione `192.168.0.205`.
5. No Moni Mobile, deixe o endereco como `alarmsystem.dyndns.biz` e a porta como `7000`.

Ao terminar o teste, volte o DNS do iPhone para automatico.

## Captura confirmada

Em 2026-07-05, a captura com DNS local funcionou. O iPhone conectou no proxy usando o endereco original `alarmsystem.dyndns.biz:7000`.

Padroes observados:

- consulta/atualizacao periodica: `A16 C16 A32 C16 A16 C208 A16`;
- eventos confirmados pelo usuario:
  - `00:48:24` UTC: comando de armar;
  - `00:48:30` UTC: atualizacao de estado depois de armar;
  - `00:48:44` UTC: comando de desarmar;
  - `00:48:49` UTC: atualizacao de estado depois de desarmar.

O conteudo dos pacotes muda a cada sessao e parece criptografado/dinamico. Portanto, nao basta copiar um pacote capturado e reenviar pelo Home Assistant.

## Descobertas tecnicas

- A porta publica `7000` aceita TCP proprietario do Moni Mobile.
- HTTP/HTTPS nao respondeu nas portas testadas, entao a API REST moderna do Moni nao parece exposta nesse endereco.
- Os executaveis oficiais do Moni foram extraidos para analise local em `.local-secrets/moni-extract/`.
- O pacote .NET do Moni possui endpoints como `api/auth`, `api/alarm-centrals` e `api/integration-commands`, mas eles dependem de uma porta/API que nao esta disponivel no host publico atual.
- O protocolo GPRS interno usa AES-ECB com chave fixa, mas essa chave nao descriptografa o trafego do app Moni Mobile.
- O app/servidor Delphi tem uma camada `TMBConnection`/`TCMClient` com token, tamanho de mensagens e comandos como `TCACommandSendArm` e `TCACommandSendDisarm`.
- A DLL `GenerateAuthData.dll` foi analisada e descartada para este fluxo: ela gera autenticacao de push/Firebase, nao o pacote TCP de armar/desarmar.
- O protocolo Moni Mobile do app tambem usa AES-ECB com PKCS7, mas com a chave fixa da classe `TMBConnection`.
- O handshake usa um token de 2 bytes devolvido pelo servidor. Cada comando precisa montar o pacote autenticado com esse token atual.
- A consulta periodica `00c9` retorna o resumo de zonas/particoes. Os bytes de particao observados usam `2` para desarmado e `3` para armado.

## Integracao no Home Assistant

A estrutura da integracao customizada foi instalada em:

- `homeassistant/custom_components/moni_mobile/`
- `homeassistant/packages/moni_mobile_alarm.yaml`
- `homeassistant/tools/moni_mobile_alarm.py`

Isso cria a plataforma `alarm_control_panel` `moni_mobile`, carregada pelo package com os dados vindos de `secrets.yaml`.

Os comandos de armar/desarmar e a leitura de estado foram implementados no cliente TCP.

O teste de conectividade TCP via helper funcionou:

```bash
PYTHONPATH=/tmp/codex-moni-deps python3 homeassistant/tools/moni_mobile_alarm.py probe --timeout 5
```

Resultados validados:

- `state`: retornou `disarmed`;
- `disarm`: comando aceito e estado final `disarmed`;
- sequencia controlada `arm_away -> state -> disarm`: `arm_away` confirmou `armed_away`, `disarm` foi aceito, e a leitura posterior voltou para `disarmed`.

## Proximos passos

Pendencias pequenas:

1. A entidade pode ficar `unknown` por alguns segundos logo apos um comando, enquanto o servidor atualiza o resumo. Isso e esperado nesta integracao (poll periodico + protocolo TCP proprietario); o flow `iluminacao_externa` (`nodered/flows.json`, node `Somente se alarme mudou`) ja trata esse `unknown` como glitch e ignora, usando o ultimo estado real conhecido para decidir se houve mudanca de fato. Ver detalhes em [ILUMINACAO_EXTERNA_NODERED.md](ILUMINACAO_EXTERNA_NODERED.md).
2. Por seguranca, nao registrar payloads descriptografados em log, pois podem conter nomes, eventos e zonas.
3. Se a senha de arme/desarme tiver zeros a esquerda, mantenha-a entre aspas em `secrets.yaml`; a integracao tambem tenta preservar o valor bruto do arquivo para evitar perda desses zeros.
