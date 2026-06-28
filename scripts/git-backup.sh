#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/mnt/data/docker"
BRANCH="main"
REMOTE="origin"
SSH_KEY="/home/gabriel/.ssh/id_ed25519"
LOG_FILE="$REPO_DIR/.git-backup.log"
LOCK_FILE="$REPO_DIR/.git-backup.lock"

export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

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

  suspicious_files="$(
    git diff --cached --name-only |
      grep -Ei '(^|/)(secrets?\\.ya?ml|.*cred.*|.*auth.*|.*cookie.*|.*password.*|.*token.*|.*\\.db|.*\\.tar|flows_cred\\.json|coordinator_backup\\.json|configuration\\.yaml|portainer)(/|$)' ||
      true
  )"

  allowed_suspicious="$(
    printf '%s\n' "$suspicious_files" |
      grep -Ev '^homeassistant/configuration\.yaml$' ||
      true
  )"

  if [ -n "$allowed_suspicious" ]; then
    log "backup aborted: suspicious files staged:"
    printf '%s\n' "$allowed_suspicious" >> "$LOG_FILE"
    git reset --quiet
    exit 1
  fi

  secret_hits="$(
    git grep --cached -n -I -E 'home10|BEGIN OPENSSH|PRIVATE KEY|refresh[_-]?token[:=][[:space:]]*[A-Za-z0-9_.-]+|access[_-]?token[:=][[:space:]]*[A-Za-z0-9_.-]+|client[_-]?secret[:=][[:space:]]*[A-Za-z0-9_.-]+|api[_-]?key[:=][[:space:]]*[A-Za-z0-9_.-]+' |
      grep -v '^scripts/git-backup\.sh:' ||
      true
  )"

  if [ -n "$secret_hits" ]; then
    log "backup aborted: possible secret content staged"
    printf '%s\n' "$secret_hits" >> "$LOG_FILE"
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
