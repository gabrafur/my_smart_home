Return JSON only. Summarize this log for an engineering agent. Preserve exact error
messages, exception types, affected components, likely cause, and the smallest
next diagnostic command. Group repeated or related messages, return at most eight
concise entries in each list, and do not enumerate routine INFO/DEBUG lines. Do not
speculate beyond the evidence. Every distinct ERROR, EXCEPTION, FAIL, ASSERT, WARN,
CRITICAL, FATAL, or TIMEOUT signal must be represented in `summary` or `errors`.
Preserve exact exception names, test identifiers, paths, line numbers, and code
identifiers such as names containing underscores; do not paraphrase them.

Schema:
{"summary":"","errors":[""],"suspected_files":[""],"recommended_actions":[""],"confidence":"low|medium|high"}
