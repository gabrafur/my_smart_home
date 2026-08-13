#!/usr/bin/env node

throw new Error(
  "Instalador desativado: o contrato de chegada agora e produzido pelos " +
    "flows localizacao_pessoas e contexto_creta. O arquivo versionado " +
    "nodered/flows.json e a fonte de verdade; valide com " +
    "`npm run flows:validate` e `npm run flows:test-alarm-arrival`.",
);
