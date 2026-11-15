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
SCOPE_FILE="${GIT_BACKUP_SCOPE_FILE:-$SCRIPT_DIR/git-backup-scope.conf}"

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

emit_reason() {
  printf 'git-backup-reason=%s\n' "$1"
}

record_publication_evidence() {
  # Observation failure never repeats or changes the result of a completed push.
  if [[ "$REMOTE" == origin && "$BRANCH" == main ]]; then
    python3 "$SCRIPT_DIR/git-publication-evidence.py" worker >> "$LOG_FILE" 2>&1 || :
  fi
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

retain_push_diagnostics() {
  # Long TAP suites can finish hundreds of lines after the failed test. Keep
  # bounded failure context as well as the tail; this is a private log, not a
  # public diagnostic or evidence that the failing check has recovered.
  printf '%s\n' "$1" | awk '
    /^[[:space:]]*not ok [0-9]+([[:space:]]|$)/ {
      if (remaining == 0 && blocks < 4) {
        print "git-backup: retained TAP failure context"
        remaining = 48
        blocks++
      }
    }
    remaining > 0 { print substr($0, 1, 2000); remaining-- }
  '
  printf '%s\n' "$1" | tail -n 160
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
  export GIT_SSH_COMMAND="ssh $ssh_identity -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o BatchMode=yes -o StrictHostKeyChecking=yes -o Hostname=ssh.github.com -o HostKeyAlias=github.com -o Port=443"
elif [[ -n "$SSH_KEY" ]]; then
  export GIT_SSH_COMMAND="ssh -i \"$SSH_KEY\" -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o BatchMode=yes -o StrictHostKeyChecking=yes"
fi

# Trabalho interativo em andamento pode deixar arquivos novos, ainda nao
# rastreados, que o scanner reprova. Eles nunca devem ser publicados, mas
# tambem nao devem impedir o backup do restante. Quando todos os achados sao de
# arquivos recem-adicionados ao indice, retire somente esses arquivos do stage
# (o conteudo em disco fica intacto) e repita o scan. Achado em arquivo ja
# rastreado, em job de recovery ou em formato desconhecido continua abortando.
exclude_flagged_new_files() {
  local scan_output="$1" flagged added file rescan
  [[ -z "${GIT_BACKUP_RECOVERY_JOB:-}" ]] || return 1
  flagged=$(printf '%s\n' "$scan_output" |
    sed -n 's/.*rule=[^ ]* file=\(.*\) line=[0-9][0-9]* category=.*/\1/p' | sort -u)
  [[ -n "$flagged" ]] || return 1
  # Todo achado precisa ter sido interpretado; qualquer outro tipo aborta.
  [[ "$(printf '%s\n' "$scan_output" | grep -c 'category=')" -eq \
     "$(printf '%s\n' "$scan_output" | grep -c 'rule=[^ ]* file=.* line=[0-9][0-9]* category=')" ]] || return 1
  added=$(git diff --cached --name-only --diff-filter=A)
  while IFS= read -r file; do
    printf '%s\n' "$added" | grep -Fxq -- "$file" || return 1
  done <<< "$flagged"
  while IFS= read -r file; do
    git reset --quiet -- "$file"
  done <<< "$flagged"
  if ! rescan="$(bash scripts/security-scan.sh --staged 2>&1)"; then
    security_scan="$rescan"
    return 1
  fi
  log "backup excluded $(printf '%s\n' "$flagged" | wc -l | tr -d ' ') flagged new file(s) from staging reason=security_scan_excluded_new_files"
  printf '%s\n' "$scan_output" | grep 'category=' >> "$LOG_FILE"
  return 0
}

# O backup automatico publica o estado escrito pelos servicos em execucao.
# Caminhos de autoria interativa (scripts, documentacao, memoria) pertencem a
# quem os esta editando: capturar um trabalho pela metade fazia a validacao
# canonica reprovar o commit e bloqueava o backup inteiro e as atualizacoes
# que dependem dele. As mudancas nesses caminhos saem apenas do stage; o
# conteudo em disco fica intacto para o autor publicar. Sem arquivo de escopo
# o comportamento anterior e mantido; o job de recovery usa a arvore aprovada.
defer_development_paths() {
  [[ -z "${GIT_BACKUP_RECOVERY_JOB:-}" && -r "$SCOPE_FILE" ]] || return 0
  local -a defer=() keep=() staged=()
  local kind value extra
  while read -r kind value extra || [[ -n "$kind" ]]; do
    case "$kind" in
      ''|'#'*) continue ;;
    esac
    if [[ -n "$extra" || -z "$value" || "$value" == /* || "$value" == *..* || "$value" == *[:\*\?\[]* ]]; then
      log "backup aborted: invalid scope rule reason=backup_scope_invalid"
      return 1
    fi
    case "$kind" in
      defer) defer+=("$value") ;;
      keep) keep+=(":(exclude)$value") ;;
      *) log "backup aborted: invalid scope rule reason=backup_scope_invalid"; return 1 ;;
    esac
  done < "$SCOPE_FILE"
  ((${#defer[@]})) || return 0
  # --no-renames keeps both sides of a rename inside the same decision.
  mapfile -d '' -t staged < <(git diff --cached --name-only --no-renames -z -- "${defer[@]}" "${keep[@]}")
  ((${#staged[@]})) || return 0
  git reset --quiet -- "${staged[@]}"
  log "backup left ${#staged[@]} development path(s) to their author reason=development_paths_deferred"
  printf '  deferred=%s\n' "${staged[@]}" >> "$LOG_FILE"
}

{
  flock -n 9 || {
    log "backup skipped: another git backup is already running"
    if [[ -n "${GIT_BACKUP_RECOVERY_JOB:-}" ]]; then emit_reason "maintenance_busy"; exit 75; fi
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

  if [[ -n "${GIT_BACKUP_RECOVERY_JOB:-}" ]]; then
    /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp/git_recovery.py --guard stage || { emit_reason "unapproved_tree"; exit 1; }
  fi
  starting_head="$(git rev-parse HEAD)"
  created_commit=0
  git add -A
  if ! defer_development_paths; then
    git reset --quiet
    emit_reason "backup_scope_invalid"
    exit 1
  fi

  # O scanner canonico valida caminhos proibidos e conteudo sem confundir
  # scripts/testes legitimos que tenham palavras como "credentials" no nome.
  # Sua saida e somente metadado do achado; nenhum valor sensivel vai ao log.
  if ! security_scan="$(bash scripts/security-scan.sh --staged 2>&1)" &&
     ! exclude_flagged_new_files "$security_scan"; then
    log "backup aborted: staged security scan failed"
    printf '%s\n' "$security_scan" >> "$LOG_FILE"
    if [[ -z "${GIT_BACKUP_RECOVERY_JOB:-}" ]]; then git reset --quiet; fi
    emit_reason "security_scan_failed"
    exit 1
  fi

  if [[ -n "${GIT_BACKUP_RECOVERY_JOB:-}" ]]; then
    /usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp/git_recovery.py --guard index || { emit_reason "unapproved_tree"; exit 1; }
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
    record_publication_evidence
    exit 0
  fi

  # A validação canônica do pre-push pode estar ocupada por uma tarefa
  # interativa. Preserve o commit local e sinalize indisponibilidade
  # temporária para que a ponte tente novamente, em vez de esquecer um HEAD
  # já criado e depois falhar como "behind" quando o remoto avançar.
  push_ref="$BRANCH"
  if [[ -n "${GIT_BACKUP_RECOVERY_JOB:-}" ]]; then
    approved_head=$(/usr/bin/python3 -I -S -B /usr/local/lib/raspberry-mcp/git_recovery.py --guard push) || { emit_reason "unapproved_tree"; exit 1; }
    [[ "$approved_head" =~ ^[a-f0-9]{40}$ ]] || exit 1
    push_ref="$approved_head:refs/heads/$BRANCH"
  fi
  if ! push_output=$(env -u GIT_BACKUP_RECOVERY_JOB git push "$REMOTE" "$push_ref" --quiet 2>&1); then
    # Keep the actual failed check in this private operational log; a generic
    # validation_failed code alone cannot diagnose or prevent recurrence.
    retain_push_diagnostics "$push_output" >> "$LOG_FILE"
    case "$push_output" in
      *"resource-safe: another broad validation is already running"*|\
      *"resource-safe: refusing validation"*)
        log "backup deferred: canonical validation resources are busy reason=validation_busy"
        emit_reason "validation_busy"
        exit 75
        ;;
      *)
        failure_reason=$(classify_remote_error "$push_output")
        if [[ -z "${GIT_BACKUP_RECOVERY_JOB:-}" && "$created_commit" -eq 1 &&
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
  record_publication_evidence
} 9>"$LOCK_FILE"
