const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
node.status({ fill: "yellow", shape: "dot", text: "árvore ociosa encerrada" });
node.warn(
    "HOST_MEMORY_GUARDIAN_TERMINATED count=" + String(result.terminated ?? 0) +
    " reclaimed_candidate_mib=" + String(result.candidate_mib ?? 0) +
    " available_mib=" + String(result.available_mib ?? 0)
);
return null;
