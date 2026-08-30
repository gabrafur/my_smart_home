"use strict";

const PRIVATE_LABEL_NODE_IDS = Object.freeze({
    notifyPrimary: "resident_notifications_notify_primary",
    notifySecondary: "resident_notifications_notify_secondary",
});

function displayNameForRole(bindings, role) {
    const alias = bindings?.roles?.[role]?.source_alias;

    if (typeof alias !== "string") return null;

    const words = alias
        .trim()
        .split(/[\s_-]+/u)
        .filter(Boolean);

    if (
        words.length === 0 ||
        words.some((word) => !/^[\p{L}\p{M}.'’]+$/u.test(word))
    ) {
        return null;
    }

    return words
        .map((word) => (
            word.charAt(0).toLocaleUpperCase("pt-BR") +
            word.slice(1)
        ))
        .join(" ");
}

function buildPrivateFlowLabels(bindings) {
    const primary = displayNameForRole(bindings, "resident_primary");
    const secondary = displayNameForRole(bindings, "resident_secondary");

    if (!primary || !secondary) return {};

    return {
        [PRIVATE_LABEL_NODE_IDS.notifyPrimary]:
            `Avisar ${primary}: ${secondary} se aproxima`,
        [PRIVATE_LABEL_NODE_IDS.notifySecondary]:
            `Avisar ${secondary}: ${primary} se aproxima`,
    };
}

function registerPrivateFlowLabels(RED) {
    RED.httpAdmin.get(
        "/private-flow-labels",
        RED.auth.needsPermission("flows.read"),
        (_request, response) => {
            response.set("Cache-Control", "no-store, private");
            response.json({
                labels: buildPrivateFlowLabels(
                    RED.settings.functionGlobalContext?.publicBindings,
                ),
            });
        },
    );

    function PrivateFlowLabelsNode(config) {
        RED.nodes.createNode(this, config);
    }

    RED.nodes.registerType("private-flow-labels", PrivateFlowLabelsNode);
}

module.exports = registerPrivateFlowLabels;
module.exports.buildPrivateFlowLabels = buildPrivateFlowLabels;
module.exports.displayNameForRole = displayNameForRole;
