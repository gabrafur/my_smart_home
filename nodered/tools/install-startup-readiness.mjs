import fs from 'node:fs';
import {reconcileGeneratedFlows} from './reconcile-generated-flows.mjs';
import { routeCanvasWires, restoreGeneratedWireRoutes } from './install-notification-hubs.mjs';
const source = file => fs.readFileSync(new URL('./functions/' + file, import.meta.url), 'utf8').trimEnd();
export const STARTUP_GUARDS = [
  ['daily_update_inventory_schedule', 'Inventário após retomada'],
  ['daily_update_inventory_apply_schedule', 'Updates após retomada'],
  ['weekly_docs_review_schedule', 'Revisão após retomada'],
  ['git_backup_schedule', 'Backup após retomada'],
  ['vehicle_visual_refresh_command_in', 'Refresh após retomada'],
  ['tuya_cycle', 'Tuya após retomada'],
  ['local_ai_rtx_tick', 'Sonda RTX após retomada'],
  ['codex_alert_daily', 'Resumo após retomada'],
];
export const STARTUP_TAB = 'startup_readiness_tab';
export const STARTUP_SUBFLOW = 'startup_readiness_gate';
export function installStartupReadiness(input) {
  const selected = new Set(STARTUP_GUARDS.map(([id]) => input.find(n => n.id === id)?.z));
  selected.add(STARTUP_TAB); selected.add(STARTUP_SUBFLOW); selected.add('weekly_docs_review_tab');
  const part = restoreGeneratedWireRoutes(structuredClone(input.filter(n => selected.has(n.z))));
  const flows = [...structuredClone(input.filter(n => !selected.has(n.z))), ...part];
  const old = new Map(flows.map(n => [n.id, n]));
  const owned = n => !n.id.startsWith('global_observer_coverage__') && (n.id === STARTUP_TAB || n.z === STARTUP_TAB || n.id === STARTUP_SUBFLOW || n.z === STARTUP_SUBFLOW || n.startup_managed === true);
  const next = flows.filter(n => !owned(n));
  const nodes = [];
  const add = n => { nodes.push(n); return n; };
  const group = (id,z,name,x,y,w,h) => add({id,type:'group',z,name,style:{label:true,fill:'#ccfbf1','fill-opacity':'0.35',stroke:'#0f766e'},nodes:[],x,y,w,h});
  const put = (g,n) => {g.nodes.push(n.id);return add({...n,z:g.z,g:g.id});};
  const fn = (g,id,name,file,x,y,wires,extra={}) => put(g,{id,type:'function',name,func:source(file),outputs:wires.length,timeout:0,noerr:0,initialize:'',finalize:'',libs:['startup-readiness-observe.js','startup-readiness-facts.js','startup-gate-buffer.js'].includes(file) ? [{var:'os',module:'os'}] : [],x,y,wires,...extra});
  const sw = (g,id,name,property,x,y,wires,rules=[{t:'true'},{t:'else'}]) => put(g,{id,type:'switch',name,property,propertyType:'jsonata',rules,checkall:'true',repair:false,outputs:rules.length,x,y,wires});
  const ch = (g,id,name,rules,x,y,wires) => put(g,{id,type:'change',name,rules,x,y,wires});
  const set = (p,to,tot='str',pt='msg') => ({t:'set',p,pt,to,tot});
  const inject = (g,id,name,props,x,y,wires,extra={}) => put(g,{id,type:'inject',name,props,repeat:'',crontab:'',once:false,onceDelay:1,topic:'',x,y,wires,...extra});
  add({id:STARTUP_TAB,type:'tab',label:'retomada_servicos',disabled:false,info:'Internet e VPN canônicas, sem retained positivo, antes de liberar tarefas externas. Monitores e proteções locais iniciam independentemente. Testes sempre dry-run.',env:[]});
  const g = group('startup_control_group',STARTUP_TAB,'1. Retomada: política, fontes e decisão canônica',64,40,3000,680);
  const tests = group('startup_test_group',STARTUP_TAB,'2. TESTE: reset → internet → VPN → estabilidade → queda',64,760,2500,360);
  const defaults = {boot_grace_s:180,connection_stable_s:120,source_fresh_s:120,release_spacing_s:10,pending_ttl_s:1800};
  inject(g,'startup_policy_default','CONFIG: 180 s boot; 120 s conexões; liberar a cada 10 s',[{p:'payload',v:JSON.stringify(defaults),vt:'json'}],380,110,[['startup_policy_validate']],{once:true,onceDelay:0.1});
  fn(g,'startup_policy_validate','Validar unidades e limites','startup-readiness-policy.js',840,110,[['startup_policy_valid']]);
  sw(g,'startup_policy_valid','Política válida?', 'policy_valid',1120,110,[['startup_policy_store'],[]]);
  ch(g,'startup_policy_store','Guardar última política válida',[set('startup_policy_v1','policy_candidate','msg','flow'),set('#:(persistent)::startup_policy_v1','policy_candidate','msg','flow'),set('#:(memoryOnly)::startup_policy_v1','policy_candidate','msg','global')],1400,110,[]);
  for(const [id,topic,kind,y] of [
    ['startup_internet','nodered/infrastructure/internet/state','internet',230],
    ['startup_vpn','nodered/infrastructure/vpn/vpn_primary/state','vpn',300]
  ]) {
    put(g,{id,type:'mqtt in',name:'FONTE canônica: '+kind,topic,qos:'1',datatype:'utf8',broker:'721c47f31046b8bc',nl:false,rap:true,rh:0,inputs:0,x:270,y,wires:[[id+'_tag']]});
    ch(g,id+'_tag','Identificar '+kind,[set('startup_source',kind)],580,y,[['startup_observe']]);
  }
  put(g,{id:'startup_mqtt_status',type:'status',name:'MQTT: invalidar observações ao reconectar',scope:['startup_internet','startup_vpn'],x:330,y:370,wires:[['startup_observe']]});
  fn(g,'startup_observe','Guardar fatos recebidos neste runtime','startup-readiness-observe.js',960,280,[['startup_facts']]);
  inject(g,'startup_tick','Reavaliar frescor e estabilidade — 10 s',[{p:'payload'}],350,440,[['startup_facts']],{repeat:'10',once:true,onceDelay:1});
  fn(g,'startup_facts','Ler idades e estados canônicos','startup-readiness-facts.js',1260,280,[['startup_internet_online']],{initialize:'flow.set("startup_lifecycle_v1", {boot_at: os.uptime() * 1000, stable_since: null}, "memoryOnly"); flow.set("startup_observations_v1", {}, "memoryOnly"); global.set("startup_readiness_v1", {ready:false, reason:"starting"}, "memoryOnly");'});
  sw(g,'startup_internet_online','Internet confirmada online?', 'startup.internet_state = "online"',1570,240,[['startup_vpn_online'],['startup_wait_internet']]);
  sw(g,'startup_vpn_online','VPN confirmada online?', 'startup.vpn_state = "online"',1570,320,[['startup_stable'],['startup_wait_vpn']]);
  sw(g,'startup_stable','Boot ≥ 180 s e ambas estáveis ≥ 120 s?', 'startup.boot_age_ms >= startup.policy.boot_grace_s * 1000 and startup.stable_age_ms >= startup.policy.connection_stable_s * 1000',1580,410,[['startup_ready'],['startup_wait_stability']]);
  for(const [id,decision,y] of [['startup_wait_internet','waiting_internet',220],['startup_wait_vpn','waiting_vpn',290],['startup_ready','ready',360],['startup_wait_stability','stabilizing',430]]) ch(g,id,decision,[set('startup_decision',decision)],1960,y,[['startup_mutate']]);
  fn(g,'startup_mutate','Atualizar lifecycle da retomada','startup-readiness-mutate.js',2240,310,[['startup_test_gate']]);
  sw(g,'startup_test_gate','TESTE sem publicação?', 'startup.test_mode = true',2510,310,[['startup_dry'],['startup_publish']]);
  fn(g,'startup_publish','Publicar contrato global de prontidão','startup-readiness-publish.js',2750,390,[['startup_mqtt']]);
  put(g,{id:'startup_mqtt',type:'mqtt out',name:'Estado canônico da retomada',topic:'',qos:'1',retain:'true',broker:'721c47f31046b8bc',x:2780,y:480,wires:[]});
  fn(tests,'startup_dry','TESTE FINAL: sem efeito','startup-dry-run.js',2170,840,[]);
  inject(tests,'startup_test_reset','TESTE 0: reset',[{p:'_startup_test',v:'true',vt:'bool'}],270,830,[['startup_reset']]);
  put(tests,{id:'startup_reset',type:'function',name:'Reset somente memória TESTE',func:'flow.set("startup_observations_v1__test", {}, "memoryOnly"); flow.set("startup_lifecycle_v1__test", {boot_at: 1000000, stable_since:null}, "memoryOnly"); return null;',outputs:0,initialize:'',finalize:'',x:610,y:830,wires:[]});
  for(const [id,kind,state,at,x,y] of [
    ['internet','internet','online',1060000,300,900],['vpn','vpn','online',1060000,720,900],
    ['refresh_internet','internet','online',1180000,1150,900],['refresh_vpn','vpn','online',1180000,1570,900],
    ['offline','internet','offline',1190000,300,980],['unknown','vpn','unknown',1200000,720,980],
  ]) inject(tests,'startup_test_'+id,'TESTE: '+kind+' '+state,[{p:'_startup_test',v:'true',vt:'bool'},{p:'startup_source',v:kind,vt:'str'},{p:'payload',v:state,vt:'str'},{p:'startup_now',v:String(at),vt:'num'}],x,y,[['startup_observe']]);
  put(tests,{id:'startup_test_note',type:'comment',name:'Reset → online internet/VPN → renovar ambas em +120 s → offline/unknown. Repetir não duplica liberação.',info:'Retained online nunca libera. Testes automatizados cobrem restart, expiração, dedupe e fronteiras sem side effects.',x:1220,y:1060,wires:[]});
  // Reusable gate: a single pending intent per caller; release re-enters its original decisions.
  add({id:STARTUP_SUBFLOW,type:'subflow',name:'Aguardar internet e VPN estáveis',info:'Fila volátil de uma intenção, coalescida. Não usar para comandos de dispositivos ou decisões já autorizadas. Revalida negócio após liberar.',category:'',in:[{x:30,y:100,wires:[{id:'startup_gate_buffer'}]}],out:[{x:1740,y:160,wires:[{id:'startup_gate_release',port:0}]}],env:[{name:'STARTUP_ORDER',type:'num',value:'0'}],color:'#99d6c9'});
  const gate = group('startup_gate_group',STARTUP_SUBFLOW,'Gate de tarefa externa: última intenção, validade e liberação espaçada',64,30,1600,420);
  fn(gate,'startup_gate_buffer','Coalescer intenção e ler prontidão','startup-gate-buffer.js',290,100,[['startup_gate_pending']]);
  inject(gate,'startup_gate_tick','Reavaliar pendência — 5 s',[{p:'_startup_tick',v:'true',vt:'bool'}],290,190,[['startup_gate_buffer']],{repeat:'5'});
  sw(gate,'startup_gate_pending','Existe intenção e política?', '$exists(pending) and $exists(policy)',590,100,[['startup_gate_expired'],[]]);
  sw(gate,'startup_gate_expired','Intenção venceu 30 min?', 'startup_now - pending.created_at >= policy.pending_ttl_s * 1000',900,100,[['startup_gate_drop'],['startup_gate_ready']]);
  fn(gate,'startup_gate_drop','Descartar intenção vencida','startup-gate-consume.js',1220,80,[]);
  sw(gate,'startup_gate_ready','Pronto e chegou a vez desta tarefa?', 'readiness.ready = true and startup_now >= readiness.ready_since + startup_order * policy.release_spacing_s * 1000',930,190,[['startup_gate_consume'],[]]);
  fn(gate,'startup_gate_consume','Consumir versão atual da intenção','startup-gate-consume.js',940,330,[['startup_gate_test']]);
  sw(gate,'startup_gate_test','TESTE: somente dry-run?', '_startup_test = true',1230,190,[['startup_gate_dry'],['startup_gate_release']]);
  fn(gate,'startup_gate_release','Consumir intenção uma vez','startup-gate-release.js',1480,160,[[]]);
  fn(gate,'startup_gate_dry','TESTE FINAL: tarefa simulada','startup-dry-run.js',1470,260,[]);
  const guardedTabs = new Set();
  for(const [order,[id,label]] of STARTUP_GUARDS.entries()) {
    const caller = next.find(n=>n.id===id);
    if(!caller) throw new Error('Startup caller missing: '+id);
    const gateId='startup_caller_'+id;
    const prior=old.get(gateId);
    const original=prior && (caller.wires?.[0]?.[0]===gateId || caller.wires?.[0]?.[0]==='startup_source_'+id) ? prior.wires : caller.wires;
    const members=next.filter(n=>n.z===caller.z&&n.type==='group');
    let cg=nodes.find(n=>n.id==='startup_callers_'+caller.z);
    if(!cg){const bottom=Math.max(0,...members.map(n=>n.y+n.h));cg=group('startup_callers_'+caller.z,caller.z,'Retomada: tarefas externas aguardam internet + VPN',64,bottom+80,1700,160);cg.startup_managed=true;const savedGroup=old.get(cg.id);if(savedGroup)for(const k of ['x','y','w','h'])cg[k]=savedGroup[k];}
    const index=cg.nodes.length;
    const n=put(cg,{id:gateId,type:'subflow:'+STARTUP_SUBFLOW,name:label,env:[{name:'STARTUP_ORDER',value:String(order),type:'num'}],x:350+index*600,y:cg.y+85,wires:original,startup_managed:true,startup_original_wires:original});
    const saved=prior; if(saved){n.x=saved.x;n.y=saved.y;}
    caller.wires=[[gateId]];
    if(caller.type==='link in') {
      const outId='startup_source_'+id, inId='startup_destination_'+id;
      const owner=next.find(n=>n.id===caller.g);owner.nodes=owner.nodes.filter(x=>x!==outId);owner.nodes.push(outId);
      add({id:outId,type:'link out',z:caller.z,g:caller.g,name:'Comando → aguardar conexões',mode:'link',links:[inId],x:caller.x+40,y:caller.y,wires:[],startup_managed:true});
      put(cg,{id:inId,type:'link in',name:'Intenção externa após normalização',links:[outId],x:n.x-220,y:n.y,wires:[[gateId]],startup_managed:true});
      caller.wires=[[outId]];
    }
    guardedTabs.add(caller.z);
  }
  // Confirm worker unavailability before opening its persistent lifecycle.
  const workerTab = 'weekly_docs_review_tab';
  const worker = group('startup_worker_group', workerTab, 'Retomada do worker: confirmar indisponibilidade por 60 s',64,1200,2300,260);
  worker.startup_managed = true;
  for(const id of ['weekly_docs_review_status_watch','weekly_docs_review_test_worker_status_in']) next.find(n=>n.id===id).wires=[['startup_worker_identity']];
  const testEntry=next.find(n=>n.id==='weekly_docs_review_test_worker_status_in');
  const testOwner=next.find(n=>n.id===testEntry.g);
  testOwner.nodes=testOwner.nodes.filter(id=>id!=='startup_worker_test_out');testOwner.nodes.push('startup_worker_test_out');
  testEntry.wires=[['startup_worker_test_out']];
  add({id:'startup_worker_test_out',type:'link out',z:testEntry.z,g:testEntry.g,name:'TESTE → confirmação do worker',mode:'link',links:['startup_worker_test_in'],x:435,y:410,wires:[],startup_managed:true});
  put(worker,{id:'startup_worker_test_in',type:'link in',name:'Receber TESTE do worker',links:['startup_worker_test_out'],x:110,y:1350,wires:[['startup_worker_identity']]});
  put(worker,{id:'startup_worker_identity' ,type:'function',name:'Separar produção e TESTE',func:'msg.topic = msg._weekly_docs_test === true ? "test" : "production"; return msg;',outputs:1,initialize:'',finalize:'',x:310,y:1280,wires:[['startup_worker_unavailable']],startup_managed:true});
  sw(worker,'startup_worker_unavailable','Indisponível ou parado?', 'payload in ["indisponível", "unavailable", "parado"]',650,1280,[['startup_worker_confirm'],['startup_worker_cancel']]);
  ch(worker,'startup_worker_cancel','Cancelar espera ao mudar estado',[set('reset','true','bool')],1000,1350,[['startup_worker_confirm','startup_worker_restore']]);
  ch(worker,'startup_worker_restore','Repassar falha/recuperação atual',[{t:'delete',p:'reset',pt:'msg'}],1370,1350,[['startup_worker_return_out']]);
  put(worker,{id:'startup_worker_confirm',type:'trigger',name:'POLÍTICA: indisponível contínuo 60 s',op1:'',op1type:'nul',op2:'',op2type:'pay',duration:'60',units:'s',extend:false,overrideDelay:false,bytopic:'topic',topic:'topic',reset:'',outputs:1,x:1070,y:1250,wires:[['startup_worker_return_out']]});
  put(worker,{id:'startup_worker_return_out',type:'link out',name:'Estado confirmado → lifecycle',mode:'link',links:['startup_worker_return_in'],x:1680,y:1280,wires:[]});
  const track=next.find(n=>n.id==='weekly_docs_review_track_status');
  const owner=next.find(n=>n.id===track.g);
  owner.nodes=owner.nodes.filter(id=>id!=='startup_worker_return_in');owner.nodes.push('startup_worker_return_in');
  add({id:'startup_worker_return_in',type:'link in',z:track.z,g:track.g,name:'Worker confirmado',links:['startup_worker_return_out'],x:track.x-170,y:track.y-30,wires:[[track.id]],startup_managed:true});
  for(const n of nodes.filter(n=>n.g===worker.id))n.startup_managed=true;
  guardedTabs.add(workerTab);
  next.push(...nodes);
  const routed = routeCanvasWires(next,[STARTUP_TAB,STARTUP_SUBFLOW,...guardedTabs]);
  const reconciled = reconcileGeneratedFlows(input, routed, {isOwned: n => owned(n) || selected.has(n.z), preserveLayout:false});
  for(const g of reconciled.filter(n=>n.type==='group')) {
    const members=reconciled.filter(n=>n.g===g.id).map(n=>n.id);
    g.nodes=[...(g.nodes||[]).filter(id=>members.includes(id)),...members.filter(id=>!(g.nodes||[]).includes(id))];
    if(g.startup_managed || [STARTUP_TAB,STARTUP_SUBFLOW].includes(g.z))g.nodes.sort();
  }
  return reconciled;
}
