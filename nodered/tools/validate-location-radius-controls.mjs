#!/usr/bin/env node

import fs from "node:fs";

const flowPath = new URL("../flows.json", import.meta.url);
const outputPath = process.env.NODE_RED_FLOW_OUTPUT
  ? new URL(`file://${process.env.NODE_RED_FLOW_OUTPUT}`)
  : flowPath;
const flows = JSON.parse(fs.readFileSync(flowPath, "utf8"));

const nearHomeRadius = flows.find(
  (node) => node.id === "people_location_near_home_radius_v1",
);
const homeRadius = flows.find(
  (node) => node.id === "people_location_home_radius_v1",
);
const fastRefreshRadius = flows.find(
  (node) => node.id === "people_location_fast_refresh_radius_v1",
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
  nearHomeRadius?.payload !== "700" ||
  nearHomeRadius?.topic !== "near_home_radius_m" ||
  homeRadius?.payload !== "100" ||
  homeRadius?.topic !== "home_radius_m" ||
  fastRefreshRadius?.payload !== "2000" ||
  fastRefreshRadius?.topic !== "people_fast_refresh_radius_m" ||
  !policy?.func?.includes("near_home_radius_m") ||
  !policy?.func?.includes("home_radius_m") ||
  !policy?.func?.includes("people_fast_refresh_radius_m") ||
  !people?.func?.includes("LOCATION_POLICY.near_home_radius_m") ||
  !vehicle?.func?.includes("LOCATION_POLICY.near_home_radius_m")
) {
  throw new Error(
    "Controles canônicos de raio ausentes; execute flows:update-location",
  );
}

fs.writeFileSync(outputPath, `${JSON.stringify(flows, null, 4)}\n`);
console.log("Raios canônicos validados: home, near_home e refresh rápido.");
