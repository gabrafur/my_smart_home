'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {pathToFileURL} = require('node:url');
const m = require('./kia-runtime-facts.cjs');

const registry = () => m.ROLES.map(([role, domain, suffix]) => ({
  entity_id: domain + '.synthetic_vehicle' + suffix, platform: 'kia_uvo',
  device_id: 'a'.repeat(32), config_entry_id: 'b'.repeat(32),
  name: 'PRIVATE_REGISTRY_TITLE', unique_id: 'PRIVATE_REGISTRY_ID',
}));
const binding = () => ({schema_version: 1, scope: m.SCOPE, enabled: true,
  approval_sha256: 'c'.repeat(64), entities: m.bindTargets(registry())});
const facts = () => ({schema_version: 1, rows: m.ROLES.map(([role]) => ({
  role, state_kind: 'value', native_scanned_at: role === 'scanned' ? '2026-01-01T00:00:30Z' : null,
}))});
function transportFor(body, status = 200) {
  const seen = [];
  return {seen, request(options, callback) {
    const req = new EventEmitter();
    req.destroy = () => {req.destroyed = true;};
    req.end = raw => {
      seen.push({options, raw: raw.toString()});
      queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = status;
        callback(response); response.emit('data', Buffer.from(body)); response.emit('end');
      });
    };
    return req;
  }};
}

test('roles match the existing native updater contract, including ambiguity', async () => {
  const updater = await import(pathToFileURL(path.join(__dirname, '..', '..', 'kia-uvo-safe-update.mjs')));
  const selected = m.bindTargets(registry());
  const canonical = updater.selectKiaRuntimeEntities(Object.values(selected));
  assert.deepEqual(canonical.requiredEntities, Object.values(selected));
  assert.equal(canonical.fuelEntity, selected.fuel);
  assert.equal(canonical.scannedEntity, selected.scanned);
  assert.throws(() => m.bindTargets([...registry(), registry()[0]]), /ambiguous/);
  assert.throws(() => m.bindTargets(registry().slice(1)), /missing/);
});

test('binding never mixes a different device, entry or integration', () => {
  for (const [key, value] of [['device_id', 'd'.repeat(32)], ['config_entry_id', 'e'.repeat(32)], ['platform', 'other']]) {
    const rows = registry(); rows[1][key] = value; assert.throws(() => m.bindTargets(rows));
  }
  const rows = registry(); rows[1].device_id = null; assert.throws(() => m.bindTargets(rows));
});

test('native UUID and modern ULID registry identifiers remain compatible', () => {
  const rows = registry();
  for (const row of rows) {row.config_entry_id = '01' + 'A'.repeat(24);row.device_id = '02' + 'B'.repeat(24);}
  assert.deepEqual(m.bindTargets(rows), m.bindTargets(registry()));
  rows[0].config_entry_id = 'PRIVATE INVALID IDENTIFIER';
  assert.throws(() => m.bindTargets(rows));
});

test('unarmed binding, extra fields and template injection are rejected', () => {
  for (const mutate of [b => {b.enabled = false;}, b => {delete b.approval_sha256;},
    b => {b.other = 'PRIVATE';}, b => {b.entities.fuel = "sensor.x' + states.secret";},
    b => {b.entities.hazard = 'switch.synthetic_start_hazard_lights_and_horn';}]) {
    const b = binding(); mutate(b); assert.throws(() => m.buildTemplate(b));
  }
  const text = m.buildTemplate(binding());
  for (const denied of ['.attributes', 'state_attr', 'service', 'location', 'PRIVATE_REGISTRY']) assert.equal(text.includes(denied), false);
});

test('only closed state kinds and normalized timestamps survive response projection', () => {
  const rows = m.parseFacts(JSON.stringify(facts()));
  assert.equal(rows.length, 6); assert.equal(rows[1].native_scanned_at, '2026-01-01T00:00:30.000Z');
  assert.equal(JSON.stringify(rows).includes('synthetic_vehicle'), false);
  for (const mutate of [v => {v.private = 'PRIVATE';}, v => {v.rows[0].coordinates = 'PRIVATE';},
    v => {v.rows[1].native_scanned_at = '2026-02-30T00:00:00Z';},
    v => {v.rows[0].state_kind = 'PRIVATE_RAW_STATE';},
    v => {v.rows[0].native_scanned_at = '2026-01-01T00:00:30Z';},
    v => {v.rows[1].state_kind = 'unknown';}, v => {v.rows[1].role = 'fuel';}]) {
    const v = facts(); mutate(v); assert.throws(() => m.parseFacts(JSON.stringify(v)));
  }
});

test('missing and unknown remain distinct and do not become functional proof', () => {
  const v = facts(); v.rows[0] = {role: 'fuel', state_kind: 'missing', native_scanned_at: null};
  v.rows[1].state_kind = 'unknown'; v.rows[1].native_scanned_at = null;
  const projected = m.parseFacts(JSON.stringify(v));
  assert.equal(projected[0].state_kind, 'missing'); assert.equal(projected[1].state_kind, 'unknown');
});

test('identity or missing approval prevents every HTTP attempt', async () => {
  const transport = transportFor(JSON.stringify(facts()));
  let calls = 0;
  const loadBinding = () => {calls++; return binding();};
  let result = await m.collectRuntime('fixture', false, {transport, loadBinding});
  assert.equal(calls, 0); assert.equal(result.request_attempted, false);
  result = await m.collectRuntime('fixture', true, {transport, loadBinding: () => {throw Error('unarmed');}});
  assert.equal(result.request_attempted, false); assert.equal(transport.seen.length, 0);
});

test('the sole local endpoint receives one static template and exports no binding or credential', async () => {
  const transport = transportFor(JSON.stringify(facts()));
  const result = await m.collectRuntime('PRIVATE_CREDENTIAL_CANARY', true, {transport, loadBinding: binding});
  assert.equal(result.state, 'observed'); assert.equal(result.rows.length, 6);
  assert.equal(transport.seen.length, 1);
  const {options, raw} = transport.seen[0];
  assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 8123);
  assert.equal(options.path, '/api/template'); assert.equal(options.method, 'POST');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['template']);
  for (const canary of ['PRIVATE', 'synthetic_vehicle', 'entities', 'approval_sha256']) assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.service_calls, 0); assert.equal(result.new_subscriptions, 0);
  assert.equal(result.current_functional_health_proven, false); assert.equal(result.natural_polling_proven, false);
});

test('response refusal, malformed private content and oversize stay unknown', async () => {
  for (const [body, status] of [['PRIVATE_RESPONSE_CANARY', 200], [JSON.stringify(facts()), 302], ['x'.repeat(16385), 200]]) {
    const result = await m.collectRuntime('fixture', true, {loadBinding: binding, transport: transportFor(body, status)});
    assert.equal(result.state, 'unknown'); assert.equal(result.rows, null);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('absolute deadline terminates even an active response stream', async () => {
  let destroyed = false, timer;
  const transport = {request(options, callback) {
    const req = new EventEmitter(); req.destroy = () => {destroyed = true; clearInterval(timer);};
    req.end = () => {const res = new EventEmitter();res.statusCode = 200;callback(res);
      timer = setInterval(() => res.emit('data', Buffer.from(' ')), 20);};
    return req;
  }};
  const result = await m.collectRuntime('fixture', true, {loadBinding: binding, transport});
  assert.equal(result.collection_error, 'native_template_timeout'); assert.equal(destroyed, true);
});

test('fixed binding rejects user ownership, writable parent/file, link aliases and oversized files', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'kia-runtime-facts.cjs'), 'utf8');
  for (const variant of ['valid', 'revoked', 'user', 'parent_write', 'file_write', 'parent_alias', 'hardlink', 'size']) {
    const transport = transportFor(JSON.stringify(facts()));
    const fakeFS = {constants: fs.constants, existsSync: () => variant === 'revoked', lstatSync: () => ({isDirectory: () => true, uid: 0,
      mode: variant === 'parent_write' ? 0o777 : 0o750}),
      realpathSync: p => variant === 'parent_alias' ? '/other/alias' : p,
      openSync: () => 10, closeSync: () => {}, readFileSync: () => JSON.stringify(binding()),
      fstatSync: () => ({isFile: () => true, uid: variant === 'user' ? 1001 : 0,
        nlink: variant === 'hardlink' ? 2 : 1, mode: variant === 'file_write' ? 0o660 : 0o640,
        size: variant === 'size' ? 5000 : 1024})};
    const context = {module: {exports: {}}, require: name => name === 'node:fs' ? fakeFS : name === 'node:http' ? transport : require(name),
      Buffer, setTimeout, clearTimeout};
    vm.runInNewContext(source, context);
    const result = await context.module.exports.collectRuntime('fixture', true);
    assert.equal(result.request_attempted, variant === 'valid', variant);
    assert.equal(transport.seen.length, variant === 'valid' ? 1 : 0, variant);
  }
});

test('consumer rejects extra private fields, malformed rows and unsupported completion claims', async () => {
  const value = await m.collectRuntime('fixture', true, {loadBinding: binding, transport: transportFor(JSON.stringify(facts()))});
  assert.equal(m.projectRuntimeFacts(value).state, 'observed');
  for (const mutate of [v => {v.private = 'PRIVATE';}, v => {v.rows[0].private = 'PRIVATE';},
    v => {v.natural_polling_proven = true;}, v => {v.current_functional_health_proven = true;},
    v => {v.collection_error = 'PRIVATE';}, v => {v.scope_approved = false;}]) {
    const v = JSON.parse(JSON.stringify(value));mutate(v);
    const result = m.projectRuntimeFacts(v);
    assert.equal(result.state, 'unknown'); assert.equal(result.rows, null);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('consumer preserves unarmed and transport failure without converting them to no incident', async () => {
  const value = await m.collectRuntime('fixture', false);
  const projected = m.projectRuntimeFacts(value);
  assert.equal(projected.collection_error, 'native_identity_unconfirmed');
  assert.equal(projected.state, 'unknown');assert.equal(projected.scope_approved, false);
  assert.equal(projected.current_functional_health_proven, false);
});
