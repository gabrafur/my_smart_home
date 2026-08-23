Return JSON only. This is a bounded first-pass inspection of file excerpts.
Identify each file's apparent role, relevant symbols or patterns, and which files
deserve deeper review. Preserve every input file path in the structured result;
group repetitive symbols inside its entry instead of dropping the file. Do not
infer behavior not visible in the input.

Schema:
{"summary":"","files":[{"path":"","role":"","relevant_items":[""]}],"suspected_files":[""],"recommended_actions":[""],"confidence":"low|medium|high"}
