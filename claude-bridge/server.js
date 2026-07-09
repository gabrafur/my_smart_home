const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8099;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const WORKDIR = process.env.WORKDIR || '/workspace';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 5 * 60 * 1000);

if (!BRIDGE_TOKEN) {
  console.error('BRIDGE_TOKEN not set, refusing to start');
  process.exit(1);
}

// conversation_id (from Home Assistant) -> claude session id, for --resume continuity
const sessions = new Map();

function runClaude(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(message);

    const child = spawn('claude', args, {
      cwd: WORKDIR,
      env: process.env,
    });

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
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing message' }));
      return;
    }

    const priorSessionId = conversationId ? sessions.get(conversationId) : null;

    try {
      const result = await runClaude(message, priorSessionId);
      if (conversationId && result.session_id) {
        sessions.set(conversationId, result.session_id);
      }
      const reply = result.result || result.response || JSON.stringify(result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      console.error(err);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: `Erro ao executar Claude Code: ${err.message}` }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`claude-bridge listening on :${PORT}, workdir=${WORKDIR}`);
});
