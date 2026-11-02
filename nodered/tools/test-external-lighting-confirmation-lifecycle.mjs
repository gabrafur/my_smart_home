import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const files = name => fs.readFileSync(new URL(`./functions/${name}.js`, import.meta.url), 'utf8');
const initialNow = 1800000000000;
const roles = ['lampada_varanda', 'lampadas_garagem', 'refletores_jardim', 'abajour_sala_de_estar'];
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
    let now = initialNow;
    class Clock extends Date { static now() { return now; } }
    const memory = new Map(), persistent = new Map(), globals = new Map(), errors = [];
    const select = store => store === 'persistent' ? persistent : memory;
    const flow = { get: (key, store) => select(store).get(key), set: (key, value, store) => select(store).set(key, value) };
    const global = { get: key => globals.get(key), set: (key, value) => globals.set(key, value) };
    const node = { error: (...args) => errors.push(args), warn: () => {}, status: () => {} };
    const build = name => vm.runInNewContext(`(function(msg,node,flow,global){${files(name)}\n})`, { Date: Clock, Number, Object, String, RegExp });
    const allowed = build('external-lighting-command-allowed');
    const confirm = build('external-lighting-confirmation-message');
    const pending = build('external-lighting-pending-observation');
    const validate = build('external-lighting-policy-validate');
    const blocked = build('external-lighting-command-blocked');
    const policy = { version: 1, complete: true, confirmation_settle_seconds: 5, confirmation_window_seconds: 60, recovery_ttl_hours: 12 };
    function command(id = 'synthetic-command-a', expected = 'on', testMode = true) {
        const msg = { _msgid: id, expected_state: expected, _external_lighting_test: testMode,
            _external_command: { test_mode: testMode, policy } };
        assert.equal(allowed(msg, node, flow, global), msg);
        return msg;
    }
    function observations(msg, states = roles.map(() => msg.expected_state), at = now - 1) {
        msg.payload = { observations: Object.fromEntries(roles.map((id, i) => [id, { state: states[i], observed_at: typeof at === 'string' ? at : new Date(at).toISOString() }])) };
        return msg;
    }
    return { flow, global, memory, persistent, errors, command, observations, policy,
        confirm: msg => confirm(msg, node, flow, global), pending: msg => pending(msg, node, flow, global),
        validate: msg => validate(msg, node, flow, global), blocked: msg => blocked(msg, node, flow, global),
        at: value => { now = value; }, advance: value => { now += value; }, now: () => now };
}

test('1. fresh matching reports close the exact expectation once', () => {
    const h = harness(), msg = h.command(); h.advance(6000);
    const [, dry] = h.confirm(h.observations(msg));
    assert.equal(msg.external_confirmation.status, 'confirmed');
    assert.equal(msg.external_confirmation.expectation_status, 'confirmed');
    assert.equal(h.flow.get('external_pending_v1__test'), null);
    assert.equal(h.flow.get('external_confirmation_expectation_v2__test').status, 'confirmed');
    assert.equal(dry.payload.simulated, true); assert.equal(dry.payload.dispatched, false);
    assert.deepEqual(plain(h.confirm(h.observations(msg))), [null, null]);
    assert.equal(msg.external_confirmation.reason, 'no_pending_expectation'); assert.equal(h.errors.length, 0);
});

test('2. genuine in-window mismatch closes expectation and keeps the incident deduplicated', () => {
    const h = harness(), msg = h.command(); h.advance(6000);
    const [, alert] = h.confirm(h.observations(msg, ['off', 'on', 'unknown', 'unavailable']));
    assert.equal(alert.payload.recovery, false); assert.match(alert.alert.message, /varanda: esperado on, encontrado off/);
    assert.equal(msg.external_confirmation.expectation_status, 'mismatch');
    assert.equal(h.flow.get('external_pending_v1__test'), null);
    assert.equal(h.flow.get('external_confirmation_expectation_v2__test').status, 'mismatch');
    assert.equal(h.flow.get('external_confirmation_incident_v1__test').incident_open, true);
    assert.deepEqual(plain(h.confirm(h.observations(msg))), [null, null]);
    assert.equal(h.flow.get('external_confirmation_incident_v1__test').incident_open, true);
});

test('3. expiry is authoritative at the exact deadline and never creates a device alert', () => {
    for (const offset of [0, 1, 86400000]) {
        const h = harness(), msg = h.command(); h.at(msg.external_expires_at + offset);
        assert.deepEqual(plain(h.confirm(h.observations(msg, roles.map(() => 'off')))), [null, null]);
        assert.equal(msg.external_confirmation.expectation_status, 'expired');
        assert.equal(h.flow.get('external_pending_v1__test'), null);
        assert.equal(h.flow.get('external_confirmation_expectation_v2__test').status, 'expired');
        assert.equal(h.flow.get('external_confirmation_incident_v1__test'), undefined); assert.equal(h.errors.length, 0);
    }
});

test('4. a replaced callback cannot mutate the new expectation, including reused operation IDs', () => {
    for (const reused of [false, true]) {
        const h = harness(), old = h.command(); h.advance(1000);
        const next = h.command(reused ? old.external_operation_id : 'synthetic-command-b', 'off');
        const before = plain(h.flow.get('external_pending_v1__test')); h.advance(6000);
        assert.deepEqual(plain(h.confirm(h.observations(old, roles.map(() => 'off')))), [null, null]);
        assert.equal(old.external_confirmation.reason, 'replaced_or_unbound_callback');
        assert.deepEqual(plain(h.flow.get('external_pending_v1__test')), before);
        assert.equal(h.flow.get('external_confirmation_incident_v1__test'), undefined);
        assert.equal(next.external_operation_id, before.operation_id);
    }
});

test('5. a manual state change after success or mismatch cannot revive a completed command', () => {
    for (const mismatch of [false, true]) {
        const h = harness(), msg = h.command(); h.advance(6000);
        h.confirm(h.observations(msg, roles.map(() => mismatch ? 'off' : 'on')));
        const prior = plain(h.flow.get('external_confirmation_incident_v1__test'));
        h.advance(1000); assert.equal(h.pending({ _external_lighting_test: true }), null);
        assert.deepEqual(plain(h.confirm(h.observations(msg, roles.map(() => mismatch ? 'on' : 'off')))), [null, null]);
        assert.deepEqual(plain(h.flow.get('external_confirmation_incident_v1__test')), prior);
    }
});

test('6. a manual state change after expiry quietly consumes stale context', () => {
    const h = harness(), msg = h.command(); h.at(msg.external_expires_at + 1);
    assert.equal(h.pending({ _external_lighting_test: true }), null);
    assert.equal(h.flow.get('external_pending_v1__test'), null);
    assert.equal(h.flow.get('external_confirmation_expectation_v2__test').status, 'expired');
    assert.deepEqual(plain(h.confirm(h.observations(msg, roles.map(() => 'off')))), [null, null]);
    assert.equal(h.flow.get('external_confirmation_incident_v1__test'), undefined);
});

test('7. old, equal, unknown, unavailable, missing and future observations are inconclusive', () => {
    for (const kind of ['old', 'equal', 'unknown', 'unavailable', 'missing', 'future', 'unknown-time']) {
        const h = harness(), msg = h.command(); h.advance(6000);
        const at = kind === 'old' ? msg.external_issued_at - 1 : kind === 'equal' ? msg.external_issued_at : kind === 'future' ? h.now() + 1 : kind === 'unknown-time' ? 'not-a-time' : h.now() - 1;
        h.observations(msg, roles.map(() => ['unknown', 'unavailable'].includes(kind) ? kind : 'off'), at);
        if (kind === 'missing') msg.payload.observations = {};
        assert.deepEqual(plain(h.confirm(msg)), [null, null]);
        assert.equal(msg.external_confirmation.status, 'unconfirmed'); assert.equal(msg.external_confirmation.expectation_status, 'pending');
        assert.notEqual(h.flow.get('external_pending_v1__test'), null);
        assert.equal(h.flow.get('external_confirmation_incident_v1__test').incident_open, false);
    }
});

test('8. the explicit window policy rejects invalid/cross-field values without overwriting', () => {
    const h = harness(); h.global.set('external_lighting_policy_v1', h.policy);
    for (const [topic, value] of [['confirmation_window_seconds', 5], ['confirmation_window_seconds', 301], ['confirmation_window_seconds', 1.5]]) {
        const msg = { topic, payload: value }, [valid, rejected] = h.validate(msg);
        assert.equal(valid, null); assert.equal(rejected.external_policy_rejection.preserved, true);
        assert.deepEqual(plain(h.global.get('external_lighting_policy_v1')), h.policy);
    }
    assert.equal(h.validate({ topic: 'confirmation_window_seconds', payload: 6 })[0].external_policy_candidate.confirmation_window_seconds, 6);
    const short = { ...h.policy, confirmation_window_seconds: 10 }; h.global.set('external_lighting_policy_v1', short);
    assert.equal(h.validate({ topic: 'confirmation_settle_seconds', payload: 10 })[0], null);
    assert.deepEqual(plain(h.global.get('external_lighting_policy_v1')), short);
});

test('restart and legacy persistent expectations cannot be adopted into a new runtime', () => {
    const h = harness(), msg = h.command('synthetic-production', 'on', false);
    assert(h.persistent.get('external_pending_v1')); h.memory.clear(); h.advance(6000);
    assert.equal(h.pending({}), null); assert.equal(h.persistent.get('external_pending_v1'), null);
    assert.equal(h.persistent.get('external_confirmation_expectation_v2').status, 'discarded');
    assert.deepEqual(plain(h.confirm(h.observations(msg))), [null, null]);
    h.persistent.set('external_pending_v1', { expected: 'on', issued_at: initialNow, verify_after: initialNow + 5000, operation_id: 'legacy' });
    assert.equal(h.pending({}), null); assert.equal(h.persistent.get('external_pending_v1'), null);
    assert.equal(h.errors.length, 0);
});

test('test expectations, receipts and epochs never overwrite production state', () => {
    const h = harness(); const production = h.command('synthetic-production', 'off', false);
    const prior = plain(Object.fromEntries(h.persistent));
    const msg = h.command('synthetic-test'); h.advance(6000); h.confirm(h.observations(msg));
    assert.deepEqual(plain(Object.fromEntries(h.persistent)), prior);
    const testReceipt = plain(h.flow.get('external_confirmation_expectation_v2__test'));
    h.confirm(h.observations(production));
    assert.equal(h.flow.get('external_pending_v1', 'persistent'), null);
    assert.equal(h.flow.get('external_confirmation_expectation_v2', 'persistent').status, 'confirmed');
    assert.deepEqual(plain(h.flow.get('external_confirmation_expectation_v2__test')), testReceipt);
    const generator = fs.readFileSync(new URL('./install-external-lighting-visual-policy.mjs', import.meta.url), 'utf8');
    assert.match(generator, /bytopic: "topic"/); assert.match(generator, /topic: "external_confirmation_scope"/);
    assert.match(generator, /confirmation_window_seconds/);
});

test('a blocked command cancels only its matching production or test expectation and timer scope', () => {
    const h = harness(); const production = h.command('synthetic-production', 'off', false);
    const synthetic = h.command('synthetic-test');
    const prodBefore = plain(Object.fromEntries(h.persistent));
    h.blocked(synthetic);
    assert.equal(synthetic.reset, true); assert.equal(synthetic.external_confirmation_scope, 'test');
    assert.equal(h.flow.get('external_pending_v1__test'), null);
    assert.deepEqual(plain(Object.fromEntries(h.persistent)), prodBefore);
    h.blocked(production); assert.equal(production.external_confirmation_scope, 'production');
    assert.equal(h.flow.get('external_pending_v1', 'persistent'), null);
    assert.equal(h.flow.get('external_confirmation_expectation_v2', 'persistent').status, 'cancelled');
});
