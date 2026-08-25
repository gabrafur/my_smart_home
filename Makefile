.PHONY: validate-public validate-dependencies validate-compose validate-json validate-yaml \
	validate-shell validate-docs validate-assets validate-security validate-privacy \
	validate-memory validate-node-red validate-bridge validate-local-ai validate-homeassistant validate-scripts \
	validate-scheduler validate-auto-update validate-modules validate-restore \
	validate-bootstrap validate-demo validate-git validate-commit-message validate-staged privacy-check \
	privacy-check-staged bindings-check backup-plan backup-verify restore-plan \
	restore-verify restore-test restore-apply bootstrap bootstrap-test demo demo-test \
	modules-check context-recovery-check install-git-hooks \
	benchmark-local-ai-high-potential benchmark-local-ai-high-potential-unit \
	benchmark-local-ai-high-potential-integration benchmark-local-ai-high-potential-simulated \
	benchmark-local-ai-high-potential-local-ai benchmark-local-ai-high-potential-dashboard \
	benchmark-local-ai-high-potential-recompute \
	benchmark-local-ai-quality-bakeoff-unit benchmark-local-ai-quality-bakeoff-calibration \
	benchmark-local-ai-quality-bakeoff-regression benchmark-local-ai-quality-bakeoff-holdout \
	benchmark-local-ai-quality-bakeoff-verifier benchmark-local-ai-quality-bakeoff \
	local-ai-pivot-help validate-local-ai-pivot \
	benchmark-local-ai-structured-extraction-calibration benchmark-local-ai-structured-extraction-holdout \
	benchmark-local-ai-structured-extraction benchmark-local-ai-summarize-log-calibration \
	benchmark-local-ai-summarize-log-holdout benchmark-local-ai-summarize-log \
	benchmark-local-ai-retrieval-calibration benchmark-local-ai-retrieval-holdout \
	benchmark-local-ai-retrieval benchmark-local-ai-error-similarity benchmark-local-ai-restricted-pivot \
	local-ai-structured-extraction-canary-audit install-local-ai-runtime

PUBLIC_VALIDATION_TARGETS := validate-dependencies validate-compose validate-json \
	validate-yaml validate-shell validate-docs validate-assets validate-security \
	validate-privacy validate-memory validate-node-red validate-bridge validate-local-ai \
	validate-homeassistant \
	validate-scripts validate-scheduler validate-auto-update validate-modules \
	validate-restore validate-bootstrap validate-demo validate-git validate-commit-message

BACKUP_DIR ?=
DESTINATION ?=
CONFIRM ?=
ALLOW_NON_CANARY ?=
MODULES ?= core
HIGH_POTENTIAL_BENCHMARK_OUTPUT_DIR ?= docs/benchmarks/local-ai-high-potential
HIGH_POTENTIAL_BENCHMARK_SIMULATED_OUTPUT_DIR ?= /tmp/local-ai-high-potential-simulated
QUALITY_BAKEOFF_RUN_ID ?=
QUALITY_BAKEOFF_MODELS ?= current_baseline,qwen3_8_27b,north_mini_code_1_0,devstral_small_2_24b,qwen3_coder_next_optional
LOCAL_AI_PIVOT_RUN_ID ?=

validate-public:
	@./scripts/run-resource-safe.sh $(MAKE) --no-print-directory $(PUBLIC_VALIDATION_TARGETS)

validate-dependencies:
	npm --prefix validation ci --ignore-scripts --no-audit --no-fund

validate-compose:
	docker compose --env-file .env.example -f docker-compose.yml -f compose.modules.yml config --quiet
	docker compose --env-file .env.example -f docker-compose.yml -f compose.modules.yml --profile '*' config --quiet
	node scripts/compose-matrix-check.mjs

validate-json:
	node scripts/structured-files-check.mjs json

validate-yaml:
	node scripts/structured-files-check.mjs yaml

validate-shell:
	@set -eu; git ls-files '*.sh' | while IFS= read -r file; do \
		case "$$(head -n 1 "$$file")" in *bash*) bash -n "$$file" ;; *) sh -n "$$file" ;; esac; \
	done; echo "Shell syntax check passed."

validate-docs:
	node scripts/docs-check.mjs

validate-assets:
	node scripts/assets-check.mjs

validate-security:
	bash scripts/security-scan.sh

validate-privacy:
	node scripts/privacy-check.mjs
	node scripts/public-bindings-check.mjs

validate-memory:
	node scripts/public-memory-check.mjs
	node scripts/ai-context-recovery.mjs --worktree

validate-node-red:
	npm --prefix nodered ci --ignore-scripts --no-audit --no-fund
	npm --prefix nodered run flows:validate
	node --check nodered/settings.js
	npm --prefix nodered run test:all

validate-bridge:
	npm --prefix ia-bridge test

validate-local-ai:
	python3 -m unittest discover -s scripts/local-ai -p 'test_*.py'

benchmark-local-ai-high-potential-unit:
	python3 scripts/local-ai/high_potential_dataset.py --check
	python3 scripts/local-ai/test_high_potential_benchmark.py HighPotentialBenchmarkUnitTests

benchmark-local-ai-high-potential-integration:
	python3 scripts/local-ai/test_high_potential_benchmark.py HighPotentialBenchmarkIntegrationTests

benchmark-local-ai-high-potential-simulated:
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/high_potential_benchmark.py --mode simulated --quiet --output-dir "$(HIGH_POTENTIAL_BENCHMARK_SIMULATED_OUTPUT_DIR)"

benchmark-local-ai-high-potential-recompute:
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/high_potential_benchmark.py --quiet \
		--recompute-existing docs/benchmarks/local-ai-high-potential/history/v1-2026-08-24/latest.json \
		--output-dir "$(HIGH_POTENTIAL_BENCHMARK_OUTPUT_DIR)"

benchmark-local-ai-high-potential-local-ai:
	uptime
	free -h
	df -h /
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/high_potential_benchmark.py --mode local-ai --quiet --output-dir "$(HIGH_POTENTIAL_BENCHMARK_OUTPUT_DIR)"

benchmark-local-ai-high-potential-dashboard:
	node --test ia-bridge/usage.test.js
	python3 -m unittest homeassistant.tests.test_chat_rtx_dashboard_layout homeassistant.tests.test_dashboard_number_formatting

benchmark-local-ai-high-potential: benchmark-local-ai-high-potential-unit \
	benchmark-local-ai-high-potential-integration benchmark-local-ai-high-potential-simulated \
	benchmark-local-ai-high-potential-dashboard benchmark-local-ai-high-potential-local-ai

benchmark-local-ai-quality-bakeoff-unit:
	python3 scripts/local-ai/quality_bakeoff_dataset.py --check
	python3 scripts/local-ai/test_model_registry.py
	python3 scripts/local-ai/test_quality_bakeoff.py

benchmark-local-ai-quality-bakeoff-calibration:
	@test -n "$(QUALITY_BAKEOFF_RUN_ID)" || (echo "QUALITY_BAKEOFF_RUN_ID is required" >&2; exit 2)
	uptime
	free -h
	df -h /
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/quality_bakeoff.py \
		--phase calibration --run-id "$(QUALITY_BAKEOFF_RUN_ID)" --models "$(QUALITY_BAKEOFF_MODELS)"

benchmark-local-ai-quality-bakeoff-regression:
	@test -n "$(QUALITY_BAKEOFF_RUN_ID)" || (echo "QUALITY_BAKEOFF_RUN_ID is required" >&2; exit 2)
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/quality_bakeoff.py \
		--phase regression --run-id "$(QUALITY_BAKEOFF_RUN_ID)" --models "$(QUALITY_BAKEOFF_MODELS)"

benchmark-local-ai-quality-bakeoff-holdout:
	@test -n "$(QUALITY_BAKEOFF_RUN_ID)" || (echo "QUALITY_BAKEOFF_RUN_ID is required" >&2; exit 2)
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/quality_bakeoff.py \
		--phase holdout --run-id "$(QUALITY_BAKEOFF_RUN_ID)" --models "$(QUALITY_BAKEOFF_MODELS)"

benchmark-local-ai-quality-bakeoff-verifier:
	@test -n "$(QUALITY_BAKEOFF_RUN_ID)" || (echo "QUALITY_BAKEOFF_RUN_ID is required" >&2; exit 2)
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/quality_bakeoff.py \
		--phase verifier --run-id "$(QUALITY_BAKEOFF_RUN_ID)" --models "$(QUALITY_BAKEOFF_MODELS)"

benchmark-local-ai-quality-bakeoff: benchmark-local-ai-quality-bakeoff-unit \
	benchmark-local-ai-quality-bakeoff-calibration benchmark-local-ai-quality-bakeoff-regression \
	benchmark-local-ai-quality-bakeoff-holdout benchmark-local-ai-quality-bakeoff-verifier

local-ai-pivot-help:
	@echo "validate-local-ai-pivot: validate frozen datasets, harness, runtime, flags and artifacts"
	@echo "benchmark-local-ai-structured-extraction: run 25 calibration + 100 holdout cases"
	@echo "benchmark-local-ai-summarize-log: run 30 calibration + 90 holdout A/B/C log cases"
	@echo "benchmark-local-ai-retrieval: run 30 calibration + 150 holdout snapshot cases"
	@echo "benchmark-local-ai-error-similarity: finalize Phase D only when the retrieval gate allows it"
	@echo "benchmark-local-ai-restricted-pivot: run all phases sequentially with LOCAL_AI_PIVOT_RUN_ID=<uuid>"

validate-local-ai-pivot:
	python3 scripts/local-ai/pivot_dataset.py --check
	python3 scripts/local-ai/test_pivot_benchmark.py
	python3 scripts/local-ai/test_restricted_runtime.py
	python3 scripts/local-ai/test_model_registry.py
	python3 scripts/local-ai/test_post_tool_routing.py
	python3 scripts/local-ai/test_canary_state.py
	python3 scripts/local-ai/test_structured_canary.py
	python3 scripts/local-ai/test_mcp_server.py

local-ai-structured-extraction-canary-audit:
	python3 scripts/local-ai/structured_canary.py audit \
		--json docs/benchmarks/local-ai-structured-extraction-canary/latest-operational-summary.json \
		--markdown docs/benchmarks/local-ai-structured-extraction-canary/report.md

install-local-ai-runtime:
	@test -n "$(LOCAL_AI_RUNTIME_TARGET)" || (echo "LOCAL_AI_RUNTIME_TARGET is required" >&2; exit 2)
	./scripts/local-ai/install-runtime.sh --target "$(LOCAL_AI_RUNTIME_TARGET)"

benchmark-local-ai-structured-extraction-calibration:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	uptime
	free -h
	df -h /
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/pivot_benchmark.py structured-extraction \
		--phase calibration --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-structured-extraction-holdout:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/pivot_benchmark.py structured-extraction \
		--phase promotion_holdout --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-structured-extraction:
	@$(MAKE) --no-print-directory benchmark-local-ai-structured-extraction-calibration LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"
	@$(MAKE) --no-print-directory benchmark-local-ai-structured-extraction-holdout LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-summarize-log-calibration:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	uptime
	free -h
	df -h /
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/pivot_benchmark.py summarize-log \
		--phase calibration --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-summarize-log-holdout:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/pivot_benchmark.py summarize-log \
		--phase promotion_holdout --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-summarize-log:
	@$(MAKE) --no-print-directory benchmark-local-ai-summarize-log-calibration LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"
	@$(MAKE) --no-print-directory benchmark-local-ai-summarize-log-holdout LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-retrieval-calibration:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	uptime
	free -h
	df -h /
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/pivot_benchmark.py retrieval \
		--phase calibration --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-retrieval-holdout:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	@./scripts/run-resource-safe.sh python3 scripts/local-ai/pivot_benchmark.py retrieval \
		--phase promotion_holdout --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-retrieval:
	@$(MAKE) --no-print-directory benchmark-local-ai-retrieval-calibration LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"
	@$(MAKE) --no-print-directory benchmark-local-ai-retrieval-holdout LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-error-similarity:
	@test -n "$(LOCAL_AI_PIVOT_RUN_ID)" || (echo "LOCAL_AI_PIVOT_RUN_ID is required" >&2; exit 2)
	python3 scripts/local-ai/pivot_finalize.py --run-id "$(LOCAL_AI_PIVOT_RUN_ID)"

benchmark-local-ai-restricted-pivot:
	@$(MAKE) --no-print-directory validate-local-ai-pivot
	@$(MAKE) --no-print-directory benchmark-local-ai-structured-extraction LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"
	@$(MAKE) --no-print-directory benchmark-local-ai-summarize-log LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"
	@$(MAKE) --no-print-directory benchmark-local-ai-retrieval LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"
	@$(MAKE) --no-print-directory benchmark-local-ai-error-similarity LOCAL_AI_PIVOT_RUN_ID="$(LOCAL_AI_PIVOT_RUN_ID)"

validate-homeassistant:
	python3 -m unittest discover -s homeassistant/tests -p 'test_*.py'

validate-scripts:
	node scripts/test-all.mjs

validate-scheduler:
	node scripts/weekly-docs-review.mjs --self-test

validate-auto-update:
	node --test scripts/docker-auto-update.test.mjs

validate-modules:
	node scripts/modules-check.mjs

validate-restore: restore-test

validate-bootstrap: bootstrap-test

validate-demo: demo-test

validate-git:
	git diff --check

validate-commit-message:
	node scripts/commit-message-check.mjs HEAD

install-git-hooks:
	@./scripts/install-git-hooks.sh

validate-staged:
	bash scripts/security-scan.sh --staged
	node scripts/privacy-check.mjs --staged
	git diff --cached --check

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
	node --test scripts/restore.test.mjs scripts/restore-prompt.test.mjs

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
