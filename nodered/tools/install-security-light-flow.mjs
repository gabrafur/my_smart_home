#!/usr/bin/env node

throw new Error(
  "Instalador desativado: ele representava uma versao antiga do fluxo de " +
    "iluminacao de seguranca. O fluxo versionado e a fonte de verdade em " +
    "nodered/flows.json; valide-o com `npm run flows:validate` e " +
    "`npm run flows:test-security`.",
);
