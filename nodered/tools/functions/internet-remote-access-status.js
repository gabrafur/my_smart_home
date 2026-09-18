const phase = msg.remote_access_state?.phase ?? msg.remote_access?.internet?.phase ?? "unknown";
node.status({
    fill: phase === "ready" ? "green" : phase === "unavailable" ? "red" : "yellow",
    shape: phase === "ready" ? "dot" : "ring",
    text: `acesso remoto: ${phase}`
});
return null;
