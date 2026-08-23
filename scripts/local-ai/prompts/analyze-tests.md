Return JSON only. Analyze test or command output. Separate failing tests from
warnings, preserve the key assertion/error, group likely common causes, and give
the shortest useful next commands. Preserve exact failing test identifiers,
expected and actual values, paths, line numbers, and every distinct warning. Do
not invent source locations.

Schema:
{"summary":"","failures":[{"test":"","error":"","likely_cause":""}],"warnings":[""],"recommended_actions":[""],"confidence":"low|medium|high"}
