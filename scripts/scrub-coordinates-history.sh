#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Uso:
  scripts/scrub-coordinates-history.sh          # dry-run isolado
  scripts/scrub-coordinates-history.sh --push   # backup + force-with-lease + realinhamento soft
EOF
}

mode="dry-run"
case "${1:-}" in
  "") ;;
  --push) mode="push" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

helper="$repo_root/scripts/scrub-coordinate-values.mjs"
test -f "$helper" || { echo "helper ausente: $helper" >&2; exit 2; }

remote_url="$(git remote get-url origin)"
branch="$(git branch --show-current)"
test "$branch" = "main" || { echo "branch atual precisa ser main" >&2; exit 2; }

scratch="$(mktemp -d)"
cleanup() {
  case "$scratch" in /tmp/*) rm -rf -- "$scratch" ;; esac
}
trap cleanup EXIT

if [ "$mode" = "push" ]; then
  # O cron scripts/git-backup.sh usa exatamente o mesmo lock.
  exec 8>"$repo_root/.git-backup.lock"
  flock -n 8 || { echo "backup Git/reescrita ja esta em andamento" >&2; exit 1; }
  git fetch origin main --quiet
fi

before_commit="$(git rev-parse HEAD)"
before_tree="$(git rev-parse HEAD^{tree})"
before_count="$(git rev-list --all --count)"
remote_before="$(git rev-parse origin/main)"

clone="$scratch/rewrite"
git clone --quiet --no-hardlinks "$repo_root" "$clone"
git -C "$clone" remote set-url origin "$remote_url"

values="$scratch/coordinate-values.txt"
touch "$values"
chmod 600 "$values"

targets=(
  nodered/flows.json
  nodered/tools/install-security-light-flow.mjs
  homeassistant/packages/zonas_presenca.yaml
  docs/ILUMINACAO_SEGURANCA_NODERED.md
)

# Descobre os literais dentro do proprio historico. Nada e impresso no terminal
# nem gravado no repositorio; o arquivo temporario tem permissao 0600.
while read -r commit; do
  for target in "${targets[@]}"; do
    git -C "$clone" show "$commit:$target" 2>/dev/null || true
  done
done < <(git -C "$clone" rev-list --all) |
  perl -CS -ne '
    while (/(-?\d{1,3}\.\d{6,})/g) { print "$1\n" }
    while (/(?:HOME_LAT|HOME_LON|GATE_LAT|GATE_LON|latitude|longitude)[^\r\n]{0,40}?(-?\d{1,3}\.\d+)/g) { print "$1\n" }
    while (/([0-9]{1,3}°[0-9]{1,2}[^\r\n,;)]{0,40})/g) { print "$1\n" }
  ' | sort -u > "$values"

value_count="$(wc -l < "$values")"
test "$value_count" -gt 0 || { echo "nenhuma coordenada historica descoberta" >&2; exit 1; }

export FILTER_BRANCH_SQUELCH_WARNING=1
export SCRUB_VALUES_FILE="$values"
git -C "$clone" filter-branch -f \
  --tree-filter "node '$helper' '$values'" \
  -- --all >/dev/null

while read -r ref; do
  git -C "$clone" update-ref -d "$ref"
done < <(git -C "$clone" for-each-ref --format='%(refname)' refs/original/)
git -C "$clone" reflog expire --expire=now --all
git -C "$clone" gc --prune=now --quiet

after_tree="$(git -C "$clone" rev-parse main^{tree})"
after_count="$(git -C "$clone" rev-list main --count)"
test "$after_tree" = "$before_tree" || { echo "ABORTADO: arvore do HEAD mudou" >&2; exit 1; }
test "$after_count" = "$(git rev-list main --count)" || { echo "ABORTADO: contagem da main mudou" >&2; exit 1; }

while read -r value; do
  if git -C "$clone" grep -F -q -- "$value" $(git -C "$clone" rev-list --all) 2>/dev/null; then
    echo "ABORTADO: literal sensivel ainda alcancavel" >&2
    exit 1
  fi
done < "$values"

git -C "$clone" grep -E -q -- '-?[0-9]{1,3}\.[0-9]{6,}' $(git -C "$clone" rev-list --all) -- "${targets[@]}" 2>/dev/null && {
  echo "ABORTADO: coordenada precisa residual" >&2
  exit 1
}

"$clone/scripts/security-scan.sh" >/dev/null

echo "dry-run OK: $value_count literal(is), $before_count refs/commits inspecionados; arvore HEAD preservada"

if [ "$mode" != "push" ]; then
  exit 0
fi

backup_dir="$repo_root/.local-secrets/history-scrub-backups"
mkdir -p "$backup_dir"
chmod 700 "$repo_root/.local-secrets" "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle="$backup_dir/pre-scrub-$stamp.bundle"
metadata="$backup_dir/pre-scrub-$stamp.git.tar"
git bundle create "$bundle" --all >/dev/null
tar -C "$repo_root" -cf "$metadata" .git
chmod 600 "$bundle" "$metadata"

remote_now="$(git ls-remote "$remote_url" refs/heads/main | awk '{print $1}')"
test "$remote_now" = "$remote_before" || {
  echo "ABORTADO: origin/main mudou durante a preparacao" >&2
  exit 1
}

rewritten_commit="$(git -C "$clone" rev-parse main)"
git -C "$clone" push \
  --force-with-lease="refs/heads/main:$remote_before" \
  origin "refs/heads/main:refs/heads/main"

remote_after="$(git ls-remote "$remote_url" refs/heads/main | awk '{print $1}')"
test "$remote_after" = "$rewritten_commit" || { echo "push nao confirmado" >&2; exit 1; }

verify="$scratch/verify"
git clone --quiet --no-hardlinks "$remote_url" "$verify"
test "$(git -C "$verify" rev-parse HEAD^{tree})" = "$before_tree" || {
  echo "clone remoto nao preservou a arvore" >&2
  exit 1
}
while read -r value; do
  if git -C "$verify" grep -F -q -- "$value" $(git -C "$verify" rev-list --all) 2>/dev/null; then
    echo "clone remoto ainda contem literal sensivel" >&2
    exit 1
  fi
done < "$values"

git fetch origin main --quiet
test "$(git rev-parse origin/main^{tree})" = "$before_tree"
git reset --soft origin/main

echo "push e clone remoto verificados; worktree/indice preservados"
echo "backup temporario protegido: $backup_dir"
echo "HEAD antigo: $before_commit"
