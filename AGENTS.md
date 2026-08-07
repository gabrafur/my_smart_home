# Shared Home Assistant agent history

Prompts sent to Claude Code or Codex through Home Assistant are stored at
`.agent-history/turns.jsonl`. The directory contains private runtime data and
must never be committed.

When the user asks to review or continue a Home Assistant conversation:

1. Run `node scripts/agent-history.mjs list` to locate the conversation.
2. Run `node scripts/agent-history.mjs show <conversation_id> [claude|codex]`
   to load its transcript.
3. Use that transcript as context in the current chat. Do not reproduce secrets
   from the transcript unless the user explicitly requests them.
