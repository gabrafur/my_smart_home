#!/usr/bin/env node

import fs from "node:fs";

/*
 * A migração estrutural original era executada uma única vez e carregava
 * templates anteriores ao recovery e à política canônica de localização.
 * Manter esses templates aqui duplicaria decisões que agora pertencem aos
 * blocos visuais do Node-RED. Este arquivo permanece apenas como trava para
 * instalações antigas e para não tornar automações históricas destrutivas.
 *
 * A manutenção corrente é feita por `npm run flows:update-location`.
 */
const flowUrl = new URL("../flows.json", import.meta.url);
const flows = JSON.parse(fs.readFileSync(flowUrl, "utf8"));
const recoveryAware = flows.some(
  (node) =>
    node.name === "Normalizar pessoas e detectar transições" &&
    node.func?.includes("security_people_recovery_v1"),
);

if (!recoveryAware) {
  throw new Error(
    "Flow legado sem recovery detectado. Restaure um flows.json suportado " +
      "antes de executar o atualizador canônico de localização.",
  );
}

console.log(
  "Migração estrutural já concluída; use flows:update-location para manutenção.",
);
process.exit(0);
