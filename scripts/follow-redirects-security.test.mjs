import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const packagePath = process.env.FOLLOW_REDIRECTS_TEST_PACKAGE ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../nodered/node_modules/follow-redirects");
const redirects = require(packagePath);

async function redirectedHeaders(headers, sensitiveHeaders) {
  let received;
  const target = http.createServer((request, response) => {
    received = request.headers;
    response.end("ok");
  });
  const source = http.createServer((request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.2:${target.address().port}/` });
    response.end();
  });
  try {
    target.listen(0, "127.0.0.2");await once(target, "listening");
    source.listen(0, "127.0.0.1");await once(source, "listening");
    await new Promise((resolve, reject) => {
      const request = redirects.http.get({ hostname: "127.0.0.1", port: source.address().port,
        path: "/", headers, sensitiveHeaders, timeout: 1500 }, response => {
        response.resume();response.once("end", resolve);response.once("error", reject);
      });
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("fixture_timeout")));
    });
    return received;
  } finally {
    source.closeAllConnections();target.closeAllConnections();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
}

test("array-form headers cannot carry credentials across redirect origins", { timeout: 5000 }, async () => {
  const received = await redirectedHeaders(["Authorization", "fixture", "Cookie", "fixture", "X-Keep", "ok"]);
  assert.equal(received.authorization, undefined);
  assert.equal(received.cookie, undefined);
  assert.equal(received["x-keep"], "ok");
});

test("custom sensitive header names containing regex operators remain literal", { timeout: 5000 }, async () => {
  const name = "X-Custom^Auth|Other";
  const received = await redirectedHeaders(Object.fromEntries([[name, "fixture"], ["X-Keep", "ok"]]), [name]);
  assert.equal(received[name.toLowerCase()], undefined);
  assert.equal(received["x-keep"], "ok");
});
