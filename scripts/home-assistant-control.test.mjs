import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeText,
  parseRequest,
  residentialEntityAllowed,
  searchTokens,
} from "./home-assistant-control.mjs";

test("normalizes Portuguese entity names", () => {
  assert.equal(normalizeText("Abajúr da Sala-de-Estar"), "abajur da sala de estar");
  assert.deepEqual(searchTokens("Abajour da sala de estar"), ["abajour", "sala", "estar"]);
});

test("accepts a bounded residential control request", () => {
  assert.deepEqual(
    parseRequest(["turn-off", "--query", "Abajour da sala de estar"]),
    { action: "turn-off", entity_id: null, query: "Abajour da sala de estar" },
  );
});

test("rejects unsupported actions and incomplete requests", () => {
  assert.throws(() => parseRequest(["restart", "--query", "Home Assistant"]));
  assert.throws(() => parseRequest(["turn-off"]));
});

test("allows home entities and blocks infrastructure-like entities", () => {
  assert.equal(residentialEntityAllowed({ entity_id: "switch.abajour_sala", attributes: { friendly_name: "Abajour" } }), true);
  assert.equal(residentialEntityAllowed({ entity_id: "switch.docker_host", attributes: { friendly_name: "Docker" } }), false);
  assert.equal(residentialEntityAllowed({ entity_id: "sensor.abajour_power", attributes: { friendly_name: "Potência" } }), false);
});
