const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SharedHistoryStore } = require('./history');

test('persists sessions and filters shared turns', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = new SharedHistoryStore(directory);
  store.initialize();
  store.setSession('codex:conversation-1', 'session-1');
  store.appendTurn({
    agent: 'codex',
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    prompt: 'primeiro',
    reply: 'resposta 1',
    status: 'success',
  });
  store.appendTurn({
    agent: 'claude',
    conversationId: 'conversation-2',
    sessionId: 'session-2',
    prompt: 'segundo',
    reply: 'resposta 2',
    status: 'success',
  });

  const reloaded = new SharedHistoryStore(directory);
  reloaded.initialize();
  assert.equal(reloaded.getSession('codex:conversation-1'), 'session-1');
  assert.equal(fs.statSync(reloaded.sessionsPath).mode & 0o777, 0o660);
  assert.equal(fs.statSync(reloaded.turnsPath).mode & 0o777, 0o660);
  assert.deepEqual(
    reloaded.readTurns({ agent: 'codex' }).map((turn) => turn.prompt),
    ['primeiro'],
  );
  assert.deepEqual(reloaded.listConversations().map((item) => item.agent).sort(), [
    'claude',
    'codex',
  ]);
});

test('ignores an incomplete JSONL line', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SharedHistoryStore(directory);
  store.initialize();
  store.appendTurn({
    agent: 'codex',
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    prompt: 'válido',
    reply: 'ok',
    status: 'success',
  });
  fs.appendFileSync(store.turnsPath, '{incompleto');

  assert.equal(store.readTurns().length, 1);
});
