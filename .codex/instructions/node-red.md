# Contratos do Node-RED

## Organização obrigatória dos canvases Node-RED

Antes de deploy, commit ou push de Node-RED, organize grupos e direção de
leitura; não sobreponha nós/grupos nem deixe nós fora do grupo. Altere também a
fonte geradora e regenere `nodered/flows.json`. Execute
`npm --prefix nodered run flows:validate-layout` e renderize/inspecione os tabs
alterados com `npm --prefix nodered run flows:render -- <tab...>`.
`validate-node-red` inclui esse gate no `pre-push`; nunca o ignore ou remova.
