#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultTarget = path.resolve(
  toolDirectory,
  "../node_modules/node-red-contrib-dulonode/nodes/dulonode-hub.js",
);
const marker = "DULONODE_DEPLOY_RETRY_V1";

export function patchDulonodeSource(source) {
  if (source.includes(marker)) return source;

  let patched = source.replace(
    "        let mqttClient;",
    `        let mqttClient;
        let deployRetryTimer = null;
        let deployRetryAttempt = 0;
        let nodeClosing = false;

        // ${marker}: the upstream node deploys only once. A transient DNS
        // failure during host startup would otherwise leave it offline until
        // a manual Node-RED deploy or restart.
        function clearDeployRetry() {
            if (deployRetryTimer) {
                clearTimeout(deployRetryTimer);
                deployRetryTimer = null;
            }
        }

        function scheduleDeployRetry() {
            if (nodeClosing || deployRetryTimer) return;
            const delay = Math.min(300000, 5000 * (2 ** Math.min(deployRetryAttempt, 6)));
            deployRetryAttempt += 1;
            setStatus('loading', 'retrying', 'Retrying cloud connection in ' + Math.round(delay / 1000) + 's');
            deployRetryTimer = setTimeout(() => {
                deployRetryTimer = null;
                deploy();
            }, delay);
        }`,
  );

  patched = patched.replace(
    "                    .then((response) => {\n                        const { data } = response.data;",
    "                    .then((response) => {\n                        clearDeployRetry();\n                        deployRetryAttempt = 0;\n                        const { data } = response.data;",
  );

  patched = patched.replace(
    "                    .catch((err) => {\n                        setStatus('error', 'Deployment error', errorMessage(err, 'Deployment error'));\n                    });",
    "                    .catch((err) => {\n                        setStatus('error', 'Deployment error', errorMessage(err, 'Deployment error'));\n                        scheduleDeployRetry();\n                    });",
  );

  patched = patched.replace(
    "                .catch(() => {\n                    // Authentication error already handled in authenticate()\n                    // Just catch here to prevent unhandled rejection\n                });\n        }\n\n        // Handle node input",
    "                .catch(() => {\n                    // Authentication errors and transient DNS failures are retried.\n                    scheduleDeployRetry();\n                });\n        }\n\n        // Handle node input",
  );

  patched = patched.replace(
    "        node.on('close', function (done) {\n            if (mqttClient) {",
    "        node.on('close', function (done) {\n            nodeClosing = true;\n            clearDeployRetry();\n            if (mqttClient) {",
  );

  const requiredFragments = [
    marker,
    "scheduleDeployRetry();",
    "deployRetryAttempt = 0;",
    "nodeClosing = true;",
  ];
  for (const fragment of requiredFragments) {
    if (!patched.includes(fragment)) {
      throw new Error(`Unsupported DuloNode source: missing patch fragment ${fragment}`);
    }
  }
  return patched;
}

export function patchFile(target = defaultTarget) {
  if (!fs.existsSync(target)) {
    throw new Error(`DuloNode runtime source not found: ${target}`);
  }
  const source = fs.readFileSync(target, "utf8");
  const patched = patchDulonodeSource(source);
  if (patched === source) return false;
  fs.writeFileSync(target, patched);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = patchFile(process.argv[2] ? path.resolve(process.argv[2]) : defaultTarget);
  console.log(changed ? "DuloNode retry patch applied." : "DuloNode retry patch already present.");
}
