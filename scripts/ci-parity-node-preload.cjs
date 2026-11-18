// Preloaded by scripts/ci-parity-run.sh (NODE_OPTIONS=--require). GitHub Actions has no
// Debian global Node modules, but on the Raspberry `require('js-yaml')` still resolves from
// /usr/share/nodejs, which hid a missing dependency until CI failed (08/11/2026). Debian's
// node and npm load their own code from there, so the folder cannot be hidden. Instead,
// remove the global lookup paths from every Node process except Debian's own tools.
"use strict";
const Module = require("node:module");

const main = process.argv[1] ?? "";
const debianTool = /^\/usr\/(share|lib\/[^/]+)\/nodejs\//.test(main) || /^\/usr\/bin\/(npm|npx)$/.test(main);
const debianGlobal = /^\/usr\/(share|lib\/[^/]+)\/nodejs$/;
if (!debianTool) {
  // globalPaths is only a copy of node's internal list; filter the lookup itself.
  const lookup = Module._resolveLookupPaths;
  Module._resolveLookupPaths = function resolveWithoutDebianGlobals(request, parent) {
    const paths = lookup.call(this, request, parent);
    return Array.isArray(paths) ? paths.filter((entry) => !debianGlobal.test(entry)) : paths;
  };
  const kept = Module.globalPaths.filter((entry) => !debianGlobal.test(entry));
  Module.globalPaths.splice(0, Module.globalPaths.length, ...kept);
}
