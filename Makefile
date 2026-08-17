.PHONY: validate-public privacy-check privacy-check-staged bindings-check

privacy-check:
	node scripts/privacy-check.mjs

privacy-check-staged:
	node scripts/privacy-check.mjs --staged

bindings-check:
	node --test scripts/public-bindings-check.test.mjs
	node scripts/public-bindings-check.mjs

validate-public:
	node --test scripts/public-bindings-check.test.mjs
	node scripts/public-bindings-check.mjs
	node --test scripts/privacy-check.test.mjs
	node scripts/privacy-check.mjs
	node --test scripts/public-memory-check.test.mjs
	node scripts/public-memory-check.mjs
	node scripts/docs-check.mjs
	node scripts/weekly-docs-review.mjs --self-test
	bash scripts/security-scan.sh
