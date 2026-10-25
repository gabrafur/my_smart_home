const value = msg.payload;
const code = typeof value === "object" && value !== null ? value.code : value;
if (code === 0 || code === "0") return null;
// Return code/signal and stderr are not forwarded to notices or the assistant.
return {payload: {schema_version: 1, collection_error: "source_invalid_or_unavailable", report: null}};
