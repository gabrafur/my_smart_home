// Fixed read-only Codex account status broker for the Raspberry MCP (one request per connection).
// Only initialize, account/read and account/rateLimits/read are ever sent to the app-server.
// Returns sanitized flags: no tokens, e-mail, account id or raw messages.
'use strict';
const WebSocket = require('/usr/local/lib/raspberry-ha-notices/vendor/ws');
const APP = '/home/gabriel/.codex/app-server-control/app-server-control.sock';
const METHODS = new Set(['initialize', 'account/read', 'account/rateLimits/read']);

function classify(account, usage, now = Date.now()) {
  const buckets = [usage?.rateLimits, ...Object.values(usage?.rateLimitsByLimitId || {})].filter(Boolean);
  const reached = buckets.map(b => b.rateLimitReachedType).find(x => typeof x === 'string') || null;
  const resets = buckets.map(b => b.primary?.resetsAt).filter(Number.isFinite);
  const credits = buckets.some(b => b.credits?.hasCredits === true || b.credits?.unlimited === true);
  const personal = account?.account?.type === 'chatgpt' && ['plus', 'pro', 'prolite', 'promax'].includes(account?.account?.planType);
  const allowed = usage?.ordinaryUsageAllowed === true;
  const reason = !personal ? 'codex_subscription_not_personal' : (!allowed && reached) ? 'codex_usage_limit_reached'
    : !allowed ? 'codex_included_usage_unavailable' : 'codex_usage_available';
  const resetAt = resets.length ? Math.max(...resets) : null;
  const pct = k => buckets.map(b => b[k]?.usedPercent).find(Number.isFinite) ?? null;
  return {
    source: 'fixed_codex_account_status_broker', state: 'observed', observed_at: new Date(now).toISOString(), age_seconds: 0,
    collection_error: null, account_type: typeof account?.account?.type === 'string' ? account.account.type : null,
    plan: typeof account?.account?.planType === 'string' ? account.account.planType : null,
    usage_allowed: allowed, limit_reached_type: reached, paid_credits_available: credits,
    usage_percent: {primary: pct('primary'), secondary: pct('secondary')},
    resets_at: resetAt ? new Date(resetAt * 1000).toISOString() : null, reason,
    coverage: ['account_and_rate_limits_only', 'not_task_or_turn_outcome'], automatic_retry: false,
  };
}

function observe(socketPath = APP, timeoutMs = 8000) {
  return new Promise(resolve => {
    const unknown = error => ({source: 'fixed_codex_account_status_broker', state: 'unknown', observed_at: new Date().toISOString(),
      age_seconds: 0, collection_error: error, reason: null, automatic_retry: false});
    let id = 0, done = false; const pending = new Map();
    const ws = new WebSocket('ws+unix://' + socketPath + ':/');
    const finish = v => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => finish(unknown('codex_app_server_timeout')), timeoutMs);
    const rpc = (method, params) => new Promise((res, rej) => {
      if (!METHODS.has(method)) return rej(new Error('method_refused'));
      const i = ++id; pending.set(i, {res, rej}); ws.send(JSON.stringify({jsonrpc: '2.0', id: i, method, params}));
    });
    ws.on('message', raw => { try { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error('rpc_error')) : p.res(m.result); } } catch { finish(unknown('codex_app_server_response_invalid')); } });
    ws.on('error', () => finish(unknown('codex_app_server_unreachable')));
    ws.on('open', async () => {
      try {
        await rpc('initialize', {clientInfo: {name: 'raspberry_codex_account_status', version: '1'}, capabilities: {experimentalApi: true}});
        ws.send(JSON.stringify({jsonrpc: '2.0', method: 'initialized', params: {}}));
        finish(classify(await rpc('account/read', {refreshToken: false}), await rpc('account/rateLimits/read', {})));
      } catch { finish(unknown('codex_account_read_failed')); }
    });
  });
}

module.exports = {classify, observe, METHODS};
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', s => { input += s; if (input.length > 1024 || input.includes('\n')) process.stdin.pause(); if (input.includes('\n')) go(); });
  process.stdin.on('end', go);
  let started = false;
  async function go() {
    if (started) return; started = true;
    let ok = false; try { ok = JSON.parse(input.split('\n')[0]).name === 'codex_account_status'; } catch {}
    const value = ok ? await observe() : {state: 'refused', reason: 'request_refused', automatic_retry: false};
    process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
  }
}
