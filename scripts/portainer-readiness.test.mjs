import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { portainerProbeScript, probeService } from "./container-readiness.mjs";

function fixture(statusCode = 200) {
  const response = new EventEmitter(), request = new EventEmitter();
  const exits = [], timers = [];
  let receive, requestTimeout, destroyed = false, resumed = false;
  response.statusCode = statusCode;
  response.resume = () => { resumed = true; };
  request.destroy = () => { destroyed = true; };
  request.setTimeout = (ms, fn) => { assert.equal(ms, 5000); requestTimeout = fn; };
  vm.runInNewContext(portainerProbeScript, {
    Buffer, process: { exit: code => exits.push(code) },
    setTimeout: (fn, ms) => { assert.equal(ms, 7000); timers.push(fn); return 1; },
    clearTimeout: () => {},
    require: name => {
      assert.equal(name, "http");
      return { get: (url, fn) => {
        assert.equal(url, "http://portainer:9000/api/system/status");
        receive = fn; return request;
      } };
    },
  });
  receive(response);
  return { response, request, exits, timers, requestTimeout,
    get destroyed() { return destroyed; }, get resumed() { return resumed; },
    body: raw => { response.emit("data", Buffer.from(raw)); response.emit("end"); },
  };
}

test("Portainer readiness requires a successful bounded application status response", () => {
  const f = fixture();
  f.response.emit("data", Buffer.from('{"Version":'));
  f.response.emit("data", Buffer.from('"2.45.2"}'));
  assert.deepEqual(f.exits, []);
  f.response.emit("end");
  assert.deepEqual(f.exits, [0]);
});

test("redirects and HTTP errors do not pass readiness or cause another request", () => {
  for (const code of [301, 302, 401, 403, 404, 500]) {
    const f = fixture(code);
    assert.deepEqual(f.exits, [1]); assert.equal(f.resumed, true);
  }
});

test("invalid bodies and oversized streams cannot pass readiness", () => {
  for (const body of ["<html>ready</html>", "{}", "[]", '{"Version":2}',
    '{"Version":"unconfirmed"}', '{"Version":"2.45.2","extra":' + '"' + "x".repeat(8192) + '"}']) {
    const f = fixture(); f.body(body); assert.deepEqual(f.exits, [1]);
  }
});

test("timeouts and aborted responses stay failed even if a late success arrives", () => {
  for (const fail of [f => f.requestTimeout(), f => f.timers[0](),
    f => f.response.emit("aborted"), f => f.request.emit("error", Error("fixture")),
    f => f.response.emit("error", Error("fixture"))]) {
    const f = fixture(); fail(f); f.body('{"Version":"2.45.2"}');
    assert.deepEqual(f.exits, [1]);
  }
});

test("Portainer probe uses only the existing NodeRED network and exports no body", () => {
  let calls = 0;
  assert.equal(probeService("portainer", { execute: (command, args, options) => {
    calls++; assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, 4), ["exec", "nodered", "node", "-e"]);
    assert.equal(args[4], portainerProbeScript);
    assert.equal(options.timeout, 10000);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    return "";
  } }), true);
  assert.equal(calls, 1);
  assert.equal(probeService("portainer", { execute: () => { throw Error("withheld"); } }), false);
  assert.equal(probeService("unsupported"), null);
});
