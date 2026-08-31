#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(process.argv[2] ?? path.resolve(here, "..", "flows.json"));
const outputPath = path.resolve(process.argv[3] ?? sourcePath);
const functionDir = path.join(here, "functions");
const TAB = "host_memory_guardian_tab";
const flows = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const source = (name) => fs.readFileSync(path.join(functionDir, name), "utf8").trimEnd();
const owned = (node) => node.id === TAB || node.z === TAB || node.id.startsWith("host_memory_guardian_");
const removed = new Set(flows.filter(owned).map((node) => node.id));
const next = flows.filter((node) => !owned(node));
for (const node of next) {
  for (const field of ["nodes", "scope", "links"]) {
    if (Array.isArray(node[field])) node[field] = node[field].filter((id) => !removed.has(id));
  }
  if (Array.isArray(node.wires)) {
    node.wires = node.wires.map((wire) => Array.isArray(wire) ? wire.filter((id) => !removed.has(id)) : wire);
  }
}

const nodes = [];
const add = (node) => { nodes.push(node); return node.id; };
const group = (id, name, x, y, w, h, color) => add({
  id,
  type: "group",
  z: TAB,
  name,
  style: { label: true, color, fill: "#1f1f1f", fillOpacity: "0.18" },
  nodes: [],
  x,
  y,
  w,
  h,
});
const groups = {
  request: group(
    "host_memory_guardian_request_group",
    "1. Solicitar verificação recorrente — sem acesso direto aos PIDs",
    64, 20, 1360, 300, "#5b8db8",
  ),
  result: group(
    "host_memory_guardian_result_group",
    "2. Ler resultado sanitizado e observar a proteção",
    64, 360, 1360, 300, "#4d9a6a",
  ),
  test: group(
    "host_memory_guardian_test_group",
    "TESTE — pedidos e resultados completos em dry-run",
    64, 700, 1360, 400, "#c9b458",
  ),
};
const grouped = (groupId, node) => {
  add(node);
  nodes.find((entry) => entry.id === groupId).nodes.push(node.id);
  return node.id;
};
const fn = (id, g, name, file, outputs, x, y, wires) => grouped(g, {
  id,
  type: "function",
  z: TAB,
  g,
  name,
  func: source(file),
  outputs,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires,
});
const inlineFn = (id, g, name, func, x, y) => grouped(g, {
  id,
  type: "function",
  z: TAB,
  g,
  name,
  func,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires: [],
});
const inject = (id, g, name, props, x, y, wires, extra = {}) => grouped(g, {
  id,
  type: "inject",
  z: TAB,
  g,
  name,
  props,
  repeat: "",
  crontab: "",
  once: false,
  onceDelay: 0.1,
  topic: "",
  x,
  y,
  wires,
  ...extra,
});
const linkOut = (id, g, name, target, x, y) => grouped(g, {
  id,
  type: "link out",
  z: TAB,
  g,
  name,
  mode: "link",
  links: [target],
  x,
  y,
  wires: [],
});
const linkIn = (id, g, name, origin, destination, x, y) => grouped(g, {
  id,
  type: "link in",
  z: TAB,
  g,
  name,
  links: [origin],
  x,
  y,
  wires: [[destination]],
});
const exec = (id, g, name, command, x, y, wires) => grouped(g, {
  id,
  type: "exec",
  z: TAB,
  g,
  name,
  command,
  addpay: "",
  append: "",
  useSpawn: "false",
  timer: "15",
  winHide: false,
  oldrc: false,
  x,
  y,
  wires,
});

add({
  id: TAB,
  type: "tab",
  label: "guardiao_memoria_host",
  disabled: false,
  info: "Prioriza a saúde do servidor sem dar privilégios ao Node-RED. A cada minuto solicita ao worker do host uma avaliação fail-closed. Somente uma árvore antiga, desconectada e ociosa do VS Code pode ser encerrada; uma sessão conectada nunca é candidata. A limpeza também funciona depois de fechar a única janela remota.",
  env: [],
});

grouped(groups.request, {
  id: "host_memory_guardian_architecture",
  type: "comment",
  z: TAB,
  g: groups.request,
  name: "A cada 60 s: solicitar análise. Node-RED nunca recebe /proc, sudo, CAP_KILL ou PID namespace do host.",
  info: "O worker roda como usuário comum. Allowlist fechada: apenas árvores antigas e desconectadas de extensionHost do VS Code; idade mínima, RSS mínimo, dois ciclos ociosos e revalidação são obrigatórios. Se houver sessão conectada, somente uma desconectada mais antiga pode ser candidata.",
  x: 720,
  y: 60,
  wires: [],
});
inject(
  "host_memory_guardian_tick",
  groups.request,
  "Verificar a cada 60 s",
  [{ p: "payload" }],
  175,
  140,
  [["host_memory_guardian_prepare_request"]],
  { repeat: "60", once: true, onceDelay: "75" },
);
linkIn(
  "host_memory_guardian_test_request_in",
  groups.request,
  "Receber pedido TESTE",
  "host_memory_guardian_test_request_out",
  "host_memory_guardian_prepare_request",
  170,
  230,
);
fn(
  "host_memory_guardian_prepare_request",
  groups.request,
  "Preparar solicitação",
  "host-memory-guardian-prepare-request.js",
  1,
  410,
  160,
  [["host_memory_guardian_side_effect_guard"]],
);
fn(
  "host_memory_guardian_side_effect_guard",
  groups.request,
  "Separar produção e TESTE",
  "host-memory-guardian-side-effect-guard.js",
  2,
  670,
  160,
  [["host_memory_guardian_request_host"], ["host_memory_guardian_request_test_out"]],
);
exec(
  "host_memory_guardian_request_host",
  groups.request,
  "Solicitar worker do host",
  "/opt/request-host-memory-guardian.sh",
  950,
  120,
  [["host_memory_guardian_request_ack"], ["host_memory_guardian_request_error"], ["host_memory_guardian_request_complete"]],
);
fn(
  "host_memory_guardian_request_ack",
  groups.request,
  "Registrar aceite",
  "host-memory-guardian-request-ack.js",
  1,
  1210,
  100,
  [],
);
inlineFn(
  "host_memory_guardian_request_error",
  groups.request,
  "Falha da ponte",
  "const detail = String(msg.payload ?? 'indisponível').replace(/[\\r\\n]+/g, ' ').slice(0, 240);\nnode.status({ fill: 'red', shape: 'ring', text: 'ponte indisponível' });\nnode.error('host_memory_guardian_bridge_unavailable detail=' + detail);\nreturn null;",
  1210,
  170,
);
inlineFn(
  "host_memory_guardian_request_complete",
  groups.request,
  "Código da solicitação",
  "const code = Number(msg.payload?.code ?? msg.payload ?? -1);\nif (code !== 0) node.status({ fill: 'red', shape: 'ring', text: 'ponte código ' + String(code) });\nreturn null;",
  1210,
  240,
);
linkOut(
  "host_memory_guardian_request_test_out",
  groups.request,
  "TESTE → terminal dry-run",
  "host_memory_guardian_dry_in",
  900,
  240,
);

grouped(groups.result, {
  id: "host_memory_guardian_result_info",
  type: "comment",
  z: TAB,
  g: groups.result,
  name: "Resultado contém apenas estado, memória disponível, PID candidato e quantidade encerrada; nenhum comando ou ambiente é publicado.",
  info: "Falhas entram no observador global. Ações bem-sucedidas geram HOST_MEMORY_GUARDIAN_TERMINATED no log do Node-RED.",
  x: 720,
  y: 400,
  wires: [],
});
inject(
  "host_memory_guardian_result_tick",
  groups.result,
  "Ler resultado a cada 30 s",
  [{ p: "payload" }],
  190,
  480,
  [["host_memory_guardian_read_result"]],
  { repeat: "30", once: true, onceDelay: "90" },
);
exec(
  "host_memory_guardian_read_result",
  groups.result,
  "Ler resultado sanitizado",
  "/opt/read-host-memory-guardian-result.sh",
  445,
  480,
  [["host_memory_guardian_parse_result"], ["host_memory_guardian_result_error"], ["host_memory_guardian_result_complete"]],
);
linkIn(
  "host_memory_guardian_test_result_in",
  groups.result,
  "Receber resultado TESTE",
  "host_memory_guardian_test_result_out",
  "host_memory_guardian_parse_result",
  415,
  580,
);
fn(
  "host_memory_guardian_parse_result",
  groups.result,
  "Normalizar e deduplicar",
  "host-memory-guardian-result.js",
  2,
  720,
  500,
  [[], ["host_memory_guardian_result_test_out"]],
);
inlineFn(
  "host_memory_guardian_result_error",
  groups.result,
  "Falha de leitura",
  "const detail = String(msg.payload ?? 'indisponível').replace(/[\\r\\n]+/g, ' ').slice(0, 240);\nnode.status({ fill: 'red', shape: 'ring', text: 'resultado indisponível' });\nnode.error('host_memory_guardian_result_unavailable detail=' + detail);\nreturn null;",
  930,
  460,
);
inlineFn(
  "host_memory_guardian_result_complete",
  groups.result,
  "Código da leitura",
  "const code = Number(msg.payload?.code ?? msg.payload ?? -1);\nif (code !== 0) node.status({ fill: 'red', shape: 'ring', text: 'leitura código ' + String(code) });\nreturn null;",
  930,
  520,
);
linkOut(
  "host_memory_guardian_result_test_out",
  groups.result,
  "Resultado TESTE → dry-run",
  "host_memory_guardian_dry_in",
  965,
  590,
);

grouped(groups.test, {
  id: "host_memory_guardian_test_instructions",
  type: "comment",
  z: TAB,
  g: groups.test,
  name: "Ordem: reset → pedido → saudável → candidato → encerramento → falha. Todos terminam com dispatched:false e nenhum sinal.",
  info: "O teste atravessa preparação, guard, normalização, dedupe e terminal. O algoritmo do host tem fixtures automatizadas separadas para pressão, conectividade, ociosidade, cooldown e denylist essencial.",
  x: 700,
  y: 740,
  wires: [],
});
inject(
  "host_memory_guardian_test_reset",
  groups.test,
  "TESTE 1: reset",
  [{ p: "_host_memory_guardian_test", v: "true", vt: "bool" }],
  170,
  810,
  [["host_memory_guardian_reset_test"]],
);
fn(
  "host_memory_guardian_reset_test",
  groups.test,
  "Resetar estado sintético",
  "host-memory-guardian-reset-test.js",
  1,
  420,
  810,
  [],
);
inject(
  "host_memory_guardian_test_request",
  groups.test,
  "TESTE 2: solicitar limpeza",
  [{ p: "payload" }, { p: "_host_memory_guardian_test", v: "true", vt: "bool" }],
  190,
  870,
  [["host_memory_guardian_test_request_out"]],
);
linkOut(
  "host_memory_guardian_test_request_out",
  groups.test,
  "Pedido TESTE → guard real",
  "host_memory_guardian_test_request_in",
  470,
  870,
);
const resultProps = (payload) => [
  { p: "payload", v: JSON.stringify(payload), vt: "json" },
  { p: "_host_memory_guardian_test", v: "true", vt: "bool" },
];
inject(
  "host_memory_guardian_test_healthy",
  groups.test,
  "TESTE 3: memória saudável",
  resultProps({ status: "healthy", available_mib: 4096, available_percent: 50, terminated: 0, test_mode: true }),
  190,
  930,
  [["host_memory_guardian_test_result_out"]],
);
inject(
  "host_memory_guardian_test_candidate",
  groups.test,
  "TESTE 4: candidato observado",
  resultProps({ status: "candidate_observed", available_mib: 4096, available_percent: 50, candidate_pid: "synthetic", candidate_mib: 640, terminated: 0, test_mode: true }),
  205,
  990,
  [["host_memory_guardian_test_result_out"]],
);
inject(
  "host_memory_guardian_test_terminated",
  groups.test,
  "TESTE 5: encerramento aprovado",
  resultProps({ status: "terminated", available_mib: 4096, available_percent: 50, candidate_pid: "synthetic", candidate_mib: 640, terminated: 4, test_mode: true }),
  215,
  1050,
  [["host_memory_guardian_test_result_out"]],
);
inject(
  "host_memory_guardian_test_failed",
  groups.test,
  "TESTE 6: falha do worker",
  resultProps({ status: "failed", available_mib: 900, available_percent: 11, terminated: 0, test_mode: true }),
  655,
  930,
  [["host_memory_guardian_test_result_out"]],
);
linkOut(
  "host_memory_guardian_test_result_out",
  groups.test,
  "Resultado TESTE → normalização real",
  "host_memory_guardian_test_result_in",
  650,
  1000,
);
linkIn(
  "host_memory_guardian_dry_in",
  groups.test,
  "Receber efeito TESTE",
  "host_memory_guardian_request_test_out",
  "host_memory_guardian_dry_run_terminal",
  955,
  900,
);
nodes.find((node) => node.id === "host_memory_guardian_dry_in").links.push("host_memory_guardian_result_test_out");
fn(
  "host_memory_guardian_dry_run_terminal",
  groups.test,
  "TESTE FINAL: sinais bloqueados",
  "host-memory-guardian-dry-run.js",
  1,
  1190,
  900,
  [],
);

next.push(...nodes);
fs.writeFileSync(outputPath, `${JSON.stringify(next, null, 4)}\n`);
console.log(`Host memory guardian flow installed in ${outputPath}`);
