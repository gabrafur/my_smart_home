import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {reconcileGeneratedFlows} from './reconcile-generated-flows.mjs';
import {routeCanvasWires} from './install-notification-hubs.mjs';
export const TAB='mqtt_native_observer_tab';
export const POLICY={enabled:false,event_latency_ms:10000};
const schema=JSON.parse(fs.readFileSync(new URL('./mqtt-source-observation/handoff_schema.json',import.meta.url),'utf8'));
const src=name=>{
 const body=fs.readFileSync(new URL('./functions/mqtt-native-'+name+'.js',import.meta.url),'utf8').trimEnd();
 return ['normalize','test-build'].includes(name)?'const MQTT_NATIVE_SCHEMA='+JSON.stringify(schema)+';\n'+body:body;
};
export function installMqttNative(flows){
 const owned=n=>n.id===TAB||n.z===TAB&&!n.id.startsWith('global_observer_coverage__');
 const nodes=[{id:TAB,type:'tab',label:'observacao_mqtt_nativa',mqtt_native_layout_version:2,disabled:flows.find(n=>n.id===TAB)?.disabled===true,
  info:'Metadados sem tópicos/payloads/clientes. Fonte root → normalização → limite visual → persistência → ACK. Desligado até escopo/instalação aprovados; não comprova sozinho todos os eventos HA/MQTT nem24h.',env:[]}];
 const add=n=>{nodes.push(n);if(n.g)nodes.find(g=>g.id===n.g).nodes.push(n.id);return n.id;};
 const group=(id,name,x,y,w,h)=>{if(['decision_group','result_group','effect_group','test_group'].includes(id))y+=500;return add({id:'mq_native_'+id,type:'group',z:TAB,name,style:{label:true,color:'#2563eb'},nodes:[],x,y,w,h});};
 const g={policy:group('policy_group','0. Parâmetros: escopo e limite medido (ms)',64,40,2660,300),
  reader:group('reader_group','2. Autorização e idade do leitor: regras visíveis',64,980,2660,420),
  source:group('source_group','1. Fonte fixa, execução serial e normalização',64,400,2660,540),
  decision:group('decision_group','3. Integridade e decisão visual de latência',64,980,2660,580),
  result:group('result_group','4. Projeção canônica e intenção deduplicada',64,1600,2660,700),
  effect:group('effect_group','5. Gate final: persistir / confirmar ou simular',64,2340,2660,480),
  test:group('test_group','6. Replay manual completo sem efeitos residenciais',64,2860,2660,900)};
 const node=(id,type,group,name,x,y,rest={})=>add({id:'mq_native_'+id,type,z:TAB,g:group,name,x,y:y+([g.decision,g.result,g.effect,g.test].includes(group)?500:0),wires:[],...rest});
 const fn=(id,group,name,file,x,y,wires,outputs=1)=>node(id,'function',group,name,x,y,{func:src(file),outputs,timeout:0,noerr:0,initialize:'',finalize:'',libs:[],wires});
 const inj=(id,group,name,payload,x,y,target,extra={})=>node(id,'inject',group,name,x,y,{props:[{p:'payload',v:payload,vt:'str'}],repeat:'',crontab:'',once:false,onceDelay:.1,topic:'',payload,payloadType:'str',wires:[[target]],...extra});
 const change=(id,group,name,property,value,kind,x,y,target,extra={})=>node(id,'change',group,name,x,y,{rules:[{t:'set',p:property,pt:'msg',to:value,tot:kind}],action:'',property:'',from:'',to:'',reg:false,wires:[[target]],...extra});
 const sw=(id,group,name,property,rules,x,y,wires)=>node(id,'switch',group,name,x,y,{property,propertyType:'msg',rules,checkall:'false',repair:false,outputs:rules.length,wires});
 const out=(id,group,name,targets,x,y)=>node(id,'link out',group,name,x,y,{mode:'link',links:targets});
 const input=(id,group,name,origins,target,x,y)=>node(id,'link in',group,name,x,y,{links:origins,wires:[[target]]});
 node('policy_info','comment',g.policy,'Padrão: desligado; evento ≤ 10.000 ms; editar entre 1.000 e 60.000 ms',1500,90,{info:'enabled booleano; event_latency_ms inteiro1.000–60.000. Inválidos preservam último parâmetro; bootstrap preserva valor válido. Helpers validam protocolo; limiar somente no switch visual. Ativação depende de escopo e pacote aprovados.'});
 inj('policy_tick',g.policy,'Carregar padrão uma vez','',240,170,'mq_native_policy_config',{once:true,onceDelay:'0.2',props:[{p:'payload',v:'',vt:'str'},{p:'_mqtt_defaults',v:'true',vt:'bool'}]});
 change('policy_config',g.policy,'PARÂMETROS: habilitação e ms','payload',JSON.stringify(POLICY),'json',590,170,'mq_native_policy_store');
 fn('policy_store',g.policy,'Validar; manter último valor','policy',940,170,[['mq_native_policy_return']]);
 input('policy_test_in',g.policy,'TESTE → mesmo validador',['mq_native_test_policy_out'],'mq_native_policy_store',760,260);
 out('policy_return',g.policy,'TESTE validado → mesma fonte',['mq_native_test_policy_return_in'],1120,170);
 inj('tick',g.source,'FONTE: ler a cada 2s','',240,480,'mq_native_read_policy',{repeat:'2',once:true,onceDelay:'12'});
 input('test_policy_return_in',g.source,'Receber configuração TESTE',['mq_native_policy_return'],'mq_native_read_policy',420,550);
 fn('read_policy',g.source,'Ler parâmetros do namespace','read-policy',590,480,[['mq_native_enabled']]);
 sw('enabled',g.source,'Leitura habilitada?','_mqtt_enabled',[{t:'true'},{t:'else'}],940,480,[['mq_native_flight'],['mq_native_disabled_out']]);
 out('disabled_out',g.source,'Desligado → silencioso',['mq_native_disabled_in'],1120,540);
 fn('flight',g.source,'Consultar execução serial','flight',1290,480,[['mq_native_inflight']]);
 sw('inflight',g.source,'Leitura em andamento?','_mqtt_inflight',[{t:'true'},{t:'else'}],1640,480,[['mq_native_inflight_out'],['mq_native_acquire']]);
 out('inflight_out',g.source,'Ocupado → aguardar',['mq_native_busy_in'],1820,540);
 fn('acquire',g.source,'Marcar dono desta leitura','acquire',1990,480,[['mq_native_source_mode']]);
 sw('source_mode',g.source,'Sintético ou relatório fixo?','test_mode',[{t:'true'},{t:'else'}],2340,480,[['mq_native_synthetic_out'],['mq_native_prepare']]);
 out('synthetic_out',g.source,'TESTE → fatos sintéticos',['mq_native_synthetic_in'],2520,430);
 input('synthetic_in',g.source,'Receber somente TESTE',['mq_native_synthetic_out'],'mq_native_synthetic',100,700);
 fn('synthetic',g.source,'Entregar envelope sintético','synthetic-source',350,700,[['mq_native_synthetic_normalize_out']]);
 out('synthetic_normalize_out',g.source,'Mesmo contrato → normalizar',['mq_native_normalize_in'],530,700);
 node('prepare','exec',g.source,'Preparar leitura (até 3s)',2340,680,{command:'/bin/sh /data/tools/mqtt-source-observation/consumer-command.sh prepare',addpay:'',append:'',useSpawn:'false',timer:'3',winHide:false,oldrc:false,wires:[['mq_native_prepare_normalize_out'],[],['mq_native_read_complete']]});
 out('prepare_normalize_out',g.source,'Fonte real → normalizar',['mq_native_normalize_in'],2520,680);
 fn('read_complete',g.source,'Retorno não zero → unknown','read-completion',2340,820,[['mq_native_failed_normalize_out']]);
 out('failed_normalize_out',g.source,'Falha → mesma normalização',['mq_native_normalize_in'],2520,820);
 input('normalize_in',g.source,'Receber fonte / TESTE / falha',['mq_native_synthetic_normalize_out','mq_native_prepare_normalize_out','mq_native_failed_normalize_out'],'mq_native_normalize',760,700);
 fn('normalize',g.source,'Validar fatos e unidades exatas','normalize',940,700,[['mq_native_valid']]);
 sw('valid',g.source,'Proposta válida?','_mqtt_valid',[{t:'true'},{t:'else'}],1290,700,[['mq_native_valid_out'],['mq_native_busy_source']]);
 out('valid_out',g.source,'Proposta → estado do leitor',['mq_native_reader_in'],1470,650);
 sw('busy_source',g.source,'Produtor ocupado?','_mqtt_source_state',[{t:'eq',v:'busy',vt:'str'},{t:'else'}],1640,780,[['mq_native_source_busy_out'],['mq_native_source_unknown_out']]);
 out('source_busy_out',g.source,'Ocupado → aguardar',['mq_native_busy_in'],1820,740);
 out('source_unknown_out',g.source,'Fonte desconhecida',['mq_native_unknown_in'],1820,840);
 input('reader_in',g.reader,'Receber fonte validada',['mq_native_valid_out'],'mq_native_reader_authorized',100,1080);
 sw('reader_authorized',g.reader,'Leitor autorizado?','_mqtt_reader_authorized',[{t:'true'},{t:'false'},{t:'else'}],350,1080,
  [['mq_native_reader_domain'],['mq_native_reader_disabled_out'],['mq_native_reader_auth_unknown_out']]);
 out('reader_disabled_out',g.reader,'Escopo fechado → sem ACK',['mq_native_disabled_in'],530,1160);
 out('reader_auth_unknown_out',g.reader,'Autorização desconhecida',['mq_native_unknown_in'],530,1280);
 for(const[id,label,field,next,x]of [
  ['reader_domain','Mesmo domínio de tempo?','_mqtt_reader_domain','mq_native_reader_ordered',690],
  ['reader_ordered','Relógio ordenado?','_mqtt_reader_ordered','mq_native_reader_age_known',1030]]){
  sw(id,g.reader,label,field,[{t:'true'},{t:'else'}],x,1080,[[next],['mq_native_'+id+'_unknown_out']]);
  out(id+'_unknown_out',g.reader,'Relógio desconhecido → sem ACK',['mq_native_unknown_in'],x+180,1160);
 }
 sw('reader_age_known',g.reader,'Idade medida?','_mqtt_reader_age_ms',[{t:'null'},{t:'else'}],1370,1080,
  [['mq_native_reader_age_unknown_out'],['mq_native_reader_age']]);
 out('reader_age_unknown_out',g.reader,'Sem idade → sem ACK',['mq_native_unknown_in'],1550,1160);
 sw('reader_age',g.reader,'Idade ≤ contrato (ms)?','_mqtt_reader_age_ms',[{t:'lte',v:'_mqtt_policy.event_latency_ms',vt:'msg'},{t:'else'}],1710,1080,
  [['mq_native_reader_ready_set'],['mq_native_reader_stale_out']]);
 out('reader_stale_out',g.reader,'Leitura antiga → sem ACK',['mq_native_unknown_in'],1890,1160);
 change('reader_ready_set',g.reader,'Leitor apto: permitir intenção','_mqtt_commit_allowed','true','bool',2050,1080,'mq_native_reader_ready_out');
 out('reader_ready_out',g.reader,'Leitor apto → decisões',['mq_native_decision_in'],2230,1080);
 input('decision_in',g.decision,'Receber proposta',['mq_native_reader_ready_out'],'mq_native_has_receipt',100,1080);
 const branch=(id,name,x,y,target)=>{out(id,g.decision,name,[target],x,y);return 'mq_native_'+id;};
 sw('has_receipt',g.decision,'Há novo recibo?','_mqtt_has_receipt',[{t:'true'},{t:'else'}],350,1080,[['mq_native_missing'],[branch('no_receipt_out','Sem recibo → aguardar',530,1160,'mq_native_no_new_receipt_in')]]);
 for(const[id,label,field,next,x]of [
  ['missing','Contagem sem perdas?','_mqtt_missing_total','mq_native_clock_faults',690],
  ['clock_faults','Fonte sem falha de integridade?','_mqtt_integrity_faults_total','mq_native_timing_unknown',1030],
  ['timing_unknown','Origem temporal conhecida?','_mqtt_unknown_total','mq_native_clock_ordered',1370]]){
  const route=branch(id+'_unknown_out','Integridade desconhecida',x+180,1160,'mq_native_unknown_in');
  sw(id,g.decision,label,field,[{t:'eq',v:'0',vt:'str'},{t:'else'}],x,1080,[[next],[route]]);
 }
 sw('clock_ordered',g.decision,'Ordem/domínio confirmados?','_mqtt_clock_ordered',[{t:'true'},{t:'else'}],1710,1080,[['mq_native_events'],[branch('clock_unknown_out','Relógio incerto',1890,1160,'mq_native_unknown_in')]]);
 sw('events',g.decision,'Recibo possui eventos?','_mqtt_observed_total',[{t:'eq',v:'0',vt:'str'},{t:'else'}],2050,1080,[[branch('no_events_out','Zero eventos → explícito',2230,1000,'mq_native_no_events_in')],['mq_native_upper_known']]);
 sw('upper_known',g.decision,'Limite temporal disponível?','_mqtt_max_upper_ms',[{t:'null'},{t:'else'}],2390,1080,[[branch('upper_unknown_out','Tempo desconhecido',2570,1160,'mq_native_unknown_in')],[branch('threshold_out','Limite → regra visual',2570,1010,'mq_native_threshold_in')]]);
 input('threshold_in',g.decision,'Receber limite',['mq_native_threshold_out'],'mq_native_threshold',100,1400);
 sw('threshold',g.decision,'Latência ≤ contrato (ms)?','_mqtt_max_upper_ms',[{t:'lte',v:'_mqtt_policy.event_latency_ms',vt:'msg'},{t:'else'}],350,1400,
  [[branch('within_out','Dentro do contrato',530,1350,'mq_native_within_contract_in')],[branch('over_out','Acima do contrato',530,1470,'mq_native_over_contract_in')]]);
 const statuses=['within_contract','over_contract','unknown','no_events','no_new_receipt','disabled','busy'];
 for(const[i,status]of statuses.entries()){
  const y=1680+i*80;
  input(status+'_in',g.result,'Receber '+status,[],'mq_native_'+status+'_set',100,y);
  change(status+'_set',g.result,'Marcar '+status,'_mqtt_classification',status,'str',350,y,'mq_native_'+status+'_record_out');
  out(status+'_record_out',g.result,'Classificação → projeção',['mq_native_record_in'],530,y);
 }
 input('record_in',g.result,'Receber resultado',statuses.map(s=>'mq_native_'+s+'_record_out'),'mq_native_record',760,1960);
 fn('record',g.result,'Publicar fatos e classificação','record',940,1960,[['mq_native_intent']]);
 fn('intent',g.result,'Validar intenção / consultar dedupe','intent',1290,1960,[['mq_native_commit_valid']]);
 sw('commit_valid',g.result,'Proposta exata para confirmar?','_mqtt_commit_valid',[{t:'true'},{t:'else'}],1640,1960,[['mq_native_duplicate'],['mq_native_noop_out']]);
 out('noop_out',g.result,'Sem proposta → sem ACK',['mq_native_noop_in'],1820,2050);
 sw('duplicate',g.result,'Proposta já confirmada?','_mqtt_ticket_duplicate',[{t:'true'},{t:'else'}],1990,1960,[['mq_native_skip_out'],['mq_native_commit_set']]);
 out('skip_out',g.result,'Duplicata → sem novo efeito',['mq_native_skip_in'],2170,1890);
 change('commit_set',g.result,'Intenção: confirmar metadados','_mqtt_operation','commit','str',2340,1960,'mq_native_commit_gate_out');
 out('commit_gate_out',g.result,'Intenção → gate final',['mq_native_gate_in'],2520,1960);
 input('skip_in',g.result,'Receber duplicata',['mq_native_skip_out'],'mq_native_skip_set',2160,2110);
 change('skip_set',g.result,'Intenção: pular duplicata','_mqtt_operation','skip_duplicate','str',2340,2110,'mq_native_skip_gate_out');
 out('skip_gate_out',g.result,'Duplicata → gate',['mq_native_gate_in'],2520,2110);
 input('noop_in',g.result,'Receber ausência de proposta',['mq_native_noop_out'],'mq_native_noop_set',2160,2230);
 change('noop_set',g.result,'Intenção: só diagnóstico','_mqtt_operation','noop','str',2340,2230,'mq_native_noop_gate_out');
 out('noop_gate_out',g.result,'Diagnóstico → gate',['mq_native_gate_in'],2520,2230);
 input('gate_in',g.effect,'Receber intenção',['mq_native_commit_gate_out','mq_native_skip_gate_out','mq_native_noop_gate_out'],'mq_native_test_gate',100,2430);
 sw('test_gate',g.effect,'Produção ou TESTE?','test_mode',[{t:'true'},{t:'else'}],350,2430,[['mq_native_dry_run_terminal'],['mq_native_operation']]);
 fn('dry_run_terminal',g.effect,'TESTE: sem exec/ACK/push','dry-run',700,2430,[['mq_native_test_global_out']]);
 out('test_global_out',g.effect,'TESTE → terminal global',['global_observer_alert_to_dispatch_in'],880,2430);
 sw('operation',g.effect,'Efeito é confirmação?','_mqtt_operation',[{t:'eq',v:'commit',vt:'str'},{t:'else'}],700,2580,[['mq_native_commit'],['mq_native_finish_out']]);
 out('finish_out',g.effect,'Sem efeito → liberar',['mq_native_release_in'],880,2690);
 node('commit','exec',g.effect,'Persistir antes de ACK (até 3s)',1050,2580,{command:'/bin/sh /data/tools/mqtt-source-observation/consumer-command.sh commit',addpay:'payload',append:'',useSpawn:'false',timer:'3',winHide:false,oldrc:false,wires:[['mq_native_commit_result'],[],['mq_native_commit_complete']]});
 fn('commit_result',g.effect,'Resultado exato → dedupe','commit-result',1400,2580,[['mq_native_release']]);
 fn('commit_complete',g.effect,'Falha → desconhecido','commit-completion',1050,2730,[['mq_native_commit_failure_out']]);
 out('commit_failure_out',g.effect,'Falha → liberar',['mq_native_release_in'],1230,2730);
 input('release_in',g.effect,'Receber término sem commit',['mq_native_finish_out','mq_native_commit_failure_out'],'mq_native_release',1550,2730);
 fn('release',g.effect,'Liberar somente leitura própria','release',1750,2580,[['mq_native_diagnostic']]);
 node('diagnostic','debug',g.effect,'Diagnóstico local',2100,2580,{active:false,tosidebar:true,console:false,tostatus:false,complete:'payload',targetType:'msg',statusVal:'',statusType:'auto'});
 node('test_info','comment',g.test,'ORDEM: reset → nominal → duplicata → acima → desconhecido → perda → indisponível',1500,2910,{info:'Namespace __test em memória. Mesma política,normalização,decisão,dedupe e gate. Sem exec,arquivos,HA,MQTT ou push. Zero eventos e falta de recibo não provam recuperação. Fonte unknown não declara broker offline.'});
 const scenarios=[['reset','0 reset'],['within','1 nominal'],['duplicate','2 duplicata'],['over','3 acima10s'],['unknown','4 relógio desconhecido'],['missing','5 perda'],['no_events','6 zero eventos'],['unavailable','7 fonte indisponível'],['busy','8 ocupado'],['malformed','9 inválido'],['disabled','10 desligado'],['reader_denied','11 escopo fechado'],['reader_clock','12 domínio diferente'],['reader_future','13 relógio futuro'],['reader_stale','14 leitor antigo'],['reader_missing','15 sem metadados']];
 for(const[i,[value,label]]of scenarios.entries()){
  const x=240+(i%4)*350,y=3000+Math.floor(i/4)*100;
  inj('test_'+value,g.test,'TESTE '+label,value,x,y,'mq_native_test_'+value+'_out',
   {props:[{p:'payload',v:value,vt:'str'},{p:'test_mode',v:'true',vt:'bool'},{p:'_mqtt_test_source',v:'true',vt:'bool'}]});
  out('test_'+value+'_out',g.test,'TESTE '+value+' → replay',['mq_native_test_build_in'],x+180,y);
 }
 input('test_build_in',g.test,'TESTES → mesmo replay',scenarios.map(([v])=>'mq_native_test_'+v+'_out'),'mq_native_test_build',1460,3660);
 fn('test_build',g.test,'Construir somente fatos sintéticos','test-build',1640,3660,[['mq_native_test_policy_config']]);
 change('test_policy_config',g.test,'TESTE: mesma definição','payload',JSON.stringify(POLICY),'json',1990,3660,'mq_native_test_policy_out',
  {rules:[{t:'set',p:'payload',pt:'msg',to:JSON.stringify(POLICY),tot:'json'},{t:'set',p:'payload.enabled',pt:'msg',to:'_mqtt_test_enabled',tot:'msg'}]});
 out('test_policy_out',g.test,'TESTE → validador',['mq_native_policy_test_in'],2170,3660);
 const result=reconcileGeneratedFlows(flows,[...flows.filter(n=>!owned(n)),...nodes],{isOwned:owned,preserveLayout:flows.find(n=>n.id===TAB)?.mqtt_native_layout_version===2});
 const byId=new Map(result.map(n=>[n.id,n]));
 for(const n of result.filter(n=>n.z===TAB&&n.type==='link out'))for(const target of n.links??[]){
  const peer=byId.get(target);if(peer?.type==='link in'&&!peer.links.includes(n.id))peer.links.push(n.id);
 }
 return routeCanvasWires(result,[TAB]);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const source=process.argv[2],output=process.argv[3]??source;
 if(!source||!output)throw new Error('usage: install-mqtt-native-observer-flow.mjs source.json output.json');
 fs.writeFileSync(output,JSON.stringify(installMqttNative(JSON.parse(fs.readFileSync(source,'utf8'))),null,4)+'\n');
}
