const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedHistoryStore } = require('./history');
const { CodexUsageReader } = require('./usage');
const {
  codexExecOptions,
  codexSessionKey,
  validateCodexOptions,
} = require('./codex-options');

const PORT = process.env.PORT || 8099;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const WORKDIR = process.env.WORKDIR || '/workspace';
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(WORKDIR, '.agent-history');
const CODEX_SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR
  || path.join(os.homedir(), '.codex', 'sessions');
const TIMEOUT_MS = Number(
  process.env.BRIDGE_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MS || 15 * 60 * 1000,
);
const LOCAL_AI_HEALTH_REFRESH_MS = Math.min(
  Math.max(Number(process.env.LOCAL_AI_HEALTH_REFRESH_MS || 60_000), 30_000),
  5 * 60 * 1000,
);

if (!BRIDGE_TOKEN) {
  console.error('BRIDGE_TOKEN not set, refusing to start');
  process.exit(1);
}

const history = new SharedHistoryStore(HISTORY_DIR);
const codexUsage = new CodexUsageReader(
  CODEX_SESSIONS_DIR,
  process.env.LOCAL_AI_TELEMETRY_PATH || path.join(HISTORY_DIR, 'local-ai-telemetry.json'),
  process.env.LOCAL_AI_STATUS_PATH || path.join(HISTORY_DIR, 'local-ai-status.json'),
  1_000,
);
const sessionQueues = new Map();

function enqueueSession(sessionKey, task) {
  if (!sessionKey) return task();
  const previous = sessionQueues.get(sessionKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  sessionQueues.set(sessionKey, current);
  return current.finally(() => {
    if (sessionQueues.get(sessionKey) === current) sessionQueues.delete(sessionKey);
  });
}

function clampLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), maximum) : fallback;
}

function saveSession(key, sessionId) {
  try {
    history.setSession(key, sessionId);
  } catch (err) {
    console.error(`Failed to persist session ${key}: ${err.message}`);
  }
}

function recordTurn(turn) {
  try {
    return history.appendTurn(turn);
  } catch (err) {
    console.error(`Failed to append shared history: ${err.message}`);
    return null;
  }
}

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
    detached: true,
  });

  // Both prompts are command-line arguments. Closing stdin immediately avoids
  // CLIs waiting for piped input in this non-interactive HTTP service.
  child.stdin.end();
  return child;
}

function localAiPreflightCommand() {
  const fallback = path.join(os.homedir(), '.codex', 'hooks', 'local-ai-preflight.mjs');
  const configPath = process.env.LOCAL_AI_CONFIG;
  if (!configPath) return fs.existsSync(fallback) ? fallback : null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const command = typeof config.preflight_command === 'string'
      ? config.preflight_command.trim()
      : '';
    if (command && path.isAbsolute(command) && fs.existsSync(command)) return command;
    if (fs.existsSync(fallback)) {
      console.warn('Configured Local AI preflight command is unavailable; using installed Codex hook');
      return fallback;
    }
    return null;
  } catch (err) {
    console.warn(`Local AI health refresh is not configured: ${err.message}`);
    return null;
  }
}

let localAiHealthRefreshRunning = false;

function refreshLocalAiHealth() {
  if (localAiHealthRefreshRunning) return;
  const command = localAiPreflightCommand();
  if (!command) return;

  localAiHealthRefreshRunning = true;
  // The configured command is the private, reviewed Node hook. It performs
  // only the existing endpoint/GPU health check and writes status telemetry in
  // WORKDIR; it never starts a model or repairs remote infrastructure.
  const child = spawn(process.execPath, [command, '--json', '--revalidate'], {
    cwd: WORKDIR,
    env: process.env,
  });
  // The hook reads stdin to support Codex hook events. This standalone health
  // refresh has no event payload, so close the pipe to let it complete.
  child.stdin.end();
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('error', (err) => {
    localAiHealthRefreshRunning = false;
    console.warn(`Local AI health refresh failed to start: ${err.message}`);
  });
  child.on('close', (code) => {
    localAiHealthRefreshRunning = false;
    try {
      const status = JSON.parse(stdout);
      if (code === 0 && typeof status.state === 'string') {
        console.log(`Local AI health refreshed: ${status.state}`);
        return;
      }
    } catch {
      // Keep the prior telemetry if the private hook produced no valid status.
    }
    console.warn('Local AI health refresh did not return a valid status');
  });
}

function killCli(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
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
      killCli(child);
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

function runCodex(message, sessionId, options) {
  return new Promise((resolve, reject) => {
    // Apps are not configured in this bridge. Explicitly disabling the Codex
    // apps feature prevents an ambient, expired codex_apps OAuth token from
    // being initialized on every Home Assistant request.
    const accessArgs = [
      ...codexExecOptions(options),
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    const args = sessionId
      ? ['exec', 'resume', sessionId, ...accessArgs, message]
      : ['exec', ...accessArgs, message];
    const child = spawnCli('codex', args);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killCli(child);
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
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/usage') {
    try {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(codexUsage.read()));
    } catch (err) {
      console.error(`Failed to read Codex usage: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'failed to read Codex usage' }));
    }
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/local-ai/live') {
    try {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        status: 'ok',
        collected_at: new Date().toISOString(),
        local_ai: codexUsage.readLocalAiLive(),
      }));
    } catch (err) {
      console.error(`Failed to read Local AI live status: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'failed to read Local AI live status' }));
    }
    return;
  }
  const supportedRoute = (
    (req.method === 'POST' && requestUrl.pathname === '/chat')
    || (req.method === 'GET' && requestUrl.pathname === '/history')
    || (req.method === 'GET' && requestUrl.pathname === '/history/conversations')
  );
  if (!supportedRoute) {
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

  if (req.method === 'GET') {
    try {
      const agent = requestUrl.searchParams.get('agent');
      if (agent && !['claude', 'codex'].includes(agent)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported agent' }));
        return;
      }
      const limit = clampLimit(requestUrl.searchParams.get('limit'), 50, 500);
      const result = requestUrl.pathname === '/history/conversations'
        ? { conversations: history.listConversations({ agent, limit }) }
        : {
            turns: history.readTurns({
              agent,
              conversationId: requestUrl.searchParams.get('conversation_id'),
              limit,
            }),
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'failed to read shared history' }));
    }
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
    const historyPrompt = typeof payload.display_message === 'string'
      ? payload.display_message
      : message;
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

    let codexOptions = {};
    if (agent === 'codex') {
      try {
        codexOptions = validateCodexOptions({
          model: payload.model,
          reasoningEffort: payload.reasoning_effort,
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }

    const sessionKey = agent === 'codex'
      ? codexSessionKey(conversationId, codexOptions)
      : (conversationId ? `${agent}:${conversationId}` : null);
    const pendingTurn = recordTurn({
      agent,
      conversationId,
      sessionId: history.getSession(sessionKey),
      prompt: historyPrompt,
      reply: '',
      status: 'pending',
    });
    try {
      const { result, priorSessionId } = await enqueueSession(sessionKey, async () => {
        let priorSessionId = history.getSession(sessionKey);
        try {
          const result = agent === 'codex'
            ? await runCodex(message, priorSessionId, codexOptions)
            : await runClaude(message, priorSessionId);
          if (sessionKey && result.session_id) saveSession(sessionKey, result.session_id);
          return { result, priorSessionId };
        } catch (err) {
          const sessionConflict = agent === 'codex'
            && priorSessionId
            && /thread-store conflict|active writer|thread\/resume failed/i.test(err.message);
          if (!sessionConflict) {
            if (/timed out/i.test(err.message)) history.deleteSession(sessionKey);
            throw err;
          }
          console.warn(`Discarding conflicted Codex session ${priorSessionId} and retrying`);
          history.deleteSession(sessionKey);
          priorSessionId = null;
          const result = await runCodex(message, null, codexOptions);
          if (sessionKey && result.session_id) saveSession(sessionKey, result.session_id);
          return { result, priorSessionId };
        }
      });
      const reply = result.result || result.response || JSON.stringify(result);
      recordTurn({
        id: pendingTurn?.id,
        agent,
        conversationId,
        sessionId: result.session_id || priorSessionId,
        prompt: historyPrompt,
        reply,
        status: 'success',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        reply,
        ...(agent === 'codex' ? {
          model: codexOptions.model || null,
          reasoning_effort: codexOptions.reasoningEffort || null,
        } : {}),
      }));
    } catch (err) {
      console.error(err);
      const agentName = agent === 'codex' ? 'Codex' : 'Claude Code';
      const reply = `Erro ao executar ${agentName}: ${err.message}`;
      recordTurn({
        id: pendingTurn?.id,
        agent,
        conversationId,
        sessionId: history.getSession(sessionKey),
        prompt: historyPrompt,
        reply,
        status: 'error',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply }));
    }
  });
});

ensureClaudeWorkspaceTrust();
history.initialize();
refreshLocalAiHealth();
setInterval(refreshLocalAiHealth, LOCAL_AI_HEALTH_REFRESH_MS).unref();

server.listen(PORT, () => {
  console.log(
    `agent bridge listening on :${PORT}, workdir=${WORKDIR}, history=${HISTORY_DIR}`,
  );
});
