const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const terminated = Number(result.terminated ?? 0);
const tempRemoved = Number(result.temp_removed ?? 0);
const event = terminated > 0 ? "HOST_MEMORY_GUARDIAN_TERMINATED" : "HOST_MEMORY_GUARDIAN_RECLAIMED";
node.status({
    fill: "yellow",
    shape: "dot",
    text: terminated > 0 ? "sessão ociosa encerrada" : "temporários abandonados removidos"
});
node.warn(event +
    " terminated=" + String(terminated) +
    " candidate_mib=" + String(result.candidate_mib ?? 0) +
    " temp_removed=" + String(tempRemoved) +
    " temp_reclaimed_mib=" + String(result.temp_reclaimed_mib ?? 0) +
    " available_mib=" + String(result.available_mib ?? 0));
return null;
