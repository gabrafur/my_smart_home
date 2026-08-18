#!/usr/bin/env bash
#
# security-scan.sh — auditoria de segredos para este repositorio PUBLICO.
#
# Escopo deliberado: olha SOMENTE o que o Git rastreia (`git ls-files`). O que
# esta apenas no disco (secrets.yaml, .env, .storage/, .local-secrets/) e' o
# estado privado da casa e nao deve ser lido nem impresso por esta ferramenta.
#
# A saida NUNCA imprime o valor, prefixo ou sufixo de um possivel segredo:
# mostra somente regra, arquivo, linha e categoria.
#
# Saida: 0 = limpo, 1 = achado real, 2 = erro de uso/ambiente.
#
# Uso:
#   scripts/security-scan.sh            # todos os arquivos rastreados
#   scripts/security-scan.sh --staged   # so' o que esta staged (pre-commit)

set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "security-scan: nao estou dentro de um repositorio git" >&2
  exit 2
}

MODE="tracked"
[[ "${1:-}" == "--staged" ]] && MODE="staged"

findings=0
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# Mostra somente metadados do achado, sem imprimir qualquer parte do valor.
report() {
  local rule="$1" file="$2" line="$3" category="$4"
  red "  rule=$rule file=$file line=$line category=$category"
  findings=$((findings + 1))
}

file_list() {
  if [[ "$MODE" == "staged" ]]; then
    git diff --cached --name-only --diff-filter=ACMR
  else
    git ls-files
  fi
}

mapfile -t FILES < <(file_list)
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "security-scan: nenhum arquivo para examinar ($MODE)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Arquivos que nunca podem estar versionados
# ---------------------------------------------------------------------------
bold "==> Arquivos proibidos no indice"

FORBIDDEN_PATHS=(
  '^homeassistant/\.storage/'
  '^homeassistant/\.cloud/'
  '^homeassistant/\.ssh/'
  '^homeassistant/secrets\.yaml$'
  '^homeassistant/\.ha_ws_token$'
  '^homeassistant/backups/'
  '^nodered/flows_cred\.json$'
  '^nodered/\.config\.users\.json'
  '^nodered/\.sessions\.json$'
  '^mosquitto/config/password\.txt$'
  '^zigbee2mqtt/configuration\.yaml$'
  '^zigbee2mqtt/coordinator_backup\.json$'
  '^zigbee2mqtt/database\.db$'
  '^portainer/'
  '^matter-server/'
  '^appdaemon/secrets\.yaml$'
  '^appdaemon/appdaemon\.yaml$'
  '^\.local-secrets/'
  '^\.env$'
  '^\.env\.[^e]'          # .env.local, .env.prod, ... mas nao .env.example
  '(^|/)devices\.json$'
  '(^|/)snapshot\.json$'
  '(^|/)tinytuya\.json$'
  '(^|/)tuya-raw\.json$'
  '\.db$'
  '\.db-(wal|shm|journal)$'
  '(^|/)id_(rsa|ed25519|ecdsa|dsa)$'
  '\.(pem|key|p12|pfx|keystore)$'
)

for f in "${FILES[@]}"; do
  for pat in "${FORBIDDEN_PATHS[@]}"; do
    if [[ "$f" =~ $pat ]]; then
      red "  [arquivo-proibido] $f  (bate com /$pat/)"
      findings=$((findings + 1))
      break
    fi
  done
done
[[ $findings -eq 0 ]] && echo "  ok — nenhum arquivo proibido rastreado"

# ---------------------------------------------------------------------------
# 2. .gitignore continua cobrindo o estado privado
# ---------------------------------------------------------------------------
bold "==> Cobertura do .gitignore"

MUST_IGNORE=(
  'homeassistant/.storage/core.entity_registry'
  'homeassistant/.ha_ws_token'
  'homeassistant/secrets.yaml'
  'homeassistant/.cloud/x'
  'homeassistant/.ssh/id_ed25519'
  'homeassistant/home-assistant_v2.db'
  'nodered/flows_cred.json'
  'mosquitto/config/password.txt'
  'zigbee2mqtt/configuration.yaml'
  'zigbee2mqtt/coordinator_backup.json'
  'portainer/data'
  '.env'
  '.local-secrets/token.txt'
  'appdaemon/secrets.yaml'
  'appdaemon/appdaemon.yaml'
)
ignore_gaps=0
for p in "${MUST_IGNORE[@]}"; do
  if ! git check-ignore -q --no-index "$p"; then
    red "  [gitignore] '$p' NAO esta ignorado"
    findings=$((findings + 1))
    ignore_gaps=$((ignore_gaps + 1))
  fi
done
# Os arquivos de exemplo precisam continuar versionaveis.
MUST_NOT_IGNORE=(
  '.env.example'
  'homeassistant/secrets.yaml.example'
  'templates/appdaemon/secrets.yaml.example'
  'zigbee2mqtt/configuration.example.yaml'
)
for p in "${MUST_NOT_IGNORE[@]}"; do
  if git check-ignore -q --no-index "$p"; then
    red "  [gitignore] '$p' esta ignorado, mas e' um arquivo de exemplo"
    findings=$((findings + 1))
    ignore_gaps=$((ignore_gaps + 1))
  fi
done
[[ $ignore_gaps -eq 0 ]] && echo "  ok — regras de ignore intactas"

# ---------------------------------------------------------------------------
# 3. Conteudo: padroes de credencial e de dado pessoal
# ---------------------------------------------------------------------------
bold "==> Conteudo dos arquivos rastreados"

# Ruido conhecido e inofensivo: digests de imagem, hashes de integridade do npm,
# ids de no do Node-RED, e os proprios placeholders. `!secret` e' o padrao
# correto do Home Assistant, nao um vazamento.
# zZWtXTja... e' o hash bcrypt de exemplo que vem comentado no settings.js
# padrao do Node-RED (esta na documentacao oficial), nao uma credencial nossa.
IGNORE_LINE_RE='!secret|CHANGE_ME|SUA_SENHA|replace-with|your-|example\.com|placeholder|PRIVACY_TEST_FIXTURE|<[A-Za-z_-]+>|sha256:|sha512-|integrity"|AA:AA:AA|zZWtXTja0fB1pzD4sHCMyOCMYz2Z6dNbM6tl8sJogENOMcxWV9DN'

# nome-da-regra <TAB> regex ERE
#
# `coordenada-nua` pega um decimal com 6+ casas em QUALQUER contexto, sem
# exigir a palavra latitude/longitude ao lado. Existe porque um exemplo de
# `git filter-repo` num documento chegou a carregar a coordenada de casa em
# texto puro, sem rotulo — a regra rotulada nao pegava.
RULES=$(cat <<'EOF'
chave-privada	-----BEGIN [A-Z ]*PRIVATE KEY-----
aws-access-key	AKIA[0-9A-Z]{16}
github-token	gh[pousr]_[A-Za-z0-9]{30,}
slack-token	xox[abprs]-[A-Za-z0-9-]{10,}
anthropic-key	sk-ant-[A-Za-z0-9_-]{20,}
openai-key	sk-[A-Za-z0-9]{32,}
google-api-key	AIza[0-9A-Za-z_-]{35}
tailscale-authkey	tskey-[a-z]+-[A-Za-z0-9]{10,}
jwt	eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}
bcrypt-hash	\$2[aby]\$[0-9]{2}\$[A-Za-z0-9./]{20,}
segredo-atribuido	(pass(word|wd)?|secret|token|api_?key|auth)["']?[[:space:]]*[:=][[:space:]]*["'][A-Za-z0-9/+_.-]{16,}["']
mac-address	\b([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b
coordenada-precisa	(latitude|longitude|_LAT|_LON)["']?[[:space:]]*[:=][[:space:]]*-?[0-9]{1,3}\.[0-9]{5,}
coordenada-nua	-?[0-9]{1,3}\.[0-9]{6,}
ipv4-privado	\b(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2})\b
url-com-credencial	[a-z][a-z0-9+.-]*://[^/[:space:]:@"']+:[^/[:space:]@"']+@
EOF
)

# Limita a busca a arquivos de texto e ao conjunto certo (tracked vs staged).
GREP_ARGS=(-nIE --no-color)
[[ "$MODE" == "staged" ]] && GREP_ARGS+=(--cached)

while IFS=$'\t' read -r rule regex; do
  [[ -z "$rule" ]] && continue
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    file="${hit%%:*}"; rest="${hit#*:}"
    line="${rest%%:*}"; text="${rest#*:}"
    # As definicoes exatas do proprio detector nao sao chaves privadas. A
    # excecao e deliberadamente estreita para que qualquer outro conteudo nos
    # mesmos arquivos continue sendo auditado normalmente.
    if [[ "$rule" == "chave-privada" ]]; then
      if [[ "$file" == "scripts/security-scan.sh" \
        && "$text" == $'chave-privada\t-----BEGIN [A-Z ]*PRIVATE KEY-----' ]]; then
        continue
      fi
      if [[ "$file" == "scripts/public-memory-check.mjs" \
        && "$text" == *'["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],'* ]]; then
        continue
      fi
      if [[ "$file" == "scripts/local-ai/post_tool_routing.py" \
        && "$text" == *'r"-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----",'* ]]; then
        continue
      fi
    fi
    # Constante de protocolo da biblioteca vendorizada LocalTuya; nao e um
    # endereco da instalacao. Mantenha a excecao restrita a regra e arquivo.
    if [[ "$rule" == "ipv4-privado" \
      && "$file" == "homeassistant/custom_components/localtuya/pytuya/__init__.py" ]]; then
      continue
    fi
    # package-lock e vendored HACS geram ruido estrutural sem valor de auditoria
    case "$file" in
      # ruido estrutural sem valor de auditoria: lockfile, frontend gerado do
      # HACS e assets vendorizados (iconset.js e' path data de SVG, cheio de
      # decimais longos que disparam `coordenada-nua`).
      *package-lock.json|*/hacs_frontend/*|*/hacs/iconset.js|*.min.js|*.svg) continue ;;
    esac
    printf '%s' "$text" | grep -qE -- "$IGNORE_LINE_RE" && continue
    report "$rule" "$file" "$line" "secret-or-private-data"
  done < <(git grep "${GREP_ARGS[@]}" -e "$regex" -- "${FILES[@]}" 2>/dev/null)
done <<< "$RULES"

# ---------------------------------------------------------------------------
bold "==> Resultado"
if [[ $findings -gt 0 ]]; then
  red "$findings achado(s). Corrija antes de publicar."
  echo
  echo "Se for falso positivo, ajuste IGNORE_LINE_RE/RULES em scripts/security-scan.sh"
  echo "em vez de relaxar o .gitignore."
  exit 1
fi
echo "  limpo — nenhum segredo ou arquivo proibido nos arquivos rastreados."
exit 0
