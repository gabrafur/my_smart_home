import path from "node:path";

export const RECOVERY_SERVICES = Object.freeze([
  "homeassistant", "nodered", "mosquitto", "portainer", "appdaemon",
  "matter_server", "zigbee2mqtt",
]);

// Extracted from offsite-backup.mjs::serviceReady and container-readiness.mjs.
// The restore harness must supply observations from its own restored processes.
export const READINESS_REQUIREMENTS = Object.freeze({
  homeassistant: ["running", "not_restarting", "native_health_healthy"],
  nodered: ["running", "not_restarting", "fresh_started_flows", "auth_login_http_200"],
  mosquitto: ["running", "not_restarting", "authenticated_mqtt_connect"],
  portainer: ["running", "not_restarting", "tcp_9000"],
  appdaemon: ["running", "not_restarting", "tcp_5050"],
  matter_server: ["running", "not_restarting", "tcp_5580"],
  zigbee2mqtt: ["running", "not_restarting", "fresh_zigbee_started", "mqtt_bridge_online"],
});

export function recoveryReadiness(service, facts) {
  if (!Object.hasOwn(READINESS_REQUIREMENTS, service)) throw new Error("service_outside_scope");
  const missing = READINESS_REQUIREMENTS[service].filter(key => facts?.[key] !== true);
  return { service, ready: missing.length === 0, missing,
    coverage: ["restored_application_readiness_only", "not_household_device_recovery"] };
}

export function recoveryDependencies({ fullHA, compose, extraKeyReadApproved = false,
  radioLeaseApproved = false, componentIdentitiesVerified = false } = {}) {
  const blockers = [];
  if (fullHA?.protected !== true || fullHA?.authenticated !== true ||
      fullHA?.homeassistant_database_included !== true)
    blockers.push("authenticated_full_HA_backup_with_Recorder_required");
  if (compose?.canonical_thirteen_components !== true || compose?.authenticated !== true)
    blockers.push("authenticated_canonical_Compose_bundle_required");
  if (componentIdentitiesVerified !== true) blockers.push("cross_surface_identity_verification_required");
  if (extraKeyReadApproved !== true) blockers.push("consumed_key_scope_not_renewed");
  if (radioLeaseApproved !== true) blockers.push("separate_physical_coordinator_scope_required");
  return { prerequisites_satisfied: blockers.length === 0, blockers,
    services: [...RECOVERY_SERVICES], service_recovery_proven: false };
}

export function probeNames(operation) {
  if (!/^[a-f0-9]{32}$/.test(operation)) throw new Error("invalid_operation_identifier");
  return { anchor: `eva-restore-${operation}-net`, peer: `eva-restore-${operation}-peer` };
}

export function probeContainerArgs({ operation, image, role, memoryBackend = "cgroup" }) {
  const names = probeNames(operation);
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !["anchor", "peer"].includes(role) ||
      !["cgroup", "python_rlimit_as"].includes(memoryBackend))
    throw new Error("probe_scope_refused");
  const args = ["create", "--pull=never", "--name", names[role],
    "--label", "org.eva.recovery.scope=isolation-probe-only",
    "--label", `org.eva.recovery.operation=${operation}`,
    "--network", role === "anchor" ? "none" : `container:${names.anchor}`,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--pids-limit=16", "--ulimit=core=0:0", "--cpus=0.05", "--restart=no",
    "--no-healthcheck", "--entrypoint", "/usr/local/bin/python3"];
  if (memoryBackend === "cgroup") args.push("--memory=64m");
  if (role === "anchor") {
    for (const name of RECOVERY_SERVICES) args.push("--add-host", `${name}:127.0.0.1`);
  }
  return [...args, image];
}

export function validateProbeContainer(info, { operation, image, role, memoryBackend = "cgroup", expectedProgram }) {
  if (!["anchor", "peer"].includes(role) || !/^sha256:[a-f0-9]{64}$/.test(image) ||
      !["cgroup", "python_rlimit_as"].includes(memoryBackend))
    throw new Error("probe_scope_refused");
  const names = probeNames(operation), host = info?.HostConfig;
  if (!host || info.Image !== image || info.Name !== `/${names[role]}` ||
      info.Labels?.["org.eva.recovery.scope"] !== "isolation-probe-only" ||
      info.Labels?.["org.eva.recovery.operation"] !== operation)
    throw new Error("container_identity_unconfirmed");
  const empty = value => value == null || (typeof value === "object" && Object.keys(value).length === 0);
  const namespace = role === "anchor" ? host.NetworkMode === "none" :
    host.NetworkMode === `container:${names.anchor}` ||
      (/^[a-f0-9]{64}$/.test(info.AnchorID ?? "") && host.NetworkMode === `container:${info.AnchorID}`);
  if (!namespace || host.Privileged !== false || host.ReadonlyRootfs !== true ||
      !empty(host.Binds) || !empty(info.Mounts) || !empty(host.PortBindings) ||
      !empty(host.Devices) || !empty(host.DeviceRequests) || !empty(host.CapAdd) || host.PublishAllPorts !== false ||
      !["", "private"].includes(host.PidMode) || !["", "private"].includes(host.IpcMode) ||
      host.PidsLimit !== 16 || host.Memory !== (memoryBackend === "cgroup" ? 64 * 1024 * 1024 : 0) ||
      !Array.isArray(host.Ulimits) || !host.Ulimits.some(row => row.Name === "core" && row.Soft === 0 && row.Hard === 0) ||
      (memoryBackend === "python_rlimit_as" && (typeof expectedProgram !== "string" ||
        !expectedProgram.startsWith("import resource;resource.setrlimit(resource.RLIMIT_AS,(67108864,67108864))\n") ||
        JSON.stringify(info.Entrypoint) !== '["/usr/local/bin/python3"]' ||
        JSON.stringify(info.Cmd) !== JSON.stringify(["-I", "-S", "-B", "-c", expectedProgram]))) ||
      host.NanoCpus !== 50_000_000 || host.RestartPolicy?.Name !== "no" ||
      !Array.isArray(host.CapDrop) || !host.CapDrop.some(x => ["ALL", "CAP_ALL"].includes(x)) ||
      !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some(x => ["no-new-privileges", "no-new-privileges:true"].includes(x)))
    throw new Error("container_isolation_unconfirmed");
  return { identity_verified: true, isolation_verified: true };
}

export function assertRestoredMount(source, root, destination, service) {
  if (!RECOVERY_SERVICES.includes(service)) throw new Error("service_outside_scope");
  const destinations = { homeassistant: ["/config"], nodered: ["/data"],
    mosquitto: ["/mosquitto/config", "/mosquitto/data"], portainer: ["/data"],
    appdaemon: ["/conf"], matter_server: ["/data"], zigbee2mqtt: ["/app/data"] };
  const base = path.resolve(root), target = path.resolve(source), relative = path.relative(base, target);
  if (!/^\/var\/lib\/raspberry-service-recovery\/restored\/[a-f0-9]{32}$/.test(base) ||
      !relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      !destinations[service].includes(destination)) throw new Error("restored_mount_outside_scope");
  return { source: target, destination, filesystem_identity_check_still_required: true };
}
