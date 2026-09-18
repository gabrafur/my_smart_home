import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const converterPath = path.join(
  repoRoot,
  "zigbee2mqtt",
  "external_converters",
  "tuya-ts0001-c8wtsv3p.mjs",
);
const converter = fs.readFileSync(converterPath, "utf8");
const configurationExample = fs.readFileSync(
  path.join(repoRoot, "zigbee2mqtt", "configuration.example.yaml"),
  "utf8",
);

test("limits the missing-response workaround to the exact Tuya fingerprint", () => {
  assert.match(
    converter,
    /fingerprint:\s*tuya\.fingerprint\("TS0001", \["_TZ3000_c8wtsv3p"\]\)/,
  );
  assert.doesNotMatch(converter, /zigbeeModel\s*:/);
  assert.match(converter, /meta:\s*\{disableDefaultResponse: true\}/);
});

test("preserves the upstream Tuya initialization and on-off binding", () => {
  assert.match(converter, /tuya\.modernExtend\.tuyaBase\(\)/);
  assert.match(converter, /tuya\.modernExtend\.tuyaOnOff\(/);
  assert.match(converter, /tuya\.configureMagicPacket\(device, coordinatorEndpoint\)/);
  assert.match(converter, /reporting\.bind\([^;]+\["genOnOff"\]\)/s);
});

test("enables only the reviewed external converter surface in the example", () => {
  assert.match(configurationExample, /advanced:\n(?:[ \t].*\n)*?  enable_external_js: true\n/);
  assert.match(configurationExample, /external_converters\//);
});
