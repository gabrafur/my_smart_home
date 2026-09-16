import fs from "node:fs";

const requiredFiles = ["flows.json", "package.json"];
const optionalFiles = ["flows_cred.json"];
const files = [
  ...requiredFiles,
  ...optionalFiles.filter((file) => fs.existsSync(new URL(`../${file}`, import.meta.url))),
];

for (const file of files) {
  JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const notificationHubTabs = new Set([
  "notification_hub_mobile_tab",
  "notification_hub_alexa_tab",
  "notification_hub_persistent_tab",
]);
const byId = new Map();
const msgPropertyPath = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:\d+|['"][^'"]+['"])\])*$/;
for (const node of flows) {
  if (!node.id) throw new Error("Node sem id");
  if (byId.has(node.id)) throw new Error(`ID duplicado: ${node.id}`);
  byId.set(node.id, node);
  if (node.type === "function") {
    new Function("msg", "node", "context", "flow", "global", "env", "setTimeout", "clearTimeout", node.func);
  }
  if (node.type === "switch" && node.propertyType === "msg" &&
      !msgPropertyPath.test(String(node.property ?? ""))) {
    throw new Error(`Propriedade msg inválida no switch ${node.id}: ${node.property}`);
  }
}

for (const node of flows) {
  if (node.type === "api-call-service") {
    const serviceAction = String(node.action ?? "");
    const rawService = `${serviceAction}\n${String(node.data ?? "")}\n${String(node.name ?? "")}`;
    if (/^(?:notify|tts)\./.test(serviceAction) && !notificationHubTabs.has(node.z)) {
      throw new Error(`Serviço direto de notificação/TTS fora dos hubs canônicos: ${node.id}`);
    }
    if (/^media_player\./.test(serviceAction) && /alexa|announce|announcement|\btts\b/i.test(rawService) && node.z !== "notification_hub_alexa_tab") {
      throw new Error(`Saída Alexa/media_player fora do hub canônico: ${node.id}`);
    }
    const directNotifyEntities = (node.entityId ?? []).filter((entityId) => entityId.startsWith("notify."));
    if (directNotifyEntities.length > 0 || node.action === "notify.send_message") {
      throw new Error(`Notificação direta fora de public_bindings.call: ${node.id}`);
    }
    if (node.action === "public_bindings.call") {
      if (node.domain !== "public_bindings" || node.service !== "call" || (node.entityId ?? []).length !== 0) {
        throw new Error(`Metadados inconsistentes de public_bindings.call: ${node.id}`);
      }
      if (!/"role":"[a-z0-9_]+"/.test(node.data) || !/"action":"[a-z0-9_]+"/.test(node.data)) {
        throw new Error(`Contrato incompleto de public_bindings.call: ${node.id}`);
      }
      const mobilePush = /"action":"(?:notify_[23]|notify_actionable)"/.test(node.data);
      const transientCommand = /request_location_update|clear_notification/.test(node.data);
      const backgroundHub = [
        "notification_hub_mobile_primary_background",
        "notification_hub_mobile_secondary_background",
      ].includes(node.id);
      if (mobilePush && !transientCommand && !backgroundHub && node.queue !== "all") {
        throw new Error(`Push móvel pode se perder durante reconexão: ${node.id}`);
      }
      if (/"action":"notify/.test(node.data) && !notificationHubTabs.has(node.z)) {
        throw new Error(`Saída móvel/Alexa fora do hub canônico: ${node.id}`);
      }
    }
    if (String(node.action ?? "").startsWith("persistent_notification.") && node.z !== "notification_hub_persistent_tab") {
      throw new Error(`Saída persistente fora do hub canônico: ${node.id}`);
    }
  }
  for (const target of (node.wires ?? []).flat()) {
    const targetNode = byId.get(target);
    if (!targetNode) throw new Error(`Wire ${node.id} -> ${target} aponta para node ausente`);
    if (node.z && targetNode.z && node.z !== targetNode.z) {
      throw new Error(`Wire cruza tabs sem link node: ${node.id} -> ${target}`);
    }
  }
  if (node.g) {
    const owner = byId.get(node.g);
    if (!owner || owner.type !== "group" || owner.z !== node.z || !owner.nodes.includes(node.id)) {
      throw new Error(`Grupo inconsistente em ${node.id}: ${node.g}`);
    }
  }
  if (node.type === "group") {
    for (const memberId of node.nodes ?? []) {
      const member = byId.get(memberId);
      if (!member || member.g !== node.id || member.z !== node.z) {
        throw new Error(`Membro inconsistente no grupo ${node.id}: ${memberId}`);
      }
    }
  }
  if (node.type === "link out" || node.type === "link in") {
    const expectedType = node.type === "link out" ? "link in" : "link out";
    for (const targetId of node.links ?? []) {
      const target = byId.get(targetId);
      if (!target || target.type !== expectedType || !(target.links ?? []).includes(node.id)) {
        throw new Error(`Link assimétrico: ${node.id} <-> ${targetId}`);
      }
    }
  }
}

console.log(`Valid JSON and flow graph: ${files.join(", ")}; ${flows.length} nodes`);
