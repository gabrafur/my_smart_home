---
name: desktop-browser-maintenance
description: Access Eva directly from the Raspberry browser, diagnose access and authentication, or use an explicitly authorized existing Windows browser for catalogue refresh and assistant chat tests.
---

## Direct Raspberry access

Prefer the Raspberry route for Eva checks. When the owner excludes the desktop, do not invoke its SSH transport, wake it, or copy its cookies. Use the existing system Chromium with an independent persistent profile. Its ChatGPT login is separate from the desktop browser and from the Codex CLI account.

First inspect the private interactive session metadata. If its recorded processes are alive, use that existing graphical browser and the native UI procedure below instead of launching the probe. Capture with `scrot -o` so repeat inspections overwrite the intended capture rather than silently creating a suffixed file. Verify the visible address and target conversation before sending. A transient unavailable-conversation screen can clear after normal interactive verification; do not declare the saved URL obsolete from that screen alone.

For owner login or recurring Cloudflare challenges, use the normal Chromium launched by the private `interactive.py`, without Playwright. Preserve an existing healthy session. The Playwright probe is optional diagnostics, not the default authentication route: run `xvfb-run -a node scripts/eva-browser-probe.cjs` only when no browser owns the profile, with `headless: false` in the private configuration. Use graphical Chromium for the authenticated profile; switching to headless can trigger a fresh access challenge. The machine-private runtime lives under `$HOME/.local/share/eva-direct-browser/`: `config.json` contains `url` (the exact owner-provided Eva URL), `executablePath` (the installed Chromium), and `profile` (an absolute private profile directory). Obtain the URL from the existing private target configuration when available; never publish it. The runtime also contains a pinned `playwright-core` installation and private operation receipts. Install missing dependencies only when authorized and within the host resource limits; reuse system Chromium rather than downloading another browser.

The probe uses local browser automation without opening a debugging listener, sending a message, or contacting the desktop. It records HTTP status, target matching and access classification, without printing conversation text. DOM and screenshots stay private. Inspect its result before proceeding:

- `access_challenge`: the site is displaying an access challenge; stop and report the block. Do not call the page healthy or attempt to bypass the challenge.
- `login_required`: the Raspberry profile needs the owner's normal interactive login. Do not request passwords, reuse desktop cookies, or assume Codex authentication grants ChatGPT access.
- `target_ui_detected`: the exact target and a chat composer are visible; this proves interface access only.
- `conversation_unavailable`: the site says the conversation cannot be opened. Verify the current owner-provided link and account access; do not infer deletion or recreate the assistant.
- `unverified_page` or `browser_error`: preserve the receipt and report the uncertainty.

An HTTP 200 or page shell does not prove authentication, a response from Eva, MCP execution, or autonomous operation. An authorized functional test needs a separate single-send action with durable intent, target verification, response readback, and independent tool receipts. The probe deliberately does not send. If interactive login is required, arrange an owner-accessible local graphical session separately; the probe does not expose the profile over the network.

The installed machine-private `interactive.py` in the same runtime directory provides an owner-operated Chromium session using Xvfb, password-protected x11vnc and noVNC. Both listeners bind to loopback; access uses a private Tailscale Serve HTTPS proxy, never Funnel. Inspect `interactive-session.json` for readiness and expiry; its password is private. The session expires after one hour and closes its processes and proxy. It holds `probe.lock`: do not run another browser concurrently or remove the lock while the session is alive. After the owner finishes verification and login, preserve that live browser: inspect its screen using `scrot` and use `xdotool` for authorized native UI interaction with its existing DISPLAY and XAUTHORITY. Keep captures private. Restarting the browser or switching to Playwright/headless can trigger another challenge even when login cookies persist. Only stop the supervisor with SIGINT when the interactive work is finished, and wait for cleanup before launching another browser. Do not treat remote-screen availability as proof of Eva access.

## Eva acceptance after MCP deployment

After each deployment that changes Raspberry plugin capabilities, use Eva's
authenticated graphical session to exercise a previously blocked capability.
Verify separately the catalogue, the tool call actually executed, and its result
with an independent server receipt. Record the deployed version/hash, a unique
reference and the limits of the evidence. A visible tool or textual reply alone
does not prove execution; missing correlation remains pending. Preserve uncertain
intents and inspect the same operation rather than resending it.

Use admitted observation or dry-run operations. Household effects, new access and
equipment tests still require their specific authorizations and interface
confirmations. Do not duplicate repairs to test a capability. Keep the browser
open and preserve existing drafts and unrelated conversation state.

## Existing Windows desktop route

Use the existing desktop transport and logged-in browser only when the owner has authorized that route for the current request. Consult the private runtime at `.local-state/desktop-browser-tool/AUTHORIZATION.md` and `tool.py`; these files are machine-local and must not be published. Do not copy account identifiers, browser content, authorizations or credentials into public memory.

Run `python3 -B .local-state/desktop-browser-tool/tool.py status` first. The fixed `selection-test` action checks interactive tab selection and restores the prior selection. It returns an operation ID; poll that exact ID using `inspect --operation-id ID` until terminal. An uncertain result permits inspection only. The helper prevents a new test while an earlier operation remains nonterminal or unknown.

The proven interactive route uses the existing SSH configuration with strict host-key verification, a short encoded PowerShell bootstrap with a hash-checked stdin payload, and a one-time task under the existing interactive user with a limited token. Do not enable a debugging listener, weaken host-key checks or launch a second browser profile to reach account data.

Tab selection proves UI control only. Catalogue refresh and assistant messages require their own bounded, target-checked action and post-action verification. The current fixed helper does not implement those actions. For an authorized follow-up, prepare a task-specific interactive runner, verify the exact target page and relevant controls, and record a durable intent before the single effect. Inspect an uncertain send instead of resending it. Keep test prompts explicit about being diagnostics, avoid sensitive data, and verify the assistant response and real tool receipts. A page shell or accepted webhook is insufficient.

The owner may authorize use of the desktop ChatGPT/Codex clients for extra compute. Check actual availability and repository rules first; do not claim subagents, GPU inference or remote processing without execution evidence. Keep residential host load within its current limits and leave unrelated services and browser state intact.
