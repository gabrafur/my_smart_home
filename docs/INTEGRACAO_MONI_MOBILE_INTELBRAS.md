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

## Instalacao parcial no Home Assistant

Como `homeassistant/custom_components` esta sem permissao de escrita para o usuario atual, a instalacao foi feita via package:

- `homeassistant/packages/moni_mobile_alarm.yaml`
- `homeassistant/tools/moni_mobile_alarm.py`

Isso cria uma entidade template `alarm_control_panel.alarme_moni_mobile` e comandos shell para testar conexao, armar e desarmar.

Importante: os comandos de armar/desarmar ainda retornam erro proposital ate o pacote autenticado do Moni Mobile ser implementado. Isso evita marcar o alarme como armado/desarmado sem ter certeza de que a central aceitou o comando.

Para instalar uma integracao customizada completa depois, ajuste as permissoes:

```bash
sudo chown -R gabriel:gabriel /mnt/data/docker/homeassistant/custom_components
```

## Proximos passos

Para finalizar a integracao real:

1. Descobrir a funcao que gera o terceiro pacote do handshake Moni Mobile.
2. Implementar o cliente TCP em `homeassistant/tools/moni_mobile_alarm.py`.
3. Mover a entidade de package para `custom_components/moni_mobile` quando houver permissao de escrita.
4. Reiniciar o Home Assistant e testar primeiro `script.moni_mobile_testar_conexao`.
