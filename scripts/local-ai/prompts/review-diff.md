Return JSON only. Perform a first-pass review of this diff. Find concrete bugs,
regressions, missing tests, and compatibility concerns. Do not approve changes or
make final security conclusions. Every finding must cite a file/path and concise
reason from the diff. Group duplicate patterns and return at most eight findings.
Distinguish removed (`-`) from added (`+`) lines: describe the behavior after
the change and never report behavior present only in a removed line as newly
introduced.
Preserve exact identifiers and changed expressions for unit conversions,
timeouts, permissions, validation, and ownership guards. A removed guard and an
added expression must never be described with the opposite direction.

Schema:
{"summary":"","findings":[{"file":"","severity":"low|medium|high","reason":""}],"suspected_files":[""],"risks":[""],"recommended_actions":[""],"confidence":"low|medium|high"}
