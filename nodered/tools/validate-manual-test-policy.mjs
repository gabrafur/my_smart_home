#!/usr/bin/env node

import fs from "node:fs";

const flows = JSON.parse(fs.readFileSync(new URL("../flows.json", import.meta.url), "utf8"));
const policy = JSON.parse(fs.readFileSync(new URL("./manual-test-policy.json", import.meta.url), "utf8"));
const byId = new Map(flows.map((node) => [node.id, node]));
const tabs = flows.filter((node) => node.type === "tab");
const tabIds = new Set(tabs.map((tab) => tab.id));
const entries = policy.tabs ?? {};
const allowedStrategies = new Set([
  "manual_full_dry_run",
  "manual_safe",
  "manual_explicit_side_effect",
  "automated_only",
  "not_applicable",
]);
const sideEffectTypes = new Set([
  "api-call-service",
  "mqtt out",
  "http request",
  "tcp out",
  "udp out",
  "exec",
  "e-mail",
]);

if (policy.version !== 2) throw new Error("Versão inválida da política de testes manuais");

for (const tab of tabs) {
  const entry = entries[tab.id];
  if (!entry) throw new Error(`Tab sem política de teste manual: ${tab.label} (${tab.id})`);
  if (!allowedStrategies.has(entry.strategy)) {
    throw new Error(`Estratégia inválida em ${tab.label}: ${entry.strategy}`);
  }
  if (!Array.isArray(entry.evidence_node_ids)) {
    throw new Error(`evidence_node_ids inválido em ${tab.label}`);
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
    throw new Error(`Justificativa ausente ou curta em ${tab.label}`);
  }

  const tabNodes = flows.filter((node) => node.z === tab.id);
  const evidence = entry.evidence_node_ids.map((id) => {
    const node = byId.get(id);
    if (!node || node.z !== tab.id) {
      throw new Error(`Evidência ${id} ausente ou fora do tab ${tab.label}`);
    }
    return node;
  });
  const hasSideEffect = tabNodes.some((node) => sideEffectTypes.has(node.type));

  if (entry.strategy === "not_applicable" && hasSideEffect) {
    throw new Error(`Tab com efeito não pode ser not_applicable: ${tab.label}`);
  }

  if (entry.strategy.startsWith("manual_")) {
    if (!evidence.some((node) => node.type === "group")) {
      throw new Error(`Estratégia manual sem grupo de evidência em ${tab.label}`);
    }
    if (!evidence.some((node) => node.type === "inject")) {
      throw new Error(`Estratégia manual sem inject de evidência em ${tab.label}`);
    }
  }

  const approvedNotificationException =
    entry.strategy === "manual_explicit_side_effect" &&
    entry.explicit_exception === "notification_delivery_under_test";

  if (
    ["manual_safe", "manual_explicit_side_effect"].includes(entry.strategy) &&
    entry.legacy !== true &&
    !approvedNotificationException
  ) {
    throw new Error(`Estratégia manual legada sem marcação explícita em ${tab.label}`);
  }

  if (entry.strategy === "manual_full_dry_run") {
    if (!Array.isArray(entry.dry_run_terminal_ids) || entry.dry_run_terminal_ids.length === 0) {
      throw new Error(`Dry-run completo sem terminal declarado em ${tab.label}`);
    }
    for (const terminalId of entry.dry_run_terminal_ids) {
      const terminal = byId.get(terminalId);
      if (!terminal || terminal.type !== "function") {
        throw new Error(`Terminal dry-run inválido em ${tab.label}: ${terminalId}`);
      }
      if ((terminal.wires ?? []).flat().length > 0) {
        throw new Error(`Terminal dry-run não é terminal em ${tab.label}: ${terminalId}`);
      }
      if (!/simulated["']?\s*:\s*true/.test(terminal.func) || !/dispatched["']?\s*:\s*false/.test(terminal.func)) {
        throw new Error(`Terminal dry-run sem contrato simulated/dispatched em ${tab.label}: ${terminalId}`);
      }
    }
  }

  if (entry.strategy === "manual_safe") {
    if (!evidence.some((node) => node.type === "group" && /test/i.test(node.name ?? ""))) {
      throw new Error(`Teste manual seguro sem grupo identificado em ${tab.label}`);
    }
    const serialized = JSON.stringify(tabNodes);
    if (!/test_mode|_location_test/.test(serialized)) {
      throw new Error(`Teste manual seguro sem isolamento test_mode em ${tab.label}`);
    }
  }

  if (entry.strategy === "manual_explicit_side_effect") {
    const labeledInject = evidence.some(
      (node) => node.type === "inject" && /teste|testar|executar.+agora/i.test(node.name ?? ""),
    );
    if (!labeledInject) {
      throw new Error(`Efeito manual sem rótulo explícito em ${tab.label}`);
    }
    if (approvedNotificationException) {
      if (!Array.isArray(entry.delivery_node_ids) || entry.delivery_node_ids.length === 0) {
        throw new Error(`Exceção de entrega sem nós declarados em ${tab.label}`);
      }
      for (const deliveryId of entry.delivery_node_ids) {
        const delivery = byId.get(deliveryId);
        if (
          !delivery ||
          delivery.z !== tab.id ||
          delivery.type !== "api-call-service" ||
          delivery.action !== "public_bindings.call" ||
          !/"action":"(?:notify_[23]|notify_actionable)"/.test(delivery.data ?? "") ||
          !/TESTE/.test(delivery.data ?? "")
        ) {
          throw new Error(`Entrega de TESTE inválida em ${tab.label}: ${deliveryId}`);
        }
      }
    }
  }

  if (entry.strategy !== "not_applicable") {
    if (typeof entry.automated_test !== "string" || !entry.automated_test.startsWith("test-")) {
      throw new Error(`Regressão automatizada não declarada em ${tab.label}`);
    }
    if (!fs.existsSync(new URL(entry.automated_test, import.meta.url))) {
      throw new Error(`Regressão automatizada ausente em ${tab.label}: ${entry.automated_test}`);
    }
  }
}

for (const id of Object.keys(entries)) {
  if (!tabIds.has(id)) throw new Error(`Política aponta para tab inexistente: ${id}`);
}

console.log(`Política de testes manuais válida: ${tabs.length} tabs cobertos.`);
