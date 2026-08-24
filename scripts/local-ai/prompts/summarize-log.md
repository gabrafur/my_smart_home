Return JSON only. Select evidence from this log for an engineering agent. Copy
every ERROR, EXCEPTION, FAIL, ASSERT, WARN, CRITICAL, FATAL, or TIMEOUT line
exactly into `errors`, including an immediately adjacent stack/path line. Input
lines have IDs such as `L0001`. Select one to four representative INFO/DEBUG or
other non-signal lines and put only their IDs in `routine_context`; never put an
ERROR/WARN/FAIL/TIMEOUT line there. Keep `summary` concise, use only
facts present in the input, and do not speculate. List only paths that occur in
the input. Leave `recommended_actions` empty because the primary model will make
diagnostic decisions from the extractive evidence.

Schema:
{"summary":"","errors":[""],"routine_context":["L0001"],"suspected_files":[""],"recommended_actions":[],"confidence":"low|medium|high"}
