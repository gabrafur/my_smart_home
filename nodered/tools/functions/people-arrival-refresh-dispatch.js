if (msg.payload?.kind !== "arrival_location_refresh") return [null, null];
const source = msg.payload?.source;
if (source === "resident_primary") return [msg, null];
if (source === "resident_secondary") return [null, msg];
node.warn("localizacao_pessoas: refresh de chegada sem fonte válida");
return [null, null];
