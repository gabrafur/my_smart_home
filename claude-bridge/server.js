const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8099;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const WORKDIR = process.env.WORKDIR || '/workspace';
const TIMEOUT_MS = Number(
  process.env.BRIDGE_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MS || 5 * 60 * 1000,
);

if (!BRIDGE_TOKEN) {
  console.error('BRIDGE_TOKEN not set, refusing to start');
  process.exit(1);
}

// agent + conversation_id (from Home Assistant) -> CLI session id.
const sessions = new Map();

function ensureClaudeWorkspaceTrust() {
  const configPath = path.join(os.homedir(), '.claude.json');
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Could not read ${configPath}; recreating it: ${err.message}`);
    }
  }

  config.projects = config.projects || {};
  config.projects[WORKDIR] = config.projects[WORKDIR] || {};
  if (config.projects[WORKDIR].hasTrustDialogAccepted !== true) {
    config.projects[WORKDIR].hasTrustDialogAccepted = true;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`Claude workspace trust recorded for ${WORKDIR}`);
  }
}

function spawnCli(command, args) {
  const child = spawn(command, args, {
    cwd: WORKDIR,
    env: process.env,
  });

  // Both prompts are command-line arguments. Closing stdin immediately avoids
  // CLIs waiting for piped input in this non-interactive HTTP service.
  child.stdin.end();
  return child;
}

function runClaude(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(message);

    const child = spawnCli('claude', args);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      // Claude Code can exit non-zero while still emitting a valid JSON
      // result on stdout (e.g. billing/auth errors) - prefer that over stderr.
      try {
        resolve(JSON.parse(stdout));
        return;
      } catch {
        // fall through to raw failure below
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).slice(-2000)}`));
        return;
      }
      reject(new Error(`failed to parse claude output:\n${stdout.slice(-2000)}`));
    });
  });
}

function parseCodexJsonLines(stdout) {
  let sessionId = null;
  let reply = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'thread.started' && event.thread_id) {
      sessionId = event.thread_id;
    }
    if (
      event.type === 'item.completed'
      && event.item?.type === 'agent_message'
      && typeof event.item.text === 'string'
    ) {
      reply = event.item.text;
    }
  }

  return { sessionId, reply };
}

function runCodex(message, sessionId) {
  return new Promise((resolve, reject) => {
    const accessArgs = ['--json', '--dangerously-bypass-approvals-and-sandbox'];
    const args = sessionId
      ? ['exec', 'resume', sessionId, ...accessArgs, message]
      : ['exec', ...accessArgs, message];
    const child = spawnCli('codex', args);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codex timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseCodexJsonLines(stdout);
      if (code !== 0) {
        reject(new Error(`codex exited with code ${code}: ${(stderr || stdout).slice(-2000)}`));
        return;
      }
      if (!parsed.reply) {
        reject(new Error(`failed to parse codex output:\n${stdout.slice(-2000)}`));
        return;
      }
      resolve({ result: parsed.reply, session_id: parsed.sessionId || sessionId });
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${BRIDGE_TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    const message = payload.message;
    const conversationId = payload.conversation_id || null;
    const agent = payload.agent || 'claude';
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing message' }));
      return;
    }
    if (!['claude', 'codex'].includes(agent)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported agent' }));
      return;
    }

    const sessionKey = conversationId ? `${agent}:${conversationId}` : null;
    const priorSessionId = sessionKey ? sessions.get(sessionKey) : null;

    try {
      const result = agent === 'codex'
        ? await runCodex(message, priorSessionId)
        : await runClaude(message, priorSessionId);
      if (sessionKey && result.session_id) {
        sessions.set(sessionKey, result.session_id);
      }
      const reply = result.result || result.response || JSON.stringify(result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      console.error(err);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const agentName = agent === 'codex' ? 'Codex' : 'Claude Code';
      res.end(JSON.stringify({ reply: `Erro ao executar ${agentName}: ${err.message}` }));
    }
  });
});

ensureClaudeWorkspaceTrust();

server.listen(PORT, () => {
  console.log(`agent bridge listening on :${PORT}, workdir=${WORKDIR}`);
});
