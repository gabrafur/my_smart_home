.PHONY: validate-public privacy-check privacy-check-staged bindings-check \
	backup-plan backup-verify restore-plan restore-verify restore-test restore-apply \
	bootstrap bootstrap-test demo demo-test modules-check context-recovery-check

BACKUP_DIR ?=
DESTINATION ?=
CONFIRM ?=
ALLOW_NON_CANARY ?=
MODULES ?= core

privacy-check:
	node scripts/privacy-check.mjs

privacy-check-staged:
	node scripts/privacy-check.mjs --staged

bindings-check:
	node --test scripts/public-bindings-check.test.mjs
	node scripts/public-bindings-check.mjs

backup-plan:
	node scripts/restore.mjs backup-plan

backup-verify:
	@test -n "$(BACKUP_DIR)" || (echo "BACKUP_DIR is required" >&2; exit 2)
	node scripts/restore.mjs backup-verify --backup-dir "$(BACKUP_DIR)"

restore-plan:
	@test -n "$(BACKUP_DIR)" || (echo "BACKUP_DIR is required" >&2; exit 2)
	node scripts/restore.mjs restore-plan --backup-dir "$(BACKUP_DIR)" $(if $(DESTINATION),--destination "$(DESTINATION)",)

restore-verify:
	@test -n "$(BACKUP_DIR)" || (echo "BACKUP_DIR is required" >&2; exit 2)
	node scripts/restore.mjs restore-verify --backup-dir "$(BACKUP_DIR)"

restore-test:
	node scripts/restore.mjs manifest-validate
	node --test scripts/restore.test.mjs

restore-apply:
	@test -n "$(BACKUP_DIR)" || (echo "BACKUP_DIR is required" >&2; exit 2)
	@test -n "$(DESTINATION)" || (echo "DESTINATION is required" >&2; exit 2)
	node scripts/restore.mjs restore-apply --backup-dir "$(BACKUP_DIR)" --destination "$(DESTINATION)" --confirm "$(CONFIRM)" $(if $(ALLOW_NON_CANARY),--allow-non-canary "$(ALLOW_NON_CANARY)",)

bootstrap:
	node scripts/bootstrap.mjs --modules "$(MODULES)"

bootstrap-test:
	node --test scripts/bootstrap.test.mjs

demo:
	node scripts/demo.mjs

demo-test:
	node --test scripts/demo.test.mjs

modules-check:
	node scripts/modules-check.mjs

context-recovery-check:
	node scripts/ai-context-recovery.mjs --worktree

validate-public:
	node scripts/restore.mjs manifest-validate
	node --test scripts/restore.test.mjs
	node --test scripts/bootstrap.test.mjs
	node --test scripts/demo.test.mjs
	node --test scripts/ai-context-recovery.test.mjs
	node --test scripts/restore-prompt.test.mjs
	node --test scripts/modules-check.test.mjs
	node scripts/modules-check.mjs
	node --test scripts/public-bindings-check.test.mjs
	node scripts/public-bindings-check.mjs
	node --test scripts/privacy-check.test.mjs
	node scripts/privacy-check.mjs
	node --test scripts/public-memory-check.test.mjs
	node scripts/public-memory-check.mjs
	node scripts/docs-check.mjs
	node scripts/weekly-docs-review.mjs --self-test
	node scripts/ai-context-recovery.mjs --worktree
	bash scripts/security-scan.sh
