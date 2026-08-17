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

function queryRateLimits({ command = 'codex', timeoutMs = 15_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--stdio'], { cwd, env });
    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      if (err) reject(err);
      else resolve(value);
    };

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => {
      finish(new Error(`Codex rate-limit read timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => finish(err));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2 && message.result) {
          const rateLimits = normalizeRateLimit(message.result.rateLimits);
          const rateLimitsByLimitId = Object.fromEntries(
            Object.entries(message.result.rateLimitsByLimitId || {})
              .map(([id, value]) => [id, normalizeRateLimit(value)]),
          );
          finish(null, { rateLimits, rateLimitsByLimitId });
        } else if (message.id === 2 && message.error) {
          finish(new Error(message.error.message || 'Codex rate-limit read failed'));
        }
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'home-assistant-codex-usage', version: '1.0.0' },
      },
    });
  });
}

class CodexRateLimitsPoller {
  constructor({ refreshMs = 30_000, cwd, env, query = queryRateLimits } = {}) {
    this.refreshMs = refreshMs;
    this.cwd = cwd;
    this.env = env;
    this.query = query;
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
    if (!this.snapshot?.rateLimits || !this.updatedAt) return null;
    return {
      timestamp: this.updatedAt,
      rateLimits: this.snapshot.rateLimits,
      refreshMetadata: {
        mode: 'codex_app_server',
        consumes_model_credits: false,
        refresh_interval_seconds: Math.round(this.refreshMs / 1000),
        last_attempt_at: this.lastAttemptAt?.toISOString() || null,
        updated_at: this.updatedAt.toISOString(),
        next_refresh_at: this.nextRefreshAt?.toISOString() || null,
        seconds_until_refresh: this.nextRefreshAt
          ? Math.max(0, Math.ceil((this.nextRefreshAt - now) / 1000))
          : null,
        last_error: this.lastError,
      },
    };
  }
}

module.exports = { CodexRateLimitsPoller, normalizeRateLimit, queryRateLimits };
