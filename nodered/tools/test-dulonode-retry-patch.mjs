import assert from "node:assert/strict";
import fs from "node:fs";

import { patchDulonodeSource } from "./patch-dulonode-retry.mjs";

const installedUrl = new URL(
  "../node_modules/node-red-contrib-dulonode/nodes/dulonode-hub.js",
  import.meta.url,
);
const fixture = `
function DuloNodeHub() {
        let mqttClient;
        function setStatus() {}
        function deploy() {
            getToken()
                .then((token) => {
                    axios.post('example', {}, {})
                    .then((response) => {
                        const { data } = response.data;
                    })
                    .catch((err) => {
                        setStatus('error', 'Deployment error', errorMessage(err, 'Deployment error'));
                    });
                })
                .catch(() => {
                    // Authentication error already handled in authenticate()
                    // Just catch here to prevent unhandled rejection
                });
        }

        // Handle node input
        node.on('close', function (done) {
            if (mqttClient) {
                done();
            }
        });
}
`;
const source = fs.existsSync(installedUrl)
  ? fs.readFileSync(installedUrl, "utf8")
  : fixture;
const patched = patchDulonodeSource(source);

new Function("require", "module", "exports", "__dirname", "__filename", patched);
assert.match(patched, /DULONODE_DEPLOY_RETRY_V1/);
assert.match(patched, /scheduleDeployRetry\(\)/);
assert.match(patched, /deployRetryAttempt = 0/);
assert.match(patched, /nodeClosing = true/);
assert.equal(patchDulonodeSource(patched), patched, "o patch deve ser idempotente");

console.log("DuloNode retry patch test passed.");
