// Neutral network/isolation experiment only. This module never restores data,
// reads keys, admits privileged execution, or grants authority to its caller.
import { probeNames, probeContainerArgs, validateProbeContainer, RECOVERY_SERVICES }
  from "../restore/service-recovery-contract.mjs";

const python = "/usr/local/bin/python3";
const common = `import resource;resource.setrlimit(resource.RLIMIT_AS,(67108864,67108864))
import json,os,socket,signal,time
def facts():
 status=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
 limits=resource.getrlimit(resource.RLIMIT_AS)
 rejected=False
 if limits==(67108864,67108864):
  try:allocation=bytearray(80*1024*1024)
  except MemoryError:rejected=True
  else:del allocation
 return {'interfaces':sorted(os.listdir('/sys/class/net')),
  'routes':len(open('/proc/net/route').read().splitlines())-1,
  'capabilities_zero':int(status['CapEff'].strip(),16)==0,
  'no_new_privileges':status['NoNewPrivs'].strip()=='1',
  'address_space_limit':list(limits),'oversized_allocation_rejected':rejected,
  'cpu_max':open('/sys/fs/cgroup/cpu.max').read().strip(),
  'pids_max':open('/sys/fs/cgroup/pids.max').read().strip()}
signal.signal(signal.SIGALRM,lambda *_:os._exit(0));signal.alarm(120)
`;

export function probePrograms(operation) {
  probeNames(operation);
  const anchor = `${common}
from http.server import HTTPServer,BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps({'operation':'${operation}','anchor':facts()}).encode()
  self.send_response(200);self.end_headers();self.wfile.write(body)
 def log_message(self,*_):pass
HTTPServer(('127.0.0.1',8029),Handler).serve_forever()
`;
  const peer = `${common}\ntime.sleep(120)\n`;
  const proof = `${common}
import urllib.request
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
body=None
for attempt in range(20):
 try:
  body=json.loads(opener.open('http://127.0.0.1:8029/',timeout=1).read(4096));break
 except (OSError,ValueError):time.sleep(0.1)
assert body is not None and body['operation']=='${operation}'
aliases={name:socket.gethostbyname(name) for name in ${JSON.stringify(RECOVERY_SERVICES)}}
print(json.dumps({'anchor':body['anchor'],'peer':facts(),'aliases':aliases,'loopback_http':True}))
`;
  return { anchor, peer, proof };
}

function identity(info, operation, image, name) {
  return /^[a-f0-9]{64}$/.test(info?.Id ?? "") && info.Image === image &&
    info.Name === `/${name}` && info.Labels?.["org.eva.recovery.operation"] === operation &&
    info.Labels?.["org.eva.recovery.scope"] === "isolation-probe-only";
}

export function validateProbeProof(proof) {
  for (const role of ["anchor", "peer"]) {
    const row = proof?.[role];
    if (JSON.stringify(row?.interfaces) !== '["lo"]' || row.routes !== 0 ||
        row.capabilities_zero !== true || row.no_new_privileges !== true ||
        JSON.stringify(row.address_space_limit) !== '[67108864,67108864]' ||
        row.oversized_allocation_rejected !== true || row.pids_max !== "16" ||
        row.cpu_max !== "5000 100000")
      throw new Error("guest_isolation_unconfirmed");
  }
  if (proof.loopback_http !== true || !proof.aliases ||
      JSON.stringify(Object.keys(proof.aliases).sort()) !== JSON.stringify([...RECOVERY_SERVICES].sort()) ||
      Object.values(proof.aliases).some(value => value !== "127.0.0.1"))
    throw new Error("loopback_service_discovery_unconfirmed");
  return true;
}

// execute takes Docker argv and returns bounded stdout, or throws on any error.
// record must persist each unique phase exclusively; existing intents are never
// resumed by this function. Admission, sealed sources and expiry belong to the
// separately reviewed caller, before importing/executing this module.
export function runIsolationProbe({ operation, image, execute, record, memoryBackend = "cgroup" }) {
  const names = probeNames(operation), programs = probePrograms(operation);
  const plans = Object.fromEntries(["anchor", "peer"].map(role =>
    [role, probeContainerArgs({ operation, image, role, memoryBackend })]));
  const fields = ["Id", "Image", "Name", "HostConfig", "Mounts"];
  const format = `{${fields.map(key => `"${key}":{{json .${key}}}`).join(",")},"Labels":{{json .Config.Labels}},"Entrypoint":{{json .Config.Entrypoint}},"Cmd":{{json .Config.Cmd}}}`;
  const inspect = name => JSON.parse(execute(["inspect", "--format",
    format, name]));
  let failure = null, proof = null;
  let phase = "image_preflight";
  const intended = [], cleaned = [], cleanupUnconfirmed = [];
  const known = {};
  record("intent", { operation, image, memory_backend: memoryBackend,
    scope: "neutral_isolation_probe", automatic_retry: false });
  try {
    const imageVolumes = JSON.parse(execute(["image", "inspect", "--format", "{{json .Config.Volumes}}", image]));
    if (imageVolumes !== null && (typeof imageVolumes !== "object" || Object.keys(imageVolumes).length))
      throw new Error("image_declared_volumes_refused");
    for (const role of ["anchor", "peer"]) {
      phase = `${role}_create`;
      const existingNames = execute(["container", "ls", "--all", "--format", "{{.Names}}"])
        .trim().split(/\s+/);
      if (existingNames.includes(names[role])) throw new Error("existing_container_requires_reconciliation");
      record(`${role}-create-intent`, { name: names[role] });
      intended.push(role);
      const id = execute([...plans[role], "-I", "-S", "-B", "-c", programs[role]]).trim();
      const info = inspect(names[role]);
      // Own synthetic container only; the formatter excludes Config.Env.
      record(`${role}-observed`, { container: info });
      if (!identity(info, operation, image, names[role]) || info.Id !== id)
        throw new Error("created_container_identity_unconfirmed");
      info.AnchorID = known.anchor;
      validateProbeContainer(info, { operation, image, role, memoryBackend, expectedProgram: programs[role] });
      known[role] = id;
      record(`${role}-verified`, { id, isolation_verified: true });
      phase = `${role}_start`;
      execute(["start", id]);
    }
    phase = "guest_proof";
    proof = JSON.parse(execute(["exec", known.peer, python, "-I", "-S", "-B", "-c", programs.proof]));
    validateProbeProof(proof);
    record("proof", { proof, restored_services_started: 0, private_mounts: 0,
      physical_devices: 0, service_recovery_proven: false });
  } catch (error) {
    failure = error;
  } finally {
    for (const role of [...intended].reverse()) {
      try {
        const existingNames = execute(["container", "ls", "--all", "--format", "{{.Names}}"])
          .trim().split(/\s+/);
        if (!existingNames.includes(names[role])) {
          record(`${role}-absent`, { name: names[role], absence_verified_by_inventory: true });
          cleaned.push(role);
          continue;
        }
        const info = inspect(names[role]);
        if (!identity(info, operation, image, names[role])) throw new Error("cleanup_identity_unconfirmed");
        record(`${role}-remove-intent`, { id: info.Id, automatic_retry: false });
        execute(["rm", "--force", info.Id]);
        // Inspect a full bounded ID inventory: an error is never treated as absence.
        const ids = execute(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"])
          .trim().split(/\s+/);
        if (ids.includes(info.Id)) throw new Error("cleanup_absence_unconfirmed");
        cleaned.push(role);
        record(`${role}-removed`, { id: info.Id, absent: true });
      } catch {
        cleanupUnconfirmed.push(role);
      }
    }
  }
  const result = { state: failure || cleanupUnconfirmed.length ? "unconfirmed" : "neutral_probe_verified_cleaned",
    failure_kind: failure?.name ?? null,
    failure_phase: failure ? phase : null,
    failure_reason: failure && ["image_declared_volumes_refused", "existing_container_requires_reconciliation",
      "created_container_identity_unconfirmed", "container_identity_unconfirmed", "container_isolation_unconfirmed",
      "guest_isolation_unconfirmed", "loopback_service_discovery_unconfirmed", "docker_command_unconfirmed"]
      .includes(failure.message) ? failure.message : failure ? "withheld" : null,
    operation, memory_backend: memoryBackend, proof_verified: proof !== null && !failure,
    cleaned, cleanup_unconfirmed: cleanupUnconfirmed,
    service_recovery_proven: false, restored_services_started: 0, private_mounts: 0,
    physical_devices: 0, automatic_retry: false };
  record("result", result);
  return result;
}
