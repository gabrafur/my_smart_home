// Codex account status for the isolated MCP frontend. Read-only; the broker only reads
// account and rate limits. Failed codex_task_create/send responses get the account status
// and a likely reason appended, so "no credits" is not reported as a generic RPC failure.
import net from 'node:net';
const SOCKET = '/run/raspberry-mcp/codex-account.sock';
export const accountDescriptor = {name: 'codex_account_status',
  description: 'Read the Codex/ChatGPT account usage state used by codex_task_create/send: plan, whether included usage is allowed, limit reached, paid credits and reset time. Read only; no task, turn or account change.',
  inputSchema: {type: 'object', additionalProperties: false, properties: {host: {type: 'string', enum: ['raspberry']}}, required: ['host']},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}};
const ANNOTATED = new Set(['codex_task_create', 'codex_task_send']);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
export function invokeAccount(socket = SOCKET) {
  return new Promise((resolve, reject) => {
    let out = Buffer.alloc(0), done = false;
    const c = net.createConnection({path: socket}), timer = setTimeout(() => finish(Error('account_transport_deadline')), 15000);
    function finish(e, v) { if (done) return; done = true; clearTimeout(timer); c.destroy(); e ? reject(e) : resolve(v); }
    c.once('connect', () => c.end(JSON.stringify({name: 'codex_account_status'}) + '\n'));
    c.on('error', () => finish(Error('account_transport_unconfirmed')));
    c.on('data', b => { if (out.length + b.length > 16384) return finish(Error('account_response_limit')); out = Buffer.concat([out, b]); });
    c.on('end', () => { try { finish(null, JSON.parse(out.toString('utf8'))); } catch { finish(Error('account_response_invalid')); } });
  });
}
async function status(invoke) {
  try { const v = await invoke(); if (plain(v)) return v; } catch {}
  return {source: 'fixed_codex_account_status_broker', state: 'unknown', collection_error: 'account_route_unavailable', automatic_retry: false};
}
export function makeAccountRoute(prior, invoke = invokeAccount, audit = () => {}) {
  return async (q, ...rest) => {
    if (q?.method === 'tools/call' && q.params?.name === accountDescriptor.name) {
      const a = q.params.arguments;
      if (!plain(a) || a.host !== 'raspberry' || Object.keys(a).length !== 1)
        return {jsonrpc: '2.0', id: q.id ?? null, error: {code: -32602, message: 'codex_account_parameters_refused'}};
      const v = await status(invoke);
      try { audit({tool: accountDescriptor.name, id: q.id, success: v.state === 'observed'}); } catch {}
      return {jsonrpc: '2.0', id: q.id, result: {content: [{type: 'text', text: JSON.stringify(v)}], structuredContent: v, isError: v.state !== 'observed'}};
    }
    const response = await prior(q, ...rest);
    if (q?.method === 'tools/list' && Array.isArray(response?.result?.tools) && !response.result.tools.some(t => t.name === accountDescriptor.name))
      response.result.tools.push(structuredClone(accountDescriptor));
    if (q?.method === 'tools/call' && ANNOTATED.has(q.params?.name) && response?.result?.isError === true) {
      const v = await status(invoke);
      const texts = (response.result.content || []).map(c => typeof c?.text === 'string' ? c.text : '').join(' ');
      // Only the generic RPC refusal gets an attributed account reason; specific refusals keep their own.
      const generic = /\b(task_rpc_unconfirmed|included_quota_unconfirmed|personal_subscription_required)\b/.test(texts);
      const note = {codex_account: v, likely_reason: generic && v.state === 'observed' && v.reason !== 'codex_usage_available' ? v.reason : null,
                    note: 'account status observed after the refusal; it does not prove why the backend refused'};
      if (Array.isArray(response.result.content)) response.result.content.push({type: 'text', text: JSON.stringify(note)});
      if (plain(response.result.structuredContent)) Object.assign(response.result.structuredContent, note);
    }
    return response;
  };
}
