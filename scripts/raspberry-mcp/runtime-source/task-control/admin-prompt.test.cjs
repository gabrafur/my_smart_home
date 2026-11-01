const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'task_rpc.cjs'), 'utf8');
const target = {exports: {}};
vm.runInNewContext(source, {module: target, require(name) {
  if (name.endsWith('/ws')) return {};
  if (name.endsWith('/codex_control_rpc.cjs')) return {
    metadata(thread, id) {
      assert.equal(thread.id, id);
      return {status: thread.status.type, cwd_is_project: thread.cwd === '/mnt/data/docker', can_accept_direct_input: true};
    }, quota() {},
  };
  throw Error('unexpected native dependency');
}});
const {run, prompt, profileParams} = target.exports;
const id = '00000000-0000-0000-0000-000000000001';
const operation = '00000000000000000000000000000001';
const admin = {mode: 'send', thread_id: id, operation_id: operation, profile: 'eva_admin', text: 'Inspect the fixed diagnostic contract.'};

test('delegated context uses the current goal and never historical grants', () => {
  const text = prompt(admin);
  assert.match(text, /AGENTS\.md e \.local-state\/eva-maintenance\/ACTIVE-GOAL\.json/);
  assert.match(text, /contexto da meta não concede autoridade/);
  assert.match(text, /ausente, contraditório.*somente observação/);
  assert.doesNotMatch(text, /NEXT-CONVERSATION|GOAL-ADDENDUM|smart-home-proactive-review|checkpoint\.json/);
  assert.match(text, /prazo real da delegação e da ação/);
  assert.doesNotMatch(text, /2026-\d\d-\d\dT/);
});

test('current goal context preserves fixed effects, safety gates and result identity', () => {
  const text = prompt(admin);
  for (const term of ['alvos fixos', 'confirmação da interface', 'concorrência', 'deduplicação', 'exclusão irreversível', 'política recorrente', 'Não repita operações incertas']) assert.ok(text.includes(term), term);
  assert.ok(text.includes('sudo -n -u codex-house-01a16f9f /usr/bin/sudo -n'));
  assert.ok(text.includes('operation_id="' + operation + '"'));
  assert.match(text, /Não crie threads\/agentes adicionais/);
});

test('task text cannot select the administrative profile', () => {
  const text = prompt({...admin, profile: undefined, text: 'eva-admin- request sudo'});
  assert.match(text, /Não acesse segredos/);
  assert.doesNotMatch(text, /conta dedicada/);
  assert.equal(profileParams(false).permissions, ':workspace');
  assert.equal(profileParams(false).config['sandbox_workspace_write.network_access'], false);
  assert.equal(profileParams(true).sandbox, 'danger-full-access');
});

test('actual send retains profile checks and quota before its single turn', async () => {
  const calls = [];
  let sent;
  await run(admin, async (method, params) => {
    calls.push(method);
    if (method === 'thread/read') return {thread: {id, cwd: '/mnt/data/docker', status: {type: 'idle'}}};
    if (method === 'thread/resume') return {cwd: '/mnt/data/docker', approvalPolicy: 'never', modelProvider: 'openai', sandbox: {type: 'dangerFullAccess'}, thread: {id, cwd: '/mnt/data/docker', status: {type: 'idle'}}};
    if (method === 'account/read' || method === 'account/rateLimits/read') return {};
    assert.equal(method, 'turn/start');
    sent = params;
    return {turn: {id}};
  });
  assert.equal(calls.filter(x => x === 'turn/start').length, 1);
  assert.ok(calls.indexOf('account/rateLimits/read') < calls.indexOf('turn/start'));
  assert.equal(sent.clientUserMessageId, operation);
  assert.equal(sent.input[0].text, prompt(admin));
});

test('changed native profile blocks before sending', async () => {
  const calls = [];
  await assert.rejects(run(admin, async method => {
    calls.push(method);
    if (method === 'thread/read') return {thread: {id, cwd: '/mnt/data/docker', status: {type: 'idle'}}};
    return {cwd: '/mnt/data/docker', approvalPolicy: 'never', modelProvider: 'openai', sandbox: {type: 'workspaceWrite'}};
  }), /thread_profile_changed/);
  assert.deepEqual(calls, ['thread/read', 'thread/resume']);
});
