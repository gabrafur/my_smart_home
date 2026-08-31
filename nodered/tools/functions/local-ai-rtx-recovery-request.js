const token = env.get("BRIDGE_TOKEN");
if (typeof token !== "string" || !token) {
    node.error("BRIDGE_TOKEN ausente para recovery RTX", msg);
    return null;
}
msg.method = "POST";
msg.url = "http://ai-bridge:8099/local-ai/recover";
msg.headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
msg.payload = {};
return msg;
