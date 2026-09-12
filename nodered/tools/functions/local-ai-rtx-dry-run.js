const result = {
    simulated: true,
    dispatched: false,
    side_effect: "mcp_recovery",
    reason: msg.payload && msg.payload.reason ? msg.payload.reason : "synthetic_unavailable",
};
flow.set("local_ai_rtx_last_dry_run_v1", result);
msg.payload = result;
node.status({ fill: "blue", shape: "dot", text: "dry-run: MCP bloqueado" });
node.warn("LOCAL_AI_RTX_DRY_RUN " + JSON.stringify(result));
return null;
