// Sealed caller supplies admission and hashes. No MCP write endpoint is added.
const fs = require('node:fs'), http = require('node:http'), crypto = require('node:crypto');
const HOST = '${NODE_RED_PRIVATE_HOST}';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const need = (value, reason) => { if (!value) throw Error(reason); };
const fixtureKey = 'host_observer_fixture_v1__test', incidentKey = 'host_observer_incidents_v1__test';
const terminalKey = 'global_flow_observer_last_dry_run_v1';
const contextPath = (flow, key, store = 'memoryOnly') => `/context/flow/${flow}/${key}?store=${store}`;
const contextPaths = new Set([
  contextPath('global_flow_observer_tab', terminalKey),
  ...[fixtureKey, incidentKey, 'host_observer_cursor_v1__test'].flatMap(key =>
    ['memoryOnly', 'persistent'].map(store => contextPath('host_observer_tab', key, store))),
]);
function permitted(method, path) {
  return method === 'GET' && (path === '/flows' || contextPaths.has(path)) || method === 'POST' &&
    (['/auth/token', '/auth/revoke', '/flows'].includes(path) || /^\/inject\/host_obs_test_(reset|healthy|failure|confirm)$/.test(path));
}
function requestFixed(method, path, data, token) {
  need(permitted(method, path), 'request_outside_scope');
  return new Promise((resolve, reject) => {
    const body = data == null ? null : JSON.stringify(data);
    const req = http.request({host: HOST, port: 1880, method, path,
      headers: {'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes',
        ...(body ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)} : {}),
        ...(token ? {Authorization: 'Bearer ' + token} : {})}}, res => {
      let out = ''; const limit = path === '/flows' ? 8 * 1024 * 1024 : 65536;
      res.on('data', chunk => { out += chunk; if (Buffer.byteLength(out) > limit) req.destroy(Error('response_limit')); });
      res.on('end', () => {
        clearTimeout(timer);
        let parsed = null;
        if (out) {
          try { parsed = JSON.parse(out); }
          catch { if (path.startsWith('/inject/')) parsed = out; else return reject(Error('invalid_response')); }
        }
        resolve({status: res.statusCode, data: parsed});
      });
    });
    const timer = setTimeout(() => req.destroy(Error('http_outcome_unconfirmed')), 7000);
    req.on('error', () => { clearTimeout(timer); reject(Error('http_outcome_unconfirmed')); });
    req.end(body);
  });
}
function decodeContext(result) {
  need(result?.status === 200, 'context_read_unconfirmed');
  if (result.data?.format === 'undefined') return undefined;
  need(result.data?.format === 'Object' && typeof result.data.msg === 'string' && result.data.msg.length <= 65536,
    'context_format_unconfirmed');
  const value = JSON.parse(result.data.msg);
  need(value && typeof value === 'object' && !Array.isArray(value), 'context_shape_unconfirmed');
  return value;
}
function journal(directory) {
  need(process.getuid() === 0 && /^\/var\/lib\/raspberry-nodered-dry-run-receipts-20261027\/(apply|rollback|reapply)\/client-events$/.test(directory ?? ''),
    'fixed_root_journal_required');
  need(fs.realpathSync(directory) === directory, 'unsafe_journal');
  const stat = fs.lstatSync(directory);
  need(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o777) === 0o700, 'unsafe_journal');
  return (phase, value) => {
    need(/^[a-z0-9-]{1,64}$/.test(phase), 'invalid_journal_phase');
    const fd = fs.openSync(`${directory}/${phase}.json`, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({at: new Date().toISOString(), ...value}) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  };
}
function validateTerminal(value, kind, runId, traced, start) {
  need(value?.simulated === true && value.dispatched === false && value.external_call_sent === false &&
    value.notification_sent === false && value.observer_kind === kind &&
    Number.isFinite(value.completed_at) && value.completed_at >= start, 'dry_run_receipt_unconfirmed');
  if (traced) need(value.run_id === runId && value.source_flow_id === 'host_observer_tab' &&
    Number.isSafeInteger(value.receipt_sequence) && value.receipt_sequence > 0, 'dry_run_trace_unconfirmed');
  else need(value.run_id === undefined && value.receipt_sequence === undefined, 'rollback_terminal_not_baseline');
}
async function replay({request, token, input, record, now, wait}) {
  const traced = input.trace_expected, start = now(), steps = [];
  const read = async (key, flow = 'host_observer_tab', store = 'memoryOnly') =>
    decodeContext(await request('GET', contextPath(flow, key, store), null, token));
  const until = async (readValue, check) => {
    for (let i = 0; i < 40; i++) { const value = await readValue(); if (check(value)) return value; await wait(100); }
    throw Error('replay_barrier_unconfirmed');
  };
  let fixture, failure, recovery;
  const names = ['reset', 'healthy', 'failure', 'confirm', 'confirm', 'healthy', 'reset'];
  for (const [index, name] of names.entries()) {
    const cleanup = index === names.length - 1;
    const props = [{p: 'payload', v: name, vt: 'str'}, {p: '_host_observer_test', v: 'true', vt: 'bool'}];
    if (traced && !cleanup) props.push({p: '_host_test_run_id', v: input.run_id, vt: 'str'});
    record(`replay-${index}-intent`, {node: `host_obs_test_${name}`, run_id: input.run_id, automatic_retry: false});
    const result = await request('POST', `/inject/host_obs_test_${name}`, {__user_inject_props__: props}, token);
    need(result.status === 200, 'inject_outcome_unconfirmed');
    const previousNow = fixture?.now;
    fixture = await until(() => read(fixtureKey), value => {
      if (cleanup || index === 0 && !traced) return value === undefined;
      const sequence = [0, 1, 2, 2, 2, 3][index];
      return value?.sequence === sequence && Number.isFinite(value.now) &&
        (previousNow === undefined || value.now > previousNow) && (!traced || value.run_id === input.run_id);
    });
    if ([2, 3, 4].includes(index)) {
      const incidents = await until(() => read(incidentKey), value =>
        value?.incidents?.native_systemd_procmon?.last_seen_at === fixture.now);
      const incident = incidents.incidents.native_systemd_procmon;
      if (index === 2) need(incident.notified_at === null, 'confirmation_gate_bypassed');
      if (index === 3) {
        failure = await until(() => read(terminalKey, 'global_flow_observer_tab'), value =>
          value?.observer_kind === 'host_failure' && value.completed_at >= start && (!traced || value.run_id === input.run_id));
        validateTerminal(failure, 'host_failure', input.run_id, traced, start);
      }
      if (index === 4) {
        const current = await read(terminalKey, 'global_flow_observer_tab');
        need(digest(current) === digest(failure), 'dedupe_receipt_changed');
      }
    }
    if (index === 5) {
      await until(() => read(incidentKey), value => value?.incidents && !value.incidents.native_systemd_procmon);
      recovery = await until(() => read(terminalKey, 'global_flow_observer_tab'), value =>
        value?.observer_kind === 'host_recovery' && value.completed_at >= failure.completed_at && (!traced || value.run_id === input.run_id));
      validateTerminal(recovery, 'host_recovery', input.run_id, traced, start);
      if (traced) need(recovery.receipt_sequence === failure.receipt_sequence + 1, 'recovery_receipt_sequence_unconfirmed');
    }
    if (cleanup) {
      for (const key of [incidentKey, 'host_observer_cursor_v1__test']) need(await read(key) === undefined, 'test_context_cleanup_unconfirmed');
    }
    const step = {index, scenario: name, confirmed: true}; steps.push(step);
    record(`replay-${index}-confirmed`, step);
  }
  for (const key of [fixtureKey, incidentKey, 'host_observer_cursor_v1__test'])
    need(await read(key, 'host_observer_tab', 'persistent') === undefined, 'persistent_test_state_found');
  return {steps, failure_receipt: failure, recovery_receipt: recovery, deduplicated: true,
    test_context_cleaned: true, persistent_test_keys_absent: true, simulated: true, dispatched: false};
}
async function runClient(input, options = {}) {
  const request = options.request ?? requestFixed, now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let token = null;
  const proof = {source: 'actual_NodeRED_Admin_API', automatic_retry: false, submitted: false, verified: false};
  try {
    need(['snapshot', 'deploy_and_replay'].includes(input?.action), 'action_refused');
    need(typeof input.username === 'string' && /^[a-zA-Z0-9_.@-]{1,64}$/.test(input.username) &&
      typeof input.password === 'string' && input.password.length > 0 && input.password.length <= 1024, 'authentication_input_refused');
    if (input.action === 'deploy_and_replay') {
      need(/^[a-f0-9]{32}$/.test(input.run_id) && typeof input.trace_expected === 'boolean' &&
        /^[a-f0-9]{64}$/.test(input.expected_loaded_sha256) && /^[a-f0-9]{64}$/.test(input.proposed_loaded_sha256) &&
        Array.isArray(input.flows) && digest(input.flows) === input.proposed_loaded_sha256, 'proposal_refused');
    }
    const record = input.action === 'snapshot' ? null : options.record ?? journal(input.journal_dir);
    const login = await request('POST', '/auth/token', {client_id: 'node-red-admin', grant_type: 'password',
      scope: input.action === 'snapshot' ? 'read' : '*', username: input.username, password: input.password});
    need(login.status === 200 && typeof login.data?.access_token === 'string', 'login_refused');
    token = login.data.access_token;
    let current = await request('GET', '/flows', null, token);
    need(current.status === 200 && Array.isArray(current.data?.flows) && typeof current.data.rev === 'string', 'read_refused');
    proof.loaded_sha256 = digest(current.data.flows); proof.revision = current.data.rev;
    if (input.action === 'snapshot') proof.flows = current.data.flows;
    else {
      need(proof.loaded_sha256 === input.expected_loaded_sha256, 'loaded_baseline_changed');
      record('deploy-intent', {before: proof.loaded_sha256, after: input.proposed_loaded_sha256,
        revision: current.data.rev, automatic_retry: false});
      proof.submitted = true;
      const changed = await request('POST', '/flows', {rev: current.data.rev, flows: input.flows}, token);
      need([200, 204].includes(changed.status), changed.status === 409 ? 'loaded_revision_conflict' : 'deployment_unconfirmed');
      current = await request('GET', '/flows', null, token);
      need(current.status === 200 && Array.isArray(current.data?.flows), 'verification_unconfirmed');
      proof.loaded_sha256 = digest(current.data.flows); proof.revision = current.data.rev;
      need(proof.loaded_sha256 === input.proposed_loaded_sha256, 'loaded_result_mismatch');
      record('deploy-confirmed', {loaded_sha256: proof.loaded_sha256, revision: proof.revision});
      proof.replay = await replay({request, token, input, record, now, wait});
    }
    proof.verified = true;
  } catch (error) {
    proof.error = /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'client_failed';
  } finally {
    if (token) {
      try { const result = await request('POST', '/auth/revoke', {token}, token); proof.session_revoked = result.status >= 200 && result.status < 300; }
      catch { proof.session_revoked = false; }
      if (!proof.session_revoked) { proof.verified = false; proof.error ??= 'session_revocation_unconfirmed'; }
    }
  }
  return proof;
}
module.exports = {digest, decodeContext, permitted, runClient};
if (require.main === module) {
  runClient(JSON.parse(fs.readFileSync(0, 'utf8'))).then(value => {
    console.log(JSON.stringify(value)); if (!value.verified) process.exitCode = 1;
  }).catch(() => { console.log('{"verified":false,"error":"client_failed","automatic_retry":false}'); process.exitCode = 1; });
}
