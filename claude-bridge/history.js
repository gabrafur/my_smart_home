const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class SharedHistoryStore {
  constructor(directory) {
    this.directory = directory;
    this.turnsPath = path.join(directory, 'turns.jsonl');
    this.sessionsPath = path.join(directory, 'sessions.json');
    this.sessions = new Map();
  }

  initialize() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o2770 });
    for (const filePath of [this.turnsPath, this.sessionsPath]) {
      try {
        fs.chmodSync(filePath, 0o660);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    try {
      const saved = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'));
      for (const [key, sessionId] of Object.entries(saved)) {
        if (typeof key === 'string' && typeof sessionId === 'string') {
          this.sessions.set(key, sessionId);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`failed to load shared sessions: ${err.message}`);
      }
    }
  }

  getSession(key) {
    return key ? this.sessions.get(key) || null : null;
  }

  setSession(key, sessionId) {
    if (!key || !sessionId) return;

    this.sessions.set(key, sessionId);
    const temporaryPath = `${this.sessionsPath}.${process.pid}.tmp`;
    const serialized = `${JSON.stringify(Object.fromEntries(this.sessions), null, 2)}\n`;
    fs.writeFileSync(temporaryPath, serialized, { mode: 0o660 });
    fs.renameSync(temporaryPath, this.sessionsPath);
  }

  appendTurn({ agent, conversationId, sessionId, prompt, reply, status }) {
    const turn = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agent,
      conversation_id: conversationId,
      session_id: sessionId || null,
      status,
      prompt,
      reply,
    };
    fs.appendFileSync(this.turnsPath, `${JSON.stringify(turn)}\n`, { mode: 0o660 });
    return turn;
  }

  readTurns({ agent = null, conversationId = null, limit = 50 } = {}) {
    let contents;
    try {
      contents = fs.readFileSync(this.turnsPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const turns = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const turn = JSON.parse(line);
        if (agent && turn.agent !== agent) continue;
        if (conversationId && turn.conversation_id !== conversationId) continue;
        turns.push(turn);
      } catch {
        // A partially written final line must not make all prior history unreadable.
      }
    }
    return turns.slice(-limit);
  }

  listConversations({ agent = null, limit = 100 } = {}) {
    const grouped = new Map();
    for (const turn of this.readTurns({ agent, limit: Number.MAX_SAFE_INTEGER })) {
      const key = `${turn.agent}:${turn.conversation_id || ''}`;
      const item = grouped.get(key) || {
        agent: turn.agent,
        conversation_id: turn.conversation_id,
        turn_count: 0,
      };
      item.turn_count += 1;
      item.last_at = turn.timestamp;
      item.last_prompt = turn.prompt;
      item.last_reply = turn.reply;
      grouped.set(key, item);
    }
    return [...grouped.values()]
      .sort((a, b) => b.last_at.localeCompare(a.last_at))
      .slice(0, limit);
  }
}

module.exports = { SharedHistoryStore };
