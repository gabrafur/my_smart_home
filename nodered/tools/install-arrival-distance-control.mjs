#!/usr/bin/env node

import fs from "node:fs";

const flowPath = new URL("../flows.json", import.meta.url);
const outputPath = process.env.NODE_RED_FLOW_OUTPUT
  ? new URL(`file://${process.env.NODE_RED_FLOW_OUTPUT}`)
  : flowPath;
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));

const radius = flows.find(
  (node) => node.id === "people_location_arrival_distance_v1",
);
const policy = flows.find(
  (node) => node.id === "people_location_policy_apply_v1",
);
const people = flows.find(
  (node) => node.name === "Normalizar pessoas e detectar transições",
);
const vehicle = flows.find(
  (node) => node.name === "Normalizar vehicle_primary e detectar transições",
);

if (
  radius?.payload !== "700" ||
  radius?.topic !== "arrival_distance_m" ||
  !policy?.func?.includes("arrival_distance_m") ||
  !people?.func?.includes("LOCATION_POLICY.arrival_distance_m") ||
  !vehicle?.func?.includes("LOCATION_POLICY.arrival_distance_m")
) {
  throw new Error(
    "Raio canônico de 700 m ausente; execute flows:update-people-location-selection",
  );
}

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Raio canônico de chegada validado: 700 m para pessoas e veículo.");
