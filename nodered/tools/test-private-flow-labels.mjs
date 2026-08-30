import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildPrivateFlowLabels,
  displayNameForRole,
} = require("./nodes/private-flow-labels.js");
const registerPrivateFlowLabels = require("./nodes/private-flow-labels.js");

const bindings = {
  roles: {
    resident_primary: { source_alias: "example_primary" },
    resident_secondary: { source_alias: "example-secondary" },
  },
};

assert.equal(
  displayNameForRole(bindings, "resident_primary"),
  "Example Primary",
);
assert.deepEqual(buildPrivateFlowLabels(bindings), {
  resident_notifications_notify_primary:
    "Avisar Example Primary: Example Secondary se aproxima",
  resident_notifications_notify_secondary:
    "Avisar Example Secondary: Example Primary se aproxima",
});

for (const invalidAlias of ["", "../private", "resident<script>", 123, null]) {
  const invalidBindings = {
    roles: { resident_primary: { source_alias: invalidAlias } },
  };
  assert.equal(displayNameForRole(invalidBindings, "resident_primary"), null);
  assert.deepEqual(buildPrivateFlowLabels(invalidBindings), {});
}

let registeredRoute;
let registeredType;
const permissionMiddleware = () => {};
registerPrivateFlowLabels({
  auth: {
    needsPermission(permission) {
      assert.equal(permission, "flows.read");
      return permissionMiddleware;
    },
  },
  httpAdmin: {
    get(path, middleware, handler) {
      registeredRoute = { path, middleware, handler };
    },
  },
  nodes: {
    createNode() {},
    registerType(type, constructor) {
      registeredType = { type, constructor };
    },
  },
  settings: {
    functionGlobalContext: { publicBindings: bindings },
  },
});

assert.equal(registeredRoute.path, "/private-flow-labels");
assert.equal(registeredRoute.middleware, permissionMiddleware);
assert.equal(registeredType.type, "private-flow-labels");

const responseHeaders = new Map();
let responsePayload;
registeredRoute.handler({}, {
  set(name, value) {
    responseHeaders.set(name, value);
  },
  json(payload) {
    responsePayload = payload;
  },
});
assert.equal(responseHeaders.get("Cache-Control"), "no-store, private");
assert.deepEqual(responsePayload, { labels: buildPrivateFlowLabels(bindings) });

const editorSource = fs.readFileSync(
  new URL("./nodes/private-flow-labels.html", import.meta.url),
  "utf8",
);
assert.match(editorSource, /\{ \.\.\.node, name: privateLabel \}/);
assert.doesNotMatch(editorSource, /node\.name\s*=/);

console.log("Private Node-RED flow label tests passed.");
