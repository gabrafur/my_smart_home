import fs from 'node:fs';

const source = (name) => fs.readFileSync(new URL(`functions/${name}.js`, import.meta.url), 'utf8').trimEnd();

// Add notification-only branches to existing canonical decisions. Existing
// canvases, decisions, device effects and user-selected recipients stay intact.
export function installOperationalAlerts(flows) {
  const byId = new Map(flows.map(node => [node.id, node]));
  for (const [tab, prefix, origin] of [
    ['daily_host_updates_tab', 'operations_daily', 'atualizacoes_diarias'],
    ['host_memory_guardian_tab', 'operations_memory', 'guardiao_memoria_host'],
  ]) {
    if (!byId.has(tab)) continue;
    const groupId = `${prefix}_group`;
    const existing = byId.get(groupId);
    const bottom = Math.max(0, ...flows.filter(n => n.z === tab && n.type === 'group' && n.id !== groupId).map(n => n.y + n.h));
    const x = existing?.x ?? 64, y = existing?.y ?? bottom + 100;
    const members = [];
    const add = (id, type, name, dx, dy, rest = {}) => {
      const desired = { id: `${prefix}_${id}`, type, z: tab, g: groupId, name, x: x + dx, y: y + dy, wires: [], ...rest };
      const current = byId.get(desired.id);
      if (current) {
        const position = { x: current.x, y: current.y };
        Object.assign(current, desired, position);
      } else { flows.push(desired); byId.set(desired.id, desired); }
      members.push(desired.id);
      return desired.id;
    };
    const fn = (id, name, dx, dy, func, outputs, wires) => add(id, 'function', name, dx, dy, { func, outputs, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], wires });
    const reaches = (id, target, seen = new Set()) => {
      if (id === target) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const node = byId.get(id);
      if (!['link in', 'link out'].includes(node?.type)) return false;
      return (node.type === 'link out' ? node.links ?? [] : node.wires?.flat() ?? []).some(next => reaches(next, target, seen));
    };
    const branch = (nodeId, output, target) => {
      const node = byId.get(nodeId);
      if (!node?.wires?.[output]) throw new Error(`Missing operational decision: ${nodeId}/${output}`);
      if (node.type === 'link in') {
        // Fan out the named logical route at its senders, keeping both inputs
        // next to their consumers instead of drawing a cross-canvas wire.
        node.wires[output] = node.wires[output].filter(id => id !== target);
        const endpoint = byId.get(target);
        const input = add(`input_${target}`, 'link in', `Receber ${endpoint.name}`, 80, endpoint.y - y, {
          links: [...node.links], wires: [[target]],
        });
        for (const outId of node.links) {
          const out = byId.get(outId);
          if (!out.links.includes(input)) out.links.push(input);
        }
        return;
      }
      if (!node.wires[output].some(id => reaches(id, target))) node.wires[output].push(target);
    };
    const adapter = `${prefix}_adapt`;
    const entry = (id, label, row, active, reason, message) => add(id, 'change', label, 300, 90 + row * 70, {
      rules: [{ t: 'set', p: 'operational_alert', pt: 'msg', to: JSON.stringify({ source: origin, active, reason, title: origin === 'atualizacoes_diarias' ? 'Atualização exige ação' : 'Memória do servidor exige atenção', message }), tot: 'json' }],
      action: '', property: '', from: '', to: '', reg: false, wires: [[adapter]],
    });
    if (origin === 'atualizacoes_diarias') {
      const hacs = entry('hacs', 'Decisão recebida: auditoria HACS necessária', 0, true, 'hacs_audit_required', 'Uma integração aguarda auditoria antes da atualização.');
      const unknown = entry('unknown', 'Decisão recebida: fonte não classificada', 1, true, 'update_classification_required', 'Uma atualização foi bloqueada e precisa ser classificada.');
      const firmware = entry('firmware', 'Decisão recebida: firmware manual pendente', 2, true, 'firmware_approval_required', 'Um firmware aguarda sua decisão de instalação.');
      const dependency = entry('dependency', 'Decisão recebida: dependência bloqueada', 3, true, 'dependency_policy_blocked', 'Uma dependência vulnerável não pôde ser atualizada automaticamente. Revise o candidato e a política.');
      const resolved = entry('resolved', 'Estado canônico atual: encerrar aviso', 4, false, 'update_current', 'A pendência de atualização foi resolvida.');
      branch('daily_update_hacs_state', 0, hacs);
      branch('daily_update_unknown_in', 0, unknown);
      branch('daily_update_firmware_auto', 1, firmware);
      branch('daily_update_dependency_blocked_in', 0, dependency);
      branch('daily_update_inventory_state', 2, resolved);
      branch('daily_update_dependency_parse_result', 1, resolved);
    } else {
      const pressure = entry('pressure', 'Pressão sem ação segura: pedir intervenção', 0, true, 'memory_pressure', 'A memória está sob pressão e o guardião não encontrou uma ação segura. Revise as sessões e processos em uso.');
      const resolved = entry('resolved', 'Saudável ou recuperado: encerrar aviso', 2, false, 'memory_recovered', 'A pressão de memória foi resolvida.');
      const pressureInput = add('pressure_accepted_in', 'link in', 'Receber pressão que exige ação', 80, 90, {
        links: [`${prefix}_pressure_accepted_out`], wires: [[pressure]],
      });
      const pressureOutput = add('pressure_accepted_out', 'link out', 'Pressão confirmada → aviso', 520, 300, {
        mode: 'link', links: [pressureInput],
      });
      const classify = add('pressure_gate', 'switch', 'Pressão exige intervenção humana?', 300, 300, {
        property: 'payload.status', propertyType: 'msg', rules: ['pressure_no_safe_duplicate', 'pressure_no_safe_candidate', 'candidate_active'].map(v => ({ t: 'eq', v, vt: 'str' })), checkall: 'false', repair: false, outputs: 3,
        wires: [[pressureOutput], [pressureOutput], [pressureOutput]],
      });
      branch('host_memory_guardian_status_switch', 6, classify);
      for (const output of [2, 3, 4]) branch('host_memory_guardian_status_switch', output, resolved);
    }
    fn('adapt', 'Normalizar decisão e isolar TESTE', 690, 160, source('operational-alert-adapt'), 1, [[`${prefix}_lifecycle`]]);
    fn('lifecycle', 'Deduplicar incidente; persistir produção', 1080, 160, source('operational-alert-lifecycle'), 1, [[`${prefix}_alert_out`]]);
    add('alert_out', 'link out', 'Ação necessária → HA + celular principal', 1430, 160, { mode: 'link', links: ['global_observer_alert_to_dispatch_in'] });
    fn('reset', 'TESTE: limpar somente incidentes sintéticos', 1080, 360, 'flow.set("operational_action_alerts_v1__test", undefined); return null;', 0, []);
    add('test_reset', 'inject', 'TESTE 0: reset dos avisos', 690, 360, { props: [{ p: 'payload' }], payload: '', payloadType: 'date', repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: '', wires: [[`${prefix}_reset`]] });
    if (origin === 'guardiao_memoria_host') {
      add('test_pressure', 'inject', 'TESTE: pressão sem ação segura', 300, 430, {
        props: [{ p: '_host_memory_guardian_test', v: 'true', vt: 'bool' }, { p: 'payload', v: JSON.stringify({ status: 'pressure_no_safe_candidate', request_id: 'synthetic-pressure', checked_at: '2026-01-01T00:00:00Z', test_mode: true }), vt: 'json' }],
        payload: '', payloadType: 'date', repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: '', wires: [['host_memory_guardian_result_in']],
      });
    }
    add('instructions', 'comment', 'TESTE: reset → cenário manual do canvas → repetir → recuperação; conferir dry-run global', 760, 460, {
      info: 'Somente falhas e ações necessárias. Produção: HA persistente + resident_primary. Repetição e restart não reenviam o mesmo incidente; recuperação apenas remove o aviso. Testes usam memória separada e o terminal global simulated:true/dispatched:false.',
    });
    const desiredGroup = { id: groupId, type: 'group', z: tab, name: 'NOTIFICAÇÕES: ações necessárias, dedupe e recuperação', style: { label: true, color: '#d97706' }, nodes: members, x, y, w: 1580, h: 520 };
    if (existing) {
      existing.nodes = [...new Set([...existing.nodes, ...members])];
    } else { flows.push(desiredGroup); byId.set(groupId, desiredGroup); }
  }
  return flows;
}
