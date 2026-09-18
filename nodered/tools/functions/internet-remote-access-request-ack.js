const text = Buffer.isBuffer(msg.payload) ? msg.payload.toString("utf8") : String(msg.payload ?? "");
const match = text.match(/status=(accepted|coalesced)/);
msg.remote_access_request_status = match?.[1] ?? "invalid";
node.status({
    fill: msg.remote_access_request_status === "accepted" ? "green" : "yellow",
    shape: "dot",
    text: `recovery ${msg.remote_access_request_status}`
});
return null;
