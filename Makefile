.PHONY: validate-public

validate-public:
	node --test scripts/public-memory-check.test.mjs
	node scripts/public-memory-check.mjs
	node scripts/docs-check.mjs
	node scripts/weekly-docs-review.mjs --self-test
	bash scripts/security-scan.sh
