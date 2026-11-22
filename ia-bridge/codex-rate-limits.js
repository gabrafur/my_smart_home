const { spawn } = require('child_process');

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  return {
    used_percent: Number.isFinite(Number(window.usedPercent))
      ? Number(window.usedPercent)
      : null,
    window_minutes: Number.isFinite(Number(window.windowDurationMins))
      ? Number(window.windowDurationMins)
      : null,
    resets_at: Number.isFinite(Number(window.resetsAt))
      ? Number(window.resetsAt)
      : null,
  };
}

function normalizeRateLimit(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    limit_id: snapshot.limitId || null,
    limit_name: snapshot.limitName || null,
    plan_type: snapshot.planType || null,
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    credits: snapshot.credits ? {
      has_credits: snapshot.credits.hasCredits === true,
      unlimited: snapshot.credits.unlimited === true,
      balance: snapshot.credits.balance ?? null,
    } : null,
    spend_control_reached: snapshot.spendControlReached === true,
    rate_limit_reached_type: snapshot.rateLimitReachedType || null,
  };
}

// One long-lived `codex app-server` answers every refresh. Spawning it per
// read cost ~230 MiB and a full SQLite WAL replay (~160 MiB) every 30 s, and
// the SIGTERM that ended each run left the WAL unconsolidated, so the host SD
// card re-read it continuously under memory pressure. Closing stdin lets the
// server exit cleanly and checkpoint its databases.
class CodexAppServerClient {
  constructor({
    command = 'codex', cwd, env, timeoutMs = 15_000, closeGraceMs = 5_000, spawnFn = spawn,
  } = {}) {
    Object.assign(this, { command, cwd, env, timeoutMs, closeGraceMs, spawnFn });
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startedAt = null;
  }

  get alive() {
    return this.child !== null;
  }

  start() {
    if (this.ready) return this.ready;
    const child = this.spawnFn(this.command, ['app-server', '--stdio'], { cwd: this.cwd, env: this.env });
    this.child = child;
    this.startedAt = Date.now();
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = message.id !== undefined ? this.pending.get(message.id) : null;
        if (!waiter) continue;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message || `${waiter.method} failed`));
        else waiter.resolve(message.result);
      }
    });
    const fail = (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(err); }
      this.pending.clear();
    };
    child.on('error', (err) => fail(err));
    child.on('close', (code) => fail(new Error(`Codex app-server exited with code ${code}: ${stderr.slice(-500)}`)));
    child.stdin.on('error', () => {});
    this.ready = this.send('initialize', {
      clientInfo: { name: 'home-assistant-codex-usage', version: '1.0.0' },
    }).then(() => {
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    });
    this.ready.catch(() => this.kill());
    return this.ready;
  }

  send(method, params) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out after ${this.timeoutMs}ms`));
        // An unresponsive server is replaced on the next refresh.
        this.kill();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`);
    });
  }

  async request(method, params) {
    await this.start();
    return this.send(method, params);
  }

  kill() {
    const child = this.child;
    if (!child || child.bridgeKilled) return;
    child.bridgeKilled = true;
    child.kill('SIGTERM');
  }

  close() {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, this.closeGraceMs);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}

function normalizeRateLimitsResult(result) {
  return {
    rateLimits: normalizeRateLimit(result?.rateLimits),
    rateLimitsByLimitId: Object.fromEntries(
      Object.entries(result?.rateLimitsByLimitId || {})
        .map(([id, value]) => [id, normalizeRateLimit(value)]),
    ),
  };
}

async function readRateLimits(client) {
  return normalizeRateLimitsResult(await client.request('account/rateLimits/read'));
}

// One-shot read for callers without a poller; it still exits cleanly.
async function queryRateLimits(options = {}) {
  const client = new CodexAppServerClient(options);
  try {
    return await readRateLimits(client);
  } finally {
    await client.close();
  }
}

class CodexRateLimitsPoller {
  constructor({
    refreshMs = 30_000, cwd, env, query = null, maxLifetimeMs = 6 * 60 * 60 * 1000,
    clientFactory = (options) => new CodexAppServerClient(options),
  } = {}) {
    this.refreshMs = refreshMs;
    this.cwd = cwd;
    this.env = env;
    this.query = query || (() => this.readFromPersistentServer());
    this.maxLifetimeMs = maxLifetimeMs;
    this.clientFactory = clientFactory;
    this.client = null;
    this.running = false;
    this.snapshot = null;
    this.updatedAt = null;
    this.lastAttemptAt = null;
    this.nextRefreshAt = null;
    this.lastError = null;
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  async readFromPersistentServer() {
    // Recycle periodically so a Codex CLI update or a slow leak is picked up;
    // the clean close checkpoints the server's SQLite databases.
    if (this.client && this.client.alive && Date.now() - this.client.startedAt >= this.maxLifetimeMs) {
      await this.client.close();
    }
    if (!this.client || !this.client.alive) {
      this.client = this.clientFactory({ cwd: this.cwd, env: this.env });
    }
    return readRateLimits(this.client);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.client) await this.client.close();
  }

  async refresh() {
    if (this.running) return;
    this.running = true;
    this.lastAttemptAt = new Date();
    this.nextRefreshAt = new Date(this.lastAttemptAt.valueOf() + this.refreshMs);
    try {
      this.snapshot = await this.query({ cwd: this.cwd, env: this.env });
      this.updatedAt = new Date();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.warn(`Codex rate-limit refresh failed: ${err.message}`);
    } finally {
      this.running = false;
      this.nextRefreshAt = new Date(Date.now() + this.refreshMs);
    }
  }

  readEvent(now = new Date()) {
    return {
      timestamp: this.updatedAt,
      rateLimits: this.snapshot?.rateLimits || null,
      refreshMetadata: {
        mode: 'codex_app_server',
        consumes_model_credits: false,
        refresh_interval_seconds: Math.round(this.refreshMs / 1000),
        last_attempt_at: this.lastAttemptAt?.toISOString() || null,
        updated_at: this.updatedAt?.toISOString() || null,
        next_refresh_at: this.nextRefreshAt?.toISOString() || null,
        seconds_until_refresh: this.nextRefreshAt
          ? Math.max(0, Math.ceil((this.nextRefreshAt - now) / 1000))
          : null,
        last_error: this.lastError,
      },
    };
  }
}

module.exports = {
  CodexAppServerClient, CodexRateLimitsPoller, normalizeRateLimit, queryRateLimits,
};
