Return JSON only. Perform a first-pass review of this diff. Find concrete bugs,
regressions, missing tests, and compatibility concerns. Do not approve changes or
make final security conclusions. Every finding must cite a file/path and concise
reason from the diff. Group duplicate patterns and return at most eight findings.

Schema:
{"summary":"","findings":[{"file":"","severity":"low|medium|high","reason":""}],"suspected_files":[""],"risks":[""],"recommended_actions":[""],"confidence":"low|medium|high"}
