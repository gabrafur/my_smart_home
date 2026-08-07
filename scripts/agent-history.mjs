#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const historyFile = process.env.AGENT_HISTORY_FILE
  || path.join(root, '.agent-history', 'turns.jsonl');

function readTurns() {
  if (!fs.existsSync(historyFile)) return [];
  return fs.readFileSync(historyFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function compact(value, length = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function list(turns) {
  const conversations = new Map();
  for (const turn of turns) {
    const key = `${turn.agent}:${turn.conversation_id || '(sem-id)'}`;
    const item = conversations.get(key) || { count: 0 };
    item.count += 1;
    item.lastAt = turn.timestamp;
    item.prompt = turn.prompt;
    conversations.set(key, item);
  }

  const rows = [...conversations.entries()]
    .sort(([, a], [, b]) => b.lastAt.localeCompare(a.lastAt));
  if (!rows.length) {
    console.log('Nenhuma conversa compartilhada registrada.');
    return;
  }
  for (const [key, item] of rows) {
    console.log(`${item.lastAt}  ${String(item.count).padStart(3)}  ${key}  ${compact(item.prompt)}`);
  }
}

function show(turns, conversationId, requestedAgent) {
  const selected = turns.filter((turn) => (
    turn.conversation_id === conversationId
    && (!requestedAgent || turn.agent === requestedAgent)
  ));
  if (!selected.length) {
    console.error(`Conversa não encontrada: ${conversationId}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# Histórico compartilhado: ${conversationId}\n`);
  for (const turn of selected) {
    console.log(`## ${turn.timestamp} — ${turn.agent}\n`);
    console.log(`**Usuário**\n\n${turn.prompt}\n`);
    console.log(`**Assistente**\n\n${turn.reply}\n`);
  }
}

const [command = 'list', conversationId, requestedAgent] = process.argv.slice(2);
const turns = readTurns();
if (command === 'list') {
  list(turns);
} else if (command === 'show' && conversationId) {
  show(turns, conversationId, requestedAgent);
} else {
  console.error('Uso: node scripts/agent-history.mjs list | show <conversation_id> [claude|codex]');
  process.exitCode = 2;
}
