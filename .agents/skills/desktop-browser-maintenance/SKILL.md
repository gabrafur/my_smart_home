---
name: desktop-browser-maintenance
description: Use an existing authenticated Windows desktop browser to refresh a connected MCP catalogue or perform owner-authorized assistant chat tests; verify interactive control and preserve operation receipts.
---

Use the existing desktop transport and logged-in browser when the owner has authorized that use. Consult the private runtime at `.local-state/desktop-browser-tool/AUTHORIZATION.md` and `tool.py`; these files are machine-local and must not be published. Do not copy account identifiers, browser content, authorizations or credentials into public memory.

Run `python3 -B .local-state/desktop-browser-tool/tool.py status` first. The fixed `selection-test` action checks interactive tab selection and restores the prior selection. It returns an operation ID; poll that exact ID using `inspect --operation-id ID` until terminal. An uncertain result permits inspection only. The helper prevents a new test while an earlier operation remains nonterminal or unknown.

The proven interactive route uses the existing SSH configuration with strict host-key verification, a short encoded PowerShell bootstrap with a hash-checked stdin payload, and a one-time task under the existing interactive user with a limited token. Do not enable a debugging listener, weaken host-key checks or launch a second browser profile to reach account data.

Tab selection proves UI control only. Catalogue refresh and assistant messages require their own bounded, target-checked action and post-action verification. The current fixed helper does not implement those actions. For an authorized follow-up, prepare a task-specific interactive runner, verify the exact target page and relevant controls, and record a durable intent before the single effect. Inspect an uncertain send instead of resending it. Keep test prompts explicit about being diagnostics, avoid sensitive data, and verify the assistant response and real tool receipts. A page shell or accepted webhook is insufficient.

The owner may authorize use of the desktop ChatGPT/Codex clients for extra compute. Check actual availability and repository rules first; do not claim subagents, GPU inference or remote processing without execution evidence. Keep residential host load within its current limits and leave unrelated services and browser state intact.
