import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { RECOVERY_SERVICES, READINESS_REQUIREMENTS, recoveryReadiness,
  recoveryDependencies, probeNames, probeContainerArgs, validateProbeContainer,
  assertRestoredMount } from "../restore/service-recovery-contract.mjs";
import { runIsolationProbe, validateProbeProof, probePrograms }
  from "./service-recovery-isolation-probe.mjs";

const operation = "a".repeat(32), image = `sha256:${"b".repeat(64)}`;
const names = probeNames(operation);
function info(role) {
  return { Id: (role === "anchor" ? "c" : "d").repeat(64), Image: image, Name: `/${names[role]}`,
    Labels: { "org.eva.recovery.operation": operation, "org.eva.recovery.scope": "isolation-probe-only" },
    Mounts: [], HostConfig: { NetworkMode: role === "anchor" ? "none" : `container:${names.anchor}`,
      Privileged: false, ReadonlyRootfs: true, Binds: [], PortBindings: {}, Devices: [],
      DeviceRequests: [], CapAdd: [], PublishAllPorts: false, PidMode: "", IpcMode: "private",
      PidsLimit: 16, Memory: 64 * 1024 * 1024, NanoCpus: 50_000_000,
      Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }],
      RestartPolicy: { Name: "no" }, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] } };
}
function proof() {
  const facts = () => ({ interfaces: ["lo"], routes: 0, capabilities_zero: true, no_new_privileges: true,
    address_space_limit: [67108864, 67108864], oversized_allocation_rejected: true,
    cpu_max: "5000 100000", pids_max: "16" });
  return { anchor: facts(), peer: facts(), loopback_http: true,
    aliases: Object.fromEntries(RECOVERY_SERVICES.map(name => [name, "127.0.0.1"])) };
}

test("all seven services retain each observed readiness requirement", () => {
  assert.equal(RECOVERY_SERVICES.length, 7);
  for (const service of RECOVERY_SERVICES) {
    const facts = Object.fromEntries(READINESS_REQUIREMENTS[service].map(key => [key, true]));
    assert.equal(recoveryReadiness(service, facts).ready, true);
    for (const key of READINESS_REQUIREMENTS[service]) {
      for (const value of [false, undefined, "true", 1]) {
        assert.equal(recoveryReadiness(service, { ...facts, [key]: value }).ready, false, `${service}/${key}`);
      }
    }
  }
  assert.throws(() => recoveryReadiness("unknown", {}));
});

test("criteria agree with the canonical offsite runtime gate, including failures", async () => {
  const source = fs.readFileSync(new URL("./offsite-backup.mjs", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("async function serviceReady(service)"), source.indexOf("async function waitForServices"));
  for (const service of RECOVERY_SERVICES) {
    for (const failed of [null, ...READINESS_REQUIREMENTS[service]]) {
      const facts = Object.fromEntries(READINESS_REQUIREMENTS[service].map(key => [key, key !== failed]));
      const context = { inspectContainer: () => ({ Running: facts.running, Restarting: !facts.not_restarting,
        Health: { Status: facts.native_health_healthy ? "healthy" : "unhealthy" } }),
        probeService: () => READINESS_REQUIREMENTS[service].slice(2).every(key => facts[key]),
        tcpReady: async (_host, port) => facts[`tcp_${port}`] === true,
        runChecked: () => "isolated-address" };
      const canonical = vm.runInNewContext(`${gate};serviceReady`, context);
      assert.equal(await canonical(service), recoveryReadiness(service, facts).ready, `${service}/${failed}`);
    }
  }
});

test("planning cannot turn file verification or approval flags into recovery proof", () => {
  assert.equal(recoveryDependencies().blockers.length, 5);
  const planned = recoveryDependencies({ fullHA: { protected: true, authenticated: true, homeassistant_database_included: true },
    compose: { canonical_thirteen_components: true, authenticated: true },
    extraKeyReadApproved: true, radioLeaseApproved: true, componentIdentitiesVerified: true });
  assert.equal(planned.prerequisites_satisfied, true);
  assert.equal(planned.service_recovery_proven, false);
  assert.ok(recoveryDependencies({ fullHA: { protected: true, homeassistant_database_included: true } })
    .blockers.includes("authenticated_full_HA_backup_with_Recorder_required"));
});

test("probe plan permits only immutable local images and two unprivileged namespaces", () => {
  for (const role of ["anchor", "peer"]) {
    const args = probeContainerArgs({ operation, image, role });
    assert.ok(args.includes("--pull=never"));
    for (const denied of ["--privileged", "--device", "--volume", "-v", "--publish", "-p", "--network=host"])
      assert.ok(!args.includes(denied));
    assert.equal(args[args.indexOf("--network") + 1], role === "anchor" ? "none" : `container:${names.anchor}`);
  }
  for (const overrides of [{ image: "latest" }, { role: "host" }, { operation: "../bad" }, { memoryBackend: "unlimited" }])
    assert.throws(() => probeContainerArgs({ operation, image, role: "anchor", ...overrides }));
});

test("inspect rejects every escape surface and malformed evidence", () => {
  assert.equal(validateProbeContainer(info("anchor"), { operation, image, role: "anchor" }).isolation_verified, true);
  const changes = { NetworkMode: "host", Privileged: true, ReadonlyRootfs: false,
    Binds: ["/:/host"], PortBindings: { "80/tcp": [{}] }, Devices: [{}], DeviceRequests: [{}],
    CapAdd: ["SYS_ADMIN"], PublishAllPorts: true, PidMode: "host", IpcMode: "host",
    PidsLimit: 0, Memory: 0, NanoCpus: 0, RestartPolicy: { Name: "always" },
    CapDrop: [], SecurityOpt: [], Ulimits: [], BindsMalformed: true };
  for (const [key, value] of Object.entries(changes)) {
    const row = info("anchor");
    row.HostConfig[key === "BindsMalformed" ? "Binds" : key] = value;
    assert.throws(() => validateProbeContainer(row, { operation, image, role: "anchor" }), key);
  }
  const peer = info("peer"); peer.AnchorID = "c".repeat(64); peer.HostConfig.NetworkMode = `container:${peer.AnchorID}`;
  assert.equal(validateProbeContainer(peer, { operation, image, role: "peer" }).identity_verified, true);
  peer.HostConfig.NetworkMode = "container:undefined"; delete peer.AnchorID;
  assert.throws(() => validateProbeContainer(peer, { operation, image, role: "peer" }));
});

test("absence of memory controller never silently selects another backend", () => {
  const row = info("anchor"); row.HostConfig.Memory = 0;
  assert.throws(() => validateProbeContainer(row, { operation, image, role: "anchor" }));
  const expectedProgram = probePrograms(operation).anchor;
  row.Entrypoint = ["/usr/local/bin/python3"]; row.Cmd = ["-I", "-S", "-B", "-c", expectedProgram];
  assert.equal(validateProbeContainer(row, { operation, image, role: "anchor", memoryBackend: "python_rlimit_as", expectedProgram })
    .isolation_verified, true);
  row.Cmd = ["-c", "arbitrary.py"];
  assert.throws(() => validateProbeContainer(row, { operation, image, role: "anchor", memoryBackend: "python_rlimit_as", expectedProgram }));
});

test("guest evidence requires both namespaces, zero routes and all logical aliases", () => {
  assert.equal(validateProbeProof(proof()), true);
  for (const change of [row => row.anchor.interfaces.push("eth0"), row => row.peer.routes++,
    row => row.peer.capabilities_zero = false, row => row.anchor.no_new_privileges = false,
    row => row.aliases.mosquitto = "192.0.2.1", row => delete row.aliases.nodered,
    row => row.peer.address_space_limit[1] = -1, row => row.peer.oversized_allocation_rejected = false,
    row => row.anchor.cpu_max = "max 100000", row => row.peer.pids_max = "max"]) {
    const row = proof(); change(row); assert.throws(() => validateProbeProof(row));
  }
  assert.throws(() => probePrograms("arbitrary-python"));
});

test("mount planning excludes live paths, escapes, wrong destinations; requires filesystem check", () => {
  const root = `/var/lib/raspberry-service-recovery/restored/${operation}`;
  assert.equal(assertRestoredMount(`${root}/nodered`, root, "/data", "nodered")
    .filesystem_identity_check_still_required, true);
  for (const [source, base, destination, role] of [[root, root, "/data", "nodered"],
    [`${root}/../live`, root, "/data", "nodered"], ["/mnt/data/docker/nodered", root, "/data", "nodered"],
    [`${root}/data`, root, "/run/docker.sock", "nodered"], [`${root}/data`, "/tmp/restore", "/data", "nodered"],
    [`${root}/data`, root, "/data", "unknown"]])
    assert.throws(() => assertRestoredMount(source, base, destination, role));
});

function fakeDocker({ failAt, foreignCleanup = false, proofOverride, preexisting = false, imageVolumes = null } = {}) {
  const containers = new Map(), calls = [], records = new Map(); let createCount = 0;
  if (preexisting) containers.set(names.anchor, info("anchor"));
  const execute = args => {
    calls.push(args);
    if (args[0] === "image") return JSON.stringify(imageVolumes);
    if (args[0] === "create") {
      const role = ++createCount === 1 ? "anchor" : "peer", row = info(role);
      row.Entrypoint = ["/usr/local/bin/python3"]; row.Cmd = args.slice(args.indexOf(image) + 1);
      if (!args.includes("--memory=64m")) row.HostConfig.Memory = 0;
      containers.set(names[role], row);
      if (failAt === `${role}-create-unknown`) throw new Error("transport_lost");
      return `${row.Id}\n`;
    }
    if (args[0] === "inspect") {
      const row = structuredClone(containers.get(args.at(-1)));
      if (!row) throw new Error("not_found");
      if (foreignCleanup && calls.some(call => call[0] === "exec")) row.Labels = {};
      return JSON.stringify(row);
    }
    if (args[0] === "container") return [...containers.values()].map(row =>
      args.at(-1) === "{{.ID}}" ? row.Id : row.Name.slice(1)).join("\n");
    if (args[0] === "start") return args[1];
    if (args[0] === "exec") return JSON.stringify(proofOverride ?? proof());
    if (args[0] === "rm") {
      if (failAt === "remove-unknown") throw new Error("transport_lost");
      for (const [name, row] of containers) if (row.Id === args.at(-1)) containers.delete(name);
      return args.at(-1);
    }
    throw new Error("unexpected_command");
  };
  const record = (phase, row) => { assert.ok(!records.has(phase)); records.set(phase, row); };
  return { execute, record, calls, records, containers };
}

test("neutral probe verifies then removes both, without claiming service recovery", () => {
  const fake = fakeDocker();
  const result = runIsolationProbe({ operation, image, ...fake });
  assert.equal(result.state, "neutral_probe_verified_cleaned");
  assert.equal(result.service_recovery_proven, false);
  assert.equal(fake.containers.size, 0);
  assert.ok(fake.calls.filter(call => call[0] === "inspect").every(call => !call[2].includes(".Env")));
});

test("Python-only backend attests the exact program and its hard limit without cgroup fallback", () => {
  const fake = fakeDocker();
  const result = runIsolationProbe({ operation, image, memoryBackend: "python_rlimit_as", ...fake });
  assert.equal(result.state, "neutral_probe_verified_cleaned");
  assert.equal(result.memory_backend, "python_rlimit_as");
  assert.ok(fake.calls.filter(call => call[0] === "create").every(call =>
    !call.includes("--memory=64m") && !call.some(arg => arg.startsWith("--ulimit=as="))));
});

test("unknown create reconciles exact owned identity once and stops without retry", () => {
  const fake = fakeDocker({ failAt: "anchor-create-unknown" });
  const result = runIsolationProbe({ operation, image, ...fake });
  assert.equal(result.state, "unconfirmed");
  assert.equal(fake.calls.filter(call => call[0] === "create").length, 1);
  assert.equal(fake.calls.filter(call => call[0] === "rm").length, 1);
  assert.equal(fake.containers.size, 0);
});

test("existing name, foreign identity and uncertain removal never produce green or blind retries", () => {
  for (const options of [{ preexisting: true }, { imageVolumes: { "/config": {} } },
    { foreignCleanup: true }, { failAt: "remove-unknown" },
    { proofOverride: { ...proof(), loopback_http: false } }]) {
    const fake = fakeDocker(options), result = runIsolationProbe({ operation, image, ...fake });
    assert.equal(result.state, "unconfirmed");
    if (options.preexisting || options.foreignCleanup || options.imageVolumes)
      assert.equal(fake.calls.filter(call => call[0] === "rm").length, 0);
    if (options.failAt) assert.equal(fake.calls.filter(call => call[0] === "rm").length, 2);
  }
});
