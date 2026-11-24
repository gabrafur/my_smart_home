#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { STOP_ARGS, STOP_TIMEOUT_SECONDS, announcePlannedRestart, plannedRestartNotice } from "./home-assistant-planned-stop.mjs";

test("integration updaters give Home Assistant time to close the recorder", () => {
  assert.ok(STOP_TIMEOUT_SECONDS >= 120);
  assert.deepEqual(STOP_ARGS, ["compose", "stop", "--timeout", "120", "homeassistant"]);
  for (const file of ["alexa-media-safe-update.mjs", "kia-uvo-safe-update.mjs"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /"compose", "stop"/, `${file} must use the shared graceful stop`);
    assert.equal(source.match(/stopHomeAssistant\(\)/g).length, 3, `${file}: definition, apply and rollback`);
    assert.match(source, /announcePlannedRestart\(/);
  }
});

test("the start notice names the reason and the stop duration", () => {
  const now = new Date("2026-11-24T06:01:27Z");
  const clean = plannedRestartNotice({ reason: "atualização da Alexa Media v5.22.1", stopSeconds: 44.6, now });
  assert.equal(clean.notification_id, "raspberry_pi_home_assistant_started");
  assert.equal(clean.message,
    "Reinício planejado: atualização da Alexa Media v5.22.1. Parada concluída em 45 s, dentro do prazo. Registrado em 2026-11-24T06:01:27.000Z.");
  assert.match(plannedRestartNotice({ reason: "x", stopSeconds: 120, now }).message, /foi forçada/);
  assert.doesNotMatch(plannedRestartNotice({ reason: "a{{b}}\n<c>", now }).message, /[{}<>\n]/);
  assert.throws(() => plannedRestartNotice({ reason: " ", now }));
});

test("a failed notice never fails the update", async () => {
  assert.equal(await announcePlannedRestart(async () => { throw new Error("down"); }, { reason: "x" }), false);
  const calls = [];
  assert.equal(await announcePlannedRestart(async (...args) => { calls.push(args); }, { reason: "x" }), true);
  assert.equal(calls[0][0], "/api/services/persistent_notification/create");
});

test("planned stops leave time for the Zigbee2MQTT radio backup and the recorder", () => {
  const source = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(source("offsite-backup.mjs"), /"compose", "stop", "--timeout", "120"/);
  assert.match(source("docker-auto-update.mjs"), /"up", "-d", "--no-deps", "--timeout", "120"/);
  assert.match(source("zigbee-firmware-maintenance.mjs"), /'stop','-t','120','zigbee2mqtt'\],150000/);
});
