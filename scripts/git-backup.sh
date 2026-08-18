#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REMOTE="${GIT_BACKUP_REMOTE:-origin}"
BRANCH="${GIT_BACKUP_BRANCH:-$(git -C "$REPO_DIR" branch --show-current)}"
BRANCH="${BRANCH:-main}"
SSH_KEY="${GIT_BACKUP_SSH_KEY:-}"
LOG_FILE="$REPO_DIR/.git-backup.log"
LOCK_FILE="$REPO_DIR/.git-backup.lock"

if [[ -n "$SSH_KEY" ]]; then
  export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
fi

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

cd "$REPO_DIR"

{
  flock -n 9 || {
    log "backup skipped: another git backup is already running"
    exit 0
  }

  log "backup started"

  git fetch "$REMOTE" "$BRANCH" --quiet || {
    log "backup failed: could not fetch $REMOTE/$BRANCH"
    exit 1
  }

  if ! git merge-base --is-ancestor HEAD "$REMOTE/$BRANCH"; then
    log "backup failed: local branch is behind $REMOTE/$BRANCH"
    exit 1
  fi

  git add -A

  # O scanner canonico valida caminhos proibidos e conteudo sem confundir
  # scripts/testes legitimos que tenham palavras como "credentials" no nome.
  # Sua saida e somente metadado do achado; nenhum valor sensivel vai ao log.
  if ! security_scan="$(bash scripts/security-scan.sh --staged 2>&1)"; then
    log "backup aborted: staged security scan failed"
    printf '%s\n' "$security_scan" >> "$LOG_FILE"
    git reset --quiet
    exit 1
  fi

  if git diff --cached --quiet; then
    log "backup finished: no changes"
    exit 0
  fi

  commit_message="Automated smart home backup $(date '+%Y-%m-%d %H:%M:%S %z')"
  git commit -m "$commit_message" --quiet
  git push "$REMOTE" "$BRANCH" --quiet

  log "backup finished: pushed $(git rev-parse --short HEAD)"
} 9>"$LOCK_FILE"
