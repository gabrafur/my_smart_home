# Auditoria de seguranca — repositorio publico

Este repositorio e publico e espelha a configuracao de uma casa real. Este
documento registra o que foi removido do rastreamento, o que ainda existe no
historico do Git, e o que fazer a respeito.

Data da auditoria: **2026-08-07**.

## 1. Modelo de ameaca

O que importa proteger, em ordem de severidade:

| Dado | Por que importa | Rotacionavel? |
| --- | --- | --- |
| Coordenada exata de casa | Com 11 casas decimais, e' o endereco da residencia. Combinada com um nome, identifica onde uma familia mora. | Nao |
| Credenciais (tokens, senhas, chaves Zigbee) | Acesso direto ao sistema. | Sim |
| MAC / BSSID / unique_id de dispositivo | Identificadores estaveis de hardware; servem para fingerprinting. | Nao |
| Nome de morador | Terceiros nao escolheram publicar o proprio nome. | Nao |
| Hostname/IP de tailnet, `user_id` do HA | Identificam a rede privada e a conta administradora. | Parcialmente |

## 2. Estado atual (branch `main`)

### Removido do rastreamento (arquivos preservados em disco)

- `homeassistant/.storage/**` — 8 registries que estavam versionados
  (`core.area_registry`, `core.device_registry`, `core.entity_registry`,
  `core.floor_registry`, `homeassistant.exposed_entities`, `lovelace.map`,
  `lovelace_dashboards`, `person`). Continham MAC/BSSID, `unique_id` por
  dispositivo, identificadores de pareamento HomeKit e registros de moradores.
  O `.gitignore` agora ignora `homeassistant/.storage/` **inteiro**, sem
  excecoes `!` por arquivo — a lista de excecoes era exatamente a origem do
  vazamento.
- `homeassistant/.cache/**` e `homeassistant/tts/**` — cache de runtime que o
  `.gitignore` ja declarava ignorar, mas que continuava no indice.

### Substituido por indirecao

| Onde estava | Agora |
| --- | --- |
| Coordenada de casa em `homeassistant/packages/zonas_presenca.yaml` | `!secret home_latitude` / `!secret home_longitude` |
| Coordenada de casa e do portao em `nodered/flows.json` | `env.get("HOME_LAT")` etc., vindas do `.env` via `env_file` do servico `nodered` |
| Instalador antigo `nodered/tools/install-security-light-flow.mjs` | Desativado; `nodered/flows.json` e a fonte de verdade validada por replay |
| Coordenada em `appdaemon/appdaemon.yaml` | Arredondada para 2 casas (~1 km), precisao de sobra para o calculo solar |
| MAC da TV em `homeassistant/automations.yaml` | `!secret tv_sala_mac` |
| `user_id` do HA em `custom_components/claude_code_chat/config_flow.py` | Campo obrigatorio no config flow, sem default |
| Tailnet/hostname/IP Tailscale em `docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` | Placeholders (`SEU-TAILNET`, `raspberry-pi`, `100.x.y.z`) |

O comportamento em runtime nao muda: o `check_config` do Home Assistant
confirma que `!secret` resolve para os mesmos valores, e o fluxo do Node-RED
foi testado com e sem as variaveis de ambiente (ver secao 5).

### Degradacao proposital no Node-RED

Se `HOME_LAT`/`HOME_LON` faltarem, o fluxo **nao** calcula distancia com
coordenada invalida: `distanceFromHome()` devolve `null` e a logica cai no
fallback que ja existia para GPS nao confiavel — o estado de zona do proprio
Home Assistant (`home`/`not_home`). Perde-se o pre-acendimento por distancia,
nao a funcao.

## 3. O historico do Git

**Remover um arquivo do branch atual nao o remove do historico.** Todos os
dados abaixo continuam recuperaveis com `git log`/`git show` em commits
anteriores, e — como o repositorio ja e publico — devem ser considerados
**ja expostos**.

### Varredura completa (82 commits, 680 blobs unicos)

Nenhum padrao de **credencial** foi encontrado no historico:

- sem chaves privadas (`-----BEGIN ... PRIVATE KEY-----`)
- sem JWT / token de acesso do Home Assistant
- sem token de GitHub, AWS, Google, Anthropic ou Tailscale
- sem URL com credencial embutida (`esquema://<usuario>:<senha>@host`)
- o unico hash bcrypt encontrado em `nodered/settings.js` e o **exemplo
  comentado que acompanha o `settings.js` padrao do Node-RED**, presente na
  documentacao oficial do projeto — nao e' uma credencial desta instalacao.

O que existe no historico e' **metadado pessoal**, nao credencial:

| Categoria | Caminhos no historico |
| --- | --- |
| Coordenada precisa de casa | `homeassistant/packages/zonas_presenca.yaml`, `nodered/flows.json`, `nodered/tools/install-security-light-flow.mjs` |
| MAC address | `homeassistant/.storage/core.device_registry`, `core.entity_registry`, `homeassistant/automations.yaml`, `docs/WAKE_ON_LAN_TV_SALA.md`, `docs/BLUETOOTH_MATTER.md`, `.claude/memory/project_power_matter_bluetooth.md` |
| Nome de morador | `homeassistant/.storage/person`, `core.device_registry`, `core.entity_registry`, `nodered/flows.json`, `docs/ILUMINACAO_SEGURANCA_NODERED.md`, `docs/INSTALACAO_RESTAURACAO_SMART_HOME.md`, `homeassistant/packages/raspberry_pi_system_health.yaml`, `tools/bw_audit/make_folders.js`, `.claude/memory/project_iluminacao_seguranca_flow.md` |
| `user_id` do Home Assistant | `docs/CHAT_CLAUDE_CODE_HA.md`, `homeassistant/custom_components/claude_code_chat/config_flow.py`, `homeassistant/.storage/person` |
| Tailnet + IP Tailscale | `docs/INSTALACAO_RESTAURACAO_SMART_HOME.md` |
| SSID/BSSID (nomes de entidade, nao valores) | `homeassistant/.storage/core.entity_registry` |

### O que rotacionar

Como nenhuma credencial vazou pelo Git, **nada precisa ser rotacionado por
causa do historico**. As acoes abaixo sao mitigacao de metadado, nao resposta
a incidente:

1. **Tailnet** — renomear o tailnet e o hostname do no no Tailscale Admin
   Console invalida o identificador publicado. Barato e efetivo.
2. **`user_id` do Home Assistant** — so muda recriando a conta. Como ele nao
   autentica nada sozinho (e' apenas o alvo de uma allowlist), o risco e'
   baixo; considerar 2FA na conta administradora e a mitigacao proporcional.
3. **Coordenada, MAC e nomes** — nao sao rotacionaveis. So a limpeza de
   historico (secao 4) os remove.
4. **Higiene independente do Git** — se as senhas de MQTT/Node-RED nunca
   passaram por este repositorio (nao passaram), a rotacao periodica via
   `scripts/rotate-mqtt-password.mjs` continua sendo boa pratica, sem urgencia.

## 4. Proposta de limpeza de historico (requer aprovacao explicita)

> **Nao execute sem decidir conscientemente.** Reescrever o historico muda o
> SHA de todos os commits, exige `--force` no push, quebra qualquer clone ou
> fork existente, e invalida links permanentes para commits. Como o
> repositorio ja foi publicado, a reescrita **nao garante** que copias em
> cache (forks, GitHub Archive, indexadores) desaparecam.

Se a decisao for limpar, a ferramenta correta e o
[`git-filter-repo`](https://github.com/newren/git-filter-repo) (o
`filter-branch` e' obsoleto e lento). Procedimento seguro:

```bash
# 0. Backup COMPLETO antes de qualquer coisa
git clone --mirror git@github.com:gabrafur/my_smart_home.git backup-antes-da-limpeza.git

# 1. Trabalhar em um clone fresco, nunca no repositorio de producao do Pi
git clone git@github.com:gabrafur/my_smart_home.git limpeza && cd limpeza

# 2. Remover caminhos que nunca deveriam ter sido versionados
git filter-repo \
  --path homeassistant/.storage/ \
  --path homeassistant/.cache/ \
  --path homeassistant/tts/ \
  --path .claude/ \
  --invert-paths

# 3. Substituir valores literais que sobraram em arquivos que DEVEM continuar
#    no historico (docs, flows, packages). Um par por linha, no formato
#    `literal==>substituto`. Preencha os `<...>` com os valores reais
#    (de secrets.yaml/.env) na hora de rodar. NAO versione este arquivo.
cat > ../substituicoes.txt <<'EOF'
<latitude-de-casa>==>HOME_LAT
<longitude-de-casa>==>HOME_LON
<latitude-do-portao>==>GATE_LAT
<longitude-do-portao>==>GATE_LON
<mac-da-tv>==>TV_MAC
<user-id-do-ha>==>HA_USER_ID
<tailnet>.ts.net==>SEU-TAILNET.ts.net
<nome-do-morador>==>resident_2
EOF
git filter-repo --replace-text ../substituicoes.txt

# 4. Conferir ANTES de publicar
scripts/security-scan.sh
git log --oneline | head

# 5. Publicar (destrutivo)
git remote add origin git@github.com:gabrafur/my_smart_home.git
git push --force --all
git push --force --tags
```

Depois do force-push, o clone do Raspberry Pi precisa ser refeito
(`git fetch origin && git reset --hard origin/main`) — caso contrario o backup
noturno (`scripts/git-backup.sh`) tentara reconciliar historicos divergentes.

**Alternativa mais simples, se o objetivo for so' "comecar limpo":** criar um
repositorio novo com um unico commit inicial a partir da arvore ja saneada, e
arquivar o antigo como privado. Perde-se o historico como portfolio, mas nao ha
force-push nem risco de reconciliacao.

## 5. Validacoes executadas

| Validacao | Resultado |
| --- | --- |
| `scripts/security-scan.sh` (arquivos rastreados) | limpo, exit 0 |
| `scripts/security-scan.sh` com segredos plantados (teste negativo) | detectou AWS, GitHub token, JWT, URL com credencial, MAC, coordenada, segredo atribuido; exit 1 |
| `git ls-files 'homeassistant/.storage/*'` | vazio |
| `git check-ignore` para `.storage/`, `.ha_ws_token`, `secrets.yaml`, `.env`, `flows_cred.json`, `password.txt`, `coordinator_backup.json`, `portainer/`, `.local-secrets/` | todos ignorados |
| `git check-ignore` para `.env.example`, `zigbee2mqtt/configuration.example.yaml` | nao ignorados (correto) |
| JSON rastreado (`git ls-files '*.json'`) | valido |
| YAML rastreado (24 arquivos, tags `!secret`/`!include` registradas) | valido |
| `docker compose config --quiet` | ok |
| `homeassistant --script check_config` | ok; `!secret` resolve para os mesmos valores de antes |
| Sintaxe dos function nodes do Node-RED | ok |
| Fluxo `sec_prepare_arrival_context` / `sec_refresh_anyone_away` com e sem env | identico com env; degrada para estado de zona sem env |
| `python3 -m ast` em `config_flow.py` | ok |

## 6. Pendencias que dependem de decisao

Ver a secao correspondente no relatorio de entrega. Em resumo: os `entity_id`
do Home Assistant ainda carregam nomes proprios
(`device_tracker.iphone_de_*`, `notify.iphone_de_*`). Renomea-los e' possivel,
mas e' uma alteracao no registro de entidades de uma instalacao **em
producao**, com risco de silenciar a iluminacao de seguranca e os alertas de
saude do sistema se alguma referencia ficar para tras. Por isso nao foi feito
automaticamente.
