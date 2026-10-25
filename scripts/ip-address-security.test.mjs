import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = process.env.IP_ADDRESS_TEST_PACKAGE_DIR ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../nodered/node_modules/ip-address");
const require = createRequire(import.meta.url);
const { Address4, Address6 } = require(directory);

test("IPv6 zone rejection completes within a bounded isolated process", () => {
  // A vulnerable parser blocks its event loop quadratically. Bound the child,
  // rather than running that work in the test runner or residential process.
  const child = spawnSync(process.execPath, ["--max-old-space-size=32", "-e", `
    const {Address6}=require(process.argv[1]);
    for(const ending of ['\\n','\\r','\\u2028','\\u2029'])
      if(Address6.isValid('%'.repeat(262144)+ending))process.exit(2);
  `, directory], { timeout: 1500, maxBuffer: 1024, encoding: "utf8" });
  assert.equal(child.error?.code, undefined, "IPv6 zone rejection exceeded its execution bound");
  assert.equal(child.status, 0, "IPv6 zone rejection did not finish successfully");
});

test("valid address, zone and subnet behavior remains available", () => {
  const zoned = new Address6("fe80::1%eth0");
  assert.equal(zoned.zone, "%eth0");
  assert.equal(zoned.correctForm(), "fe80::1");
  assert.equal(new Address6("2001:db8::1/64").subnetMask, 64);
  assert.equal(Address6.isValid("::ffff:192.0.2.1"), true);
  assert.equal(new Address4("192.0.2.1").correctForm(), "192.0.2.1");
  assert.equal(Address4.fromArpa("1.2.0.192.in-addr.arpa.").correctForm(), "192.0.2.1");
  assert.throws(() => Address4.fromArpa("x".repeat(4096)));
});
