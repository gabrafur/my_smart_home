import fs from 'node:fs';
import {withHostTimingSource} from './host-observation-timing.mjs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {reconcileGeneratedFlows} from './reconcile-generated-flows.mjs';

export const TAB = 'host_observer_tab';
export const POLICY = {max_report_age_ms: 30000, max_resource_age_ms: 45000,
  event_confirm_ms: 5000, resource_confirm_ms: 20000, observation_confirm_ms: 20000,
  cpu_busy_percent: 90, memory_available_mib: 512, disk_used_percent: 85,
  inodes_used_percent: 85, temperature_celsius: 80};
const source = file => withHostTimingSource(fs.readFileSync(new URL(`functions/host-observer-${file}.js`, import.meta.url), 'utf8').trimEnd());

export function installHostObserver(flows) {
  const owned = n => n.id === TAB || n.z === TAB && !n.id.startsWith('global_observer_coverage__');
  const nodes = [{id: TAB, type: 'tab', label: 'observacao_host', disabled: flows.find(n => n.id === TAB)?.disabled === true,
    info: 'Fatos sanitizados do produtor root → validação → decisões visuais → incidentes persistentes → canal global. Sem reparos/dispositivos neste canvas. Cobertura de streams parcial; start de container não comprova prontidão.', env: []}];
  const add = n => {nodes.push(n); if(n.g) nodes.find(g=>g.id===n.g).nodes.push(n.id); return n.id;};
  const group = (id, name, x, y, w, h) => add({id:`host_obs_${id}`,type:'group',z:TAB,name,
    style:{label:true,color:'#2563eb'},nodes:[],x,y,w,h});
  const g = {policy:group('policy_group','0. Política visual: unidades, padrões e limites',64,40,980,320),
    timing:group('timing_group','0b. Medição passiva: contratos, contadores e relógios',1100,40,1840,320),
    input:group('input_group','1. Fonte fixa, validade e falhas de observação',64,400,1880,460),
    decision:group('decision_group','2. Classificação visual e lifecycle (produção / TESTE)',64,900,2940,620),
    test:group('test_group','3. Replay manual completo: somente dry-run',64,1560,1880,380)};
  const node = (id,type,group,name,x,y,rest={}) => add({id:`host_obs_${id}`,type,z:TAB,g:group,name,x,y,wires:[],...rest});
  const fn = (id,group,name,file,x,y,wires,outputs=1) => node(id,'function',group,name,x,y,{func:source(file),outputs,timeout:0,noerr:0,initialize:'',finalize:'',libs:[],wires});
  const inject = (id,group,name,payload,x,y,target,extra={}) => node(id,'inject',group,name,x,y,{props:[{p:'payload',v:payload,vt:'str'}],repeat:'',crontab:'',once:false,onceDelay:.1,topic:'',payload,payloadType:'str',wires:[[target]],...extra});
  const change = (id,group,name,property,value,kind,x,y,target) => node(id,'change',group,name,x,y,{rules:[{t:'set',p:property,pt:'msg',to:value,tot:kind}],action:'',property:'',from:'',to:'',reg:false,wires:[[target]]});
  const sw = (id,group,name,property,rules,x,y,wires) => node(id,'switch',group,name,x,y,{property,propertyType:'msg',rules,checkall:'false',repair:false,outputs:rules.length,wires});
  const out = (id,group,name,targets,x,y) => node(id,'link out',group,name,x,y,{mode:'link',links:targets});
  const input = (id,group,name,origins,target,x,y) => node(id,'link in',group,name,x,y,{links:origins,wires:[[target]]});
  node('policy_info','comment',g.policy,'Padrões: leitura 2s; relatório 30s; recursos 45s; confirmar evento 5s / recurso 20s / observação 20s',540,90,{info:'Parâmetros JSON editáveis no nó Política. Validade relatório10–60s e recurso20–60s; confirmação evento1–60s,recurso20–120s,observação10–120s; CPU50–100%,memória128–2048MiB,disco/inodes70–95%,temperatura60–90°C. Inválidos não substituem última política. Recursos exigem duas amostras distintas; transient/unknown não prova recuperação. Confirmação é política, não latência medida.'});
  inject('policy_tick',g.policy,'Carregar política ao iniciar','',260,180,'host_obs_policy_config',{once:true,onceDelay:'0.2'});
  change('policy_config',g.policy,'POLÍTICA: padrões e limites explícitos','payload',JSON.stringify(POLICY),'json',600,180,'host_obs_policy_store');
  fn('policy_store',g.policy,'Validar sem perder última política','policy',600,280,[],0);
  node('timing_info','comment',g.timing,'Medição: evento ≤ 10.000 ms; recurso ≤ 60.000 ms; nenhum efeito residencial',2010,90,{info:'Parâmetros exclusivos da evidência de desempenho. Padrões evento10000ms/recurso60000ms; limites1000–60000ms/20000–120000ms. Valor inválido preserva o último contrato. Não altera confirmação,dedupe ou dispositivos. Âncoras horárias limitadas e contadores persistentes mantêm perdas/unknown; timestamps históricos não são inventados. Relógio monotônico do canvas via builtin perf_hooks; margens de alinhamento explícitas no contrato.'});
  inject('timing_policy_tick',g.timing,'Carregar contrato de medição','',1320,180,'host_obs_timing_policy_config',{once:true,onceDelay:'0.25'});
  change('timing_policy_config',g.timing,'Medição: limites em ms','payload',JSON.stringify({event_latency_ms:10000,resource_latency_ms:60000}),'json',1640,180,'host_obs_timing_policy_store');
  fn('timing_policy_store',g.timing,'Validar; preservar último contrato','timing-policy',1990,180,[],0);
  input('timing_frame_in',g.timing,'Receber toda leitura',['host_obs_timing_frame_out'],'host_obs_timing_account',2210,250);
  fn('timing_account',g.timing,'Contabilizar cada fato sem decisões residenciais','timing',2500,250,[['host_obs_timing_return_out']]);
  nodes.find(n=>n.id==='host_obs_timing_account').libs=[{var:'timingClock',module:'perf_hooks'}];
  out('timing_return_out',g.timing,'Retornar para os gates existentes',['host_obs_timing_return_in'],2790,250);
  inject('tick',g.input,'FONTE: ler a cada 2s','',270,480,'host_obs_read',{repeat:'2',once:true,onceDelay:'12'});
  node('read','exec',g.input,'Ler somente relatório root (limite 3s)',610,480,{command:'/usr/local/bin/node --max-old-space-size=32 /data/tools/read-host-observation.mjs',addpay:'',append:'',useSpawn:'false',timer:'3',winHide:false,oldrc:false,wires:[['host_obs_normalize'],[],['host_obs_read_complete']]});
  fn('read_complete',g.input,'Falha do leitor → observação desconhecida','read-completion',410,790,[['host_obs_normalize']]);
  input('test_frame_in',g.input,'TESTE → mesmo contrato',['host_obs_test_frame_out'],'host_obs_normalize',800,570);
  fn('normalize',g.input,'Adaptar estrutura e calcular idades','normalize',970,480,[['host_obs_timing_frame_out']]);
  out('timing_frame_out',g.input,'Leitura → medição passiva',['host_obs_timing_frame_in'],1100,540);
  input('timing_return_in',g.input,'Receber sem mudar os gates',['host_obs_timing_return_out'],'host_obs_valid',1140,430);
  sw('valid',g.input,'Estrutura e relógio válidos?','_host_report_valid',[{t:'true'},{t:'else'}],1290,480,[['host_obs_fresh'],['host_obs_report_unknown_out']]);
  sw('fresh',g.input,'Relatório dentro da validade visual?','_host_report_age_ms',[{t:'lte',v:'_host_policy.max_report_age_ms',vt:'msg'},{t:'else'}],1650,480,[['host_obs_resource_age'],['host_obs_report_unknown_out']]);
  out('report_unknown_out',g.input,'Relatório ausente/stale → observação desconhecida',['host_obs_report_unknown_in'],1850,560);
  sw('resource_age',g.input,'Idade dos recursos disponível?','_host_resource_age_ms',[{t:'null'},{t:'else'}],980,670,[['host_obs_resource_stale'],['host_obs_resource_fresh_gate']]);
  sw('resource_fresh_gate',g.input,'Recursos dentro da validade visual?','_host_resource_age_ms',[{t:'lte',v:'_host_policy.max_resource_age_ms',vt:'msg'},{t:'else'}],1310,670,[['host_obs_resource_fresh'],['host_obs_resource_stale']]);
  change('resource_fresh',g.input,'Recursos atuais','_host_resources_fresh','true','bool',1650,650,'host_obs_facts_out');
  change('resource_stale',g.input,'Recursos desconhecidos','_host_resources_fresh','false','bool',1650,760,'host_obs_facts_out');
  out('facts_out',g.input,'Frame válido → fatos normalizados',['host_obs_facts_in'],1860,720);
  input('facts_in',g.decision,'Receber frame válido',['host_obs_facts_out'],'host_obs_facts',100,990);
  fn('facts',g.decision,'Cursor, baseline e projeção sanitizada','facts',410,990,[['host_obs_kind']]);
  input('report_unknown_in',g.decision,'Receber falha de observação',['host_obs_report_unknown_out'],'host_obs_report_unknown',100,1440);
  change('report_unknown',g.decision,'Falha somente na observação do relatório','_host_fact',JSON.stringify({kind:'observation',name:'report',state:'unknown'}),'json',430,1440,'host_obs_observation');
  sw('kind',g.decision,'Classe do fato observado','_host_fact.kind',['native','resource','observation'].map(v=>({t:'eq',v,vt:'str'})),770,990,[['host_obs_native'],['host_obs_value_known'],['host_obs_observation']]);
  sw('native',g.decision,'Transição autoritativa observada','_host_fact.action',[
    {t:'regex',v:'^(failed|die|destroy|health_status: unhealthy|oom_increment)$',vt:'str',case:false},
    {t:'regex',v:'^(started|health_status: healthy)$',vt:'str',case:false},{t:'else'}],1130,990,
    [['host_obs_failed_in'],['host_obs_healthy_in'],['host_obs_unknown_in']]);
  sw('observation',g.decision,'Fonte conectada? Ausência é falha de observação','_host_fact.state',[{t:'eq',v:'connected',vt:'str'},{t:'else'}],1130,1430,[['host_obs_healthy_in'],['host_obs_failed_in']]);
  sw('value_known',g.decision,'Métrica tem leitura válida?','_host_fact.value',[{t:'null'},{t:'else'}],1110,1110,[['host_obs_unknown_in'],['host_obs_metric']]);
  sw('metric',g.decision,'Métrica do recurso','_host_fact.name',['cpu','memory','disk','inodes','temperature'].map(v=>({t:'eq',v,vt:'str'})),1470,1130,
    ['cpu','memory','disk','inodes','temperature'].map(id=>[`host_obs_threshold_${id}`]));
  const metrics=[['cpu','CPU ocupada ≥ limite %','gte','cpu_busy_percent'],['memory','Memória disponível ≤ limite MiB','lte','memory_available_mib'],['disk','Disco usado ≥ limite %','gte','disk_used_percent'],['inodes','Inodes usados ≥ limite %','gte','inodes_used_percent'],['temperature','Temperatura ≥ limite °C','gte','temperature_celsius']];
  for(const [i,[id,name,t,policy]]of metrics.entries())sw(`threshold_${id}`,g.decision,name,'_host_fact.value',[{t,v:`_host_policy.${policy}`,vt:'msg'},{t:'else'}],1840,1010+i*90,[['host_obs_failed_in'],['host_obs_healthy_in']]);
  // Link routes keep every decision local; no wires over other decision rows.
  for(const [id,signal,y]of [['failed','failed',1030],['healthy','healthy',1170],['unknown','unknown',1310]]){
    input(`${id}_in`,g.decision,`${signal} → lifecycle`,[],`host_obs_${id}_set`,2160,y);
    change(`${id}_set`,g.decision,`Marcar ${signal}`,'_host_signal',signal,'str',2370,y,'host_obs_lifecycle');
  }
  fn('lifecycle',g.decision,'Incidente, confirmação e dedupe persistentes','lifecycle',2720,1170,[['host_obs_alert_out']]);
  out('alert_out',g.decision,'Decisão → gate global produção / dry-run',['global_observer_alert_to_dispatch_in'],2940,1170);
  node('test_info','comment',g.test,'TESTE: reset → saudável (baseline) → falha → confirmar → repetir → saudável; conferir dry-run global',900,1610,{info:'Todos os cenários percorrem normalização,validade,decisões visuais e lifecycle até global_observer_dispatch_guard. Somente estado __test;sem exec,HA,MQTT,notificações ou dispositivos. source_failure e relatório stale não provam falha física; healthy encerra apenas evidência esperada. Resource_high exige nova amostra no confirmar. Start de container não encerra incidente de prontidão.'});
  for(const [i,[id,name]]of [['reset','0 reset'],['healthy','1 saudável'],['failure','2 falha'],['confirm','3 confirmar +25s'],['resource_high','4 CPU alta'],['source_failure','5 fonte ausente'],['stale','6 relatório antigo'],['malformed','7 inválido']].entries()) {
    inject(`test_${id}`,g.test,`TESTE ${name}`,id,260+(i%4)*370,1700+Math.floor(i/4)*90,'host_obs_test_build',{props:[{p:'payload',v:id,vt:'str'},{p:'_host_observer_test',v:'true',vt:'bool'}]});
  }
  fn('test_build',g.test,'Construir somente frame sintético','test-build',1580,1830,[['host_obs_test_frame_out']]);
  out('test_frame_out',g.test,'Replay → fonte normalizada',['host_obs_test_frame_in'],1860,1830);
  // Convert cross-row direct decision wires to named pairs before layout validation.
  const decisionTargets=['host_obs_failed_in','host_obs_healthy_in','host_obs_unknown_in'];
  for(const n of [...nodes]) if(n.type==='switch')for(const [output,wire]of n.wires.entries()) {
    for(const target of [...wire]) if(decisionTargets.includes(target)) {
      const id=`${n.id}_route_${output}`;
      add({id,type:'link out',z:TAB,g:n.g,name:`${n.name} → ${target.replace('host_obs_','')}`,mode:'link',links:[target],x:n.x+180,y:n.y+output*40-20,wires:[]});
      n.wires[output]=wire.map(to=>to===target?id:to);
      nodes.find(row=>row.id===target).links.push(id);
    }
  }
  const result=reconcileGeneratedFlows(flows,[...flows.filter(n=>!owned(n)),...nodes],{isOwned:owned});
  const dispatch=result.find(n=>n.id==='global_observer_alert_to_dispatch_in');
  if(dispatch&&!dispatch.links.includes('host_obs_alert_out'))dispatch.links.push('host_obs_alert_out');
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2]??fileURLToPath(new URL('../flows.json',import.meta.url));
  fs.writeFileSync(file,JSON.stringify(installHostObserver(JSON.parse(fs.readFileSync(file,'utf8'))),null,4)+'\n');
}
