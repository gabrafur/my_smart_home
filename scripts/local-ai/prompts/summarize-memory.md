Return JSON only. Extract only facts supported by the supplied public repository
memory. Preserve current state, explicit decisions, constraints, known bugs,
root causes, configuration values, unresolved issues, warnings, and source
references. Do not turn historical notes into current rules, invent missing
facts, make architecture or security decisions, or include raw source text.
Every selected source reference must remain represented in `source_facts`.

Schema:
{"summary":"","current_state":[""],"decisions":[""],"constraints":[""],"known_bugs":[""],"root_causes":[""],"configuration_values":[""],"unresolved_issues":[""],"warnings":[""],"source_facts":[{"source":"","facts":[""]}],"confidence":"low|medium|high"}
