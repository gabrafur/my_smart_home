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

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

emit_reason() {
  printf 'git-backup-reason=%s\n' "$1"
}

classify_remote_error() {
  local output="$1"
  case "$output" in
    *"Connection timed out"*|*"Could not resolve hostname"*|*"Could not resolve host"*|*"Network is unreachable"*|*"Connection refused"*)
      printf '%s\n' "network_unavailable"
      ;;
    *"Permission denied"*|*"Could not read from remote repository"*|*"Authentication failed"*)
      printf '%s\n' "authentication_or_access"
      ;;
    *"non-fast-forward"*|*"fetch first"*|*"behind or diverged"*)
      printf '%s\n' "remote_diverged"
      ;;
    *"Node-RED canvas validation failed:"*|*"Visual quality violation detected"*)
      printf '%s\n' "validation_node_red_layout"
      ;;
    *"pre-push:"*|*"validate-public"*|*"make: ***"*|*"hook declined"*)
      printf '%s\n' "validation_failed"
      ;;
    *)
      printf '%s\n' "remote_operation_failed"
      ;;
  esac
}

cd "$REPO_DIR"

# A operadora residencial bloqueia a porta SSH 22, mas permite o endpoint
# oficial do GitHub na 443. HostKeyAlias mantém a validação presa à chave já
# aprovada para github.com; nunca aceite uma chave nova durante um backup.
remote_url="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
if [[ "$remote_url" == *github.com* && "$remote_url" != http://* && "$remote_url" != https://* ]]; then
  ssh_identity=""
  if [[ -n "$SSH_KEY" ]]; then
    ssh_identity="-i \"$SSH_KEY\" -o IdentitiesOnly=yes"
  fi
  export GIT_SSH_COMMAND="ssh $ssh_identity -o BatchMode=yes -o StrictHostKeyChecking=yes -o Hostname=ssh.github.com -o HostKeyAlias=github.com -o Port=443"
elif [[ -n "$SSH_KEY" ]]; then
  export GIT_SSH_COMMAND="ssh -i \"$SSH_KEY\" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"
fi

{
  flock -n 9 || {
    log "backup skipped: another git backup is already running"
    exit 0
  }

  log "backup started"

  if ! fetch_output=$(git fetch "$REMOTE" "$BRANCH" --quiet 2>&1); then
    failure_reason=$(classify_remote_error "$fetch_output")
    log "backup failed: could not fetch $REMOTE/$BRANCH reason=$failure_reason"
    emit_reason "$failure_reason"
    exit 1
  fi

  if ! git merge-base --is-ancestor "$REMOTE/$BRANCH" HEAD; then
    log "backup failed: local branch is behind or diverged from $REMOTE/$BRANCH reason=remote_diverged"
    emit_reason "remote_diverged"
    exit 1
  fi

  starting_head="$(git rev-parse HEAD)"
  created_commit=0
  git add -A

  # O scanner canonico valida caminhos proibidos e conteudo sem confundir
  # scripts/testes legitimos que tenham palavras como "credentials" no nome.
  # Sua saida e somente metadado do achado; nenhum valor sensivel vai ao log.
  if ! security_scan="$(bash scripts/security-scan.sh --staged 2>&1)"; then
    log "backup aborted: staged security scan failed"
    printf '%s\n' "$security_scan" >> "$LOG_FILE"
    git reset --quiet
    emit_reason "security_scan_failed"
    exit 1
  fi

  if git diff --cached --quiet; then
    :
  else
    commit_message="chore: create automated smart home backup"
    git commit -m "$commit_message" --quiet
    created_commit=1
  fi

  ahead_count=$(git rev-list --count "$REMOTE/$BRANCH..HEAD")
  if [ "$ahead_count" -eq 0 ]; then
    log "backup finished: no changes"
    exit 0
  fi

  # A validação canônica do pre-push pode estar ocupada por uma tarefa
  # interativa. Preserve o commit local e sinalize indisponibilidade
  # temporária para que a ponte tente novamente, em vez de esquecer um HEAD
  # já criado e depois falhar como "behind" quando o remoto avançar.
  if ! push_output=$(git push "$REMOTE" "$BRANCH" --quiet 2>&1); then
    case "$push_output" in
      *"resource-safe: another broad validation is already running"*|\
      *"resource-safe: refusing validation"*)
        log "backup deferred: canonical validation resources are busy reason=validation_busy"
        emit_reason "validation_busy"
        exit 75
        ;;
      *)
        failure_reason=$(classify_remote_error "$push_output")
        if [[ "$created_commit" -eq 1 &&
              ("$failure_reason" == "validation_node_red_layout" || "$failure_reason" == "validation_failed") ]]; then
          git reset --mixed --quiet "$starting_head"
          log "backup restored worktree after validation rejected the new commit"
        fi
        log "backup failed: could not push $REMOTE/$BRANCH reason=$failure_reason"
        emit_reason "$failure_reason"
        exit 1
        ;;
    esac
  fi

  log "backup finished: pushed $(git rev-parse --short HEAD)"
} 9>"$LOCK_FILE"
