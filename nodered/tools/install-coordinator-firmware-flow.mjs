// Dedicated daily coordinator path; the generic firmware installer stays blocked.
export function installCoordinatorFirmwareFlow(nodes,previous){
 const tab='daily_host_updates_tab',prefix='daily_update_coordinator_',firmware=nodes.find(n=>n.id==='daily_update_firmware_group'),entry=nodes.find(n=>n.id==='daily_update_firmware_in');
 if(!firmware||!entry)throw Error('firmware canvas missing');
 const y=Math.max(...previous.filter(n=>n.z===tab&&n.type==='group'&&!n.id.startsWith(prefix)).map(n=>n.y+n.h),9000)+100;
 const group=prefix+'group',tests=prefix+'tests_group';
 const add=n=>{nodes.push(n);return n.id};
 add({id:group,type:'group',z:tab,name:'Coordenador: janela diária → backup → parada → firmware estável → restore verificado',style:{label:true,stroke:'#0f766e',fill:'#ccfbf1','fill-opacity':'0.2'},nodes:[],x:64,y,w:2840,h:700});
 add({id:tests,type:'group',z:tab,name:'TESTES do coordenador — mesmo caminho até dry-run',style:{label:true,stroke:'#0891b2'},nodes:[],x:64,y:y+760,w:2840,h:420});
 const grouped=(g,n)=>{n.z=tab;n.g=g;nodes.find(v=>v.id===g).nodes.push(n.id);return add(n)};
 const fn=(id,g,name,func,x,py,wires,outputs=1)=>grouped(g,{id,type:'function',name,func,outputs,noerr:0,timeout:0,initialize:'',finalize:'',libs:[],x,y:py,wires});
 const sw=(id,name,property,x,py,wires)=>grouped(group,{id,type:'switch',name,property,propertyType:'jsonata',rules:[{t:'true'},{t:'else'}],checkall:'false',repair:false,outputs:2,x,y:py,wires});
 const out=(id,g,name,target,x,py)=>grouped(g,{id,type:'link out',name,mode:'link',links:[target],x,y:py,wires:[]});
 const input=(id,g,name,from,target,x,py)=>grouped(g,{id,type:'link in',name,links:Array.isArray(from)?from:[from],x,y:py,wires:[[target]]});
 const terminal=(id,name,x,py)=>fn(id,group,name,"node.status({fill:'grey',shape:'ring',text:'aguardando candidato, janela ou fonte válida'});return null;",x,py,[],0);
 entry.wires=[[prefix+'route_out']];
 grouped(firmware.id,{id:prefix+'route_out',type:'link out',name:'Firmware → distinguir coordenador',mode:'link',links:[prefix+'in'],x:entry.x+90,y:entry.y,wires:[]});
 grouped(firmware.id,{id:prefix+'ordinary_in',type:'link in',name:'Demais equipamentos → atualização normal',links:[prefix+'ordinary_out'],x:entry.x+50,y:entry.y+70,wires:[['daily_update_firmware_state']]});
 input(prefix+'in',group,'Receber candidato físico',prefix+'route_out',prefix+'classify',114,y+90);
 sw(prefix+'classify','É coordenador Zigbee/SMLIGHT?',"$contains(payload.search_key, /slzb|smlight|coordinator|coordenador/)",420,y+90,[[prefix+'pending'],[prefix+'ordinary_out']]);
 out(prefix+'ordinary_out',group,'Equipamento comum → fluxo original',prefix+'ordinary_in',680,y+170);
 fn(prefix+'pending',group,'Preservar entidade do inventário HA',"msg.coordinator_entity=msg.payload.entity_id;msg.coordinator_now=Number(msg.monitor_now??Date.now());return msg;",800,y+90,[[prefix+'daily']]);
 sw(prefix+'daily','Janela diária/manual autorizada?',"_update_apply_authorized = true and update_policy.device_firmware_auto = true",1100,y+90,[[prefix+'source_out'],[prefix+'wait_daily']]);
 terminal(prefix+'wait_daily','Reservado para as atualizações das 03:00',1100,y+190);
 out(prefix+'source_out',group,'Janela autorizada → fonte estável',prefix+'facts_in',1300,y+90);
 input(prefix+'versions_in',group,'Versão estável observada',prefix+'safe_out',prefix+'versions',1360,y+90);
 fn(prefix+'versions',group,'Normalizar versões e preservar candidato',`const p=msg.coordinator_candidate;function parts(v){const s=String(v||'');if(/^\\d{8}$/.test(s))return [Number(s),0,0,1,0];const m=s.match(/^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:[.-](dev|beta|rc)(\\d*))?$/i);return m?[+m[1],+m[2],+m[3],m[4]?0:1,+(m[5]||0)]:null}const a=parts(p.latest_version),b=parts(p.installed_version);msg.coordinator_stable=!!a&&a[3]===1;msg.coordinator_newer=false;if(a&&b){for(let i=0;i<a.length;i++){if(a[i]!==b[i]){msg.coordinator_newer=a[i]>b[i];break}}}msg.coordinator_candidate=p;msg.coordinator_now=Number(msg.monitor_now??Date.now());return msg;`,1540,y+90,[[prefix+'eligible']]);
 sw(prefix+'eligible','Estável, mais recente e observação fresca?',"coordinator_stable = true and coordinator_newer = true and coordinator_candidate.observed_at <= coordinator_now and coordinator_candidate.observed_at >= coordinator_now-(update_policy.coordinator_inventory_max_age_minutes*60000)",1920,y+90,[[prefix+'facts_out'],[prefix+'not_eligible']]);
 terminal(prefix+'not_eligible','Sem downgrade ou firmware de teste',1920,y+190);
 out(prefix+'facts_out',group,'Candidato elegível → deduplicação',prefix+'dedupe_in',2200,y+90);
 input(prefix+'facts_in',group,'Receber janela autorizada',prefix+'source_out',prefix+'source_mode',114,y+310);
 sw(prefix+'source_mode','Fonte é TESTE?',"_ha_updates_test = true",370,y+310,[[prefix+'test_facts'],[prefix+'read_facts']]);
 fn(prefix+'test_facts',group,'Injetar apenas fatos sintéticos',"msg.payload=msg.coordinator_test_facts;return msg;",700,y+270,[[prefix+'facts']]);
 grouped(group,{id:prefix+'read_facts',type:'file in',name:'FONTE: saúde do adaptador e do backup',filename:'/data/zigbee-recovery/facts.json',filenameType:'str',format:'utf8',chunk:false,sendError:true,encoding:'none',allProps:false,x:700,y:y+360,wires:[[prefix+'facts']]});
 fn(prefix+'facts',group,'Adaptar JSON sem decidir política',`try{msg.coordinator_facts=typeof msg.payload==='string'?JSON.parse(msg.payload):msg.payload}catch{msg.coordinator_facts=null}const i=msg.coordinator_facts?.firmware_inventory;msg.coordinator_candidate=i?.updates?.find(p=>p.entity_id===msg.coordinator_entity)||null;return msg;`,1060,y+310,[[prefix+'safe']]);
 sw(prefix+'safe','Backup preservado e adaptador disponível?',"coordinator_facts.schema_version = 1 and coordinator_facts.observed_at <= coordinator_now and coordinator_facts.observed_at >= coordinator_now-(update_policy.coordinator_facts_max_age_seconds*1000) and coordinator_facts.last_good_available = true and coordinator_facts.firmware_inventory.observed_at >= coordinator_now-(update_policy.coordinator_inventory_max_age_minutes*60000) and coordinator_facts.firmware_inventory.observed_at <= coordinator_now and $exists(coordinator_candidate) and coordinator_candidate.is_stable = true",1430,y+310,[[prefix+'safe_out'],[prefix+'not_safe']]);
 out(prefix+'safe_out',group,'Fonte válida → comparar versões',prefix+'versions_in',1650,y+310);
 input(prefix+'dedupe_in',group,'Receber candidato elegível',prefix+'facts_out',prefix+'dedupe_prepare',1650,y+240);
 terminal(prefix+'not_safe','Preservar rede e aguardar próxima janela',1430,y+420);
 fn(prefix+'dedupe_prepare',group,'Identificar entidade, versão e modo',`const p=msg.coordinator_candidate;msg.coordinator_topic=(msg._ha_updates_test===true?'test:':'production:')+p.entity_id;msg.coordinator_signature=p.entity_id+':'+p.latest_version+':'+Math.floor(msg.coordinator_now/86400000);return msg;`,1810,y+310,[[prefix+'dedupe']]);
 grouped(group,{id:prefix+'dedupe',type:'rbe',name:'Uma fila por entidade e versão',func:'rbe',gap:'',start:'',inout:'out',septopics:true,property:'coordinator_signature',topi:'coordinator_topic',x:2180,y:y+310,wires:[[prefix+'request']]});
 fn(prefix+'request',group,'Serializar pedido fixo; nenhum segredo',`const p=msg.coordinator_candidate,now=msg.coordinator_now;let hash=2166136261;for(const c of p.entity_id+':'+p.latest_version)hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;const id=String(msg._msgid||'').replace(/[^a-f0-9]/gi,'').slice(0,12).padEnd(12,'0')+now.toString(16).padStart(12,'0').slice(-12)+hash.toString(16).padStart(8,'0');msg.coordinator_request={version:1,id,requested_at:now,entity_id:p.entity_id,target_version:p.latest_version,expected_installed_version:p.installed_version,stable_only:true,source:'daily_updates'};msg.filename='/data/zigbee-recovery/firmware-requests/'+id+'.json';msg.payload=JSON.stringify(msg.coordinator_request);return msg;`,2500,y+310,[[prefix+'final_out']]);
 out(prefix+'final_out',group,'Pedido → gate final',prefix+'final_in',2730,y+310);
 input(prefix+'final_in',group,'Receber plano validado',prefix+'final_out',prefix+'final_gate',114,y+540);
 sw(prefix+'final_gate','GATE FINAL: produção ou TESTE?',"_ha_updates_test = true",460,y+540,[[prefix+'dry_out'],[prefix+'write_request']]);
 out(prefix+'dry_out',group,'TESTE → dry-run compartilhado','daily_update_dry_run_in',760,y+490);
 grouped(group,{id:prefix+'write_request',type:'file',name:'EFEITO: fila da manutenção protegida',filename:'filename',filenameType:'msg',appendNewline:true,createDir:false,overwriteFile:'true',encoding:'utf8',x:830,y:y+580,wires:[[prefix+'queued']]});
 fn(prefix+'queued',group,'Aguardar verificação de firmware e rede',"node.status({fill:'yellow',shape:'ring',text:'fila protegida; backup e restore antes da conclusão'});return null;",1230,y+580,[],0);
 grouped(group,{id:prefix+'result_tick',type:'inject',name:'Resultado a cada 60 s',props:[{p:'payload'}],repeat:'60',crontab:'',once:true,onceDelay:30,x:1660,y:y+580,wires:[[prefix+'read_result']]});
 grouped(group,{id:prefix+'read_result',type:'file in',name:'FONTE: recibos da manutenção',filename:'/data/zigbee-recovery/firmware-result.json',filenameType:'str',format:'utf8',chunk:false,sendError:false,encoding:'none',allProps:false,x:2030,y:y+580,wires:[[prefix+'result']]});
 fn(prefix+'result',group,'Normalizar recibos e deduplicar falhas',`let p=msg.payload;try{if(typeof p==='string')p=JSON.parse(p)}catch{return null}if(p?.schema_version!==1||!Array.isArray(p.events))return null;const test=msg._ha_updates_test===true,key='coordinator_firmware_notices'+(test?'__test':''),store=test?'memoryOnly':'persistent',seen=flow.get(key,store)||{};const out=[];for(const r of p.events){const recovery=['updated','not_needed'].includes(r.status)&&Object.keys(seen).some(k=>k.startsWith(r.id+':'));if(!['failed','pending'].includes(r.status)&&!recovery)continue;const id=r.id+':'+r.status+':'+r.reason;if(seen[id])continue;seen[id]=true;out.push({...msg,coordinator_result:r,payload:{observer_kind:recovery?'domain_recovery':'domain_alert',persistent_incident_kind:'domain_alert',persistent_notification_operation:recovery?'dismiss':'create',mobile_notification:!recovery,incident_key:'coordinator_firmware_'+r.id,test_mode:test,reason:r.reason,source_observed_at:r.at,source_time_kind:'native',policy_decided_at:Date.now()},alert:{title:'Manutenção do coordenador requer atenção',message:'A atualização do coordenador não teve conclusão funcional confirmada. O backup foi preservado e a instalação não será repetida sem evidência. Veja atualizacoes_diarias.'}})}flow.set(key,seen,store);return [out];`,2450,y+580,[[prefix+'alert_gate']]);
 sw(prefix+'alert_gate','Alerta é TESTE?',"_ha_updates_test = true",2690,y+650,[[prefix+'alert_dry_out'],[prefix+'alert_out']]);
 out(prefix+'alert_dry_out',group,'Alerta TESTE → dry-run','daily_update_dry_run_in',2800,y+590);
 out(prefix+'alert_out',group,'Falha de domínio → monitor global','global_observer_alert_to_dispatch_in',2800,y+680);
 const dry=nodes.find(n=>n.id==='daily_update_dry_run_in');dry.links=[...new Set([...dry.links,prefix+'dry_out',prefix+'alert_dry_out'])];
 const normalize=nodes.find(n=>n.id==='daily_update_inventory_normalize'),inventoryGroup=nodes.find(n=>n.id===normalize.g);
 normalize.wires[0].push(prefix+'inventory_out');
 grouped(inventoryGroup.id,{id:prefix+'inventory_out',type:'link out',name:'Inventário HA → canal estável do coordenador',mode:'link',links:[prefix+'inventory_in'],x:normalize.x+40,y:normalize.y+70,wires:[]});
 input(prefix+'inventory_in',group,'Coordenador ainda que HA mostre atual/beta',prefix+'inventory_out',prefix+'inventory_filter',114,y+430);
 sw(prefix+'inventory_filter','Inventário é do coordenador?',"$contains(payload.search_key, /slzb|smlight|coordinator|coordenador/)",420,y+430,[[prefix+'inventory_forward'],[]]);
 out(prefix+'inventory_forward',group,'Coordenador → mesma normalização',prefix+'classify_in',660,y+430);
 input(prefix+'classify_in',group,'Receber coordenador do inventário',prefix+'inventory_forward',prefix+'classify',114,y+170);
 const now=Date.UTC(2026,0,1),candidate={entity_id:'update.synthetic_slzb_coordinator',state_class:'pending',installed_version:'20240101',latest_version:'20260101',in_progress:false,observed_at:now,search_key:'synthetic slzb firmware'};
 const facts={firmware_inventory:{schema_version:1,observed_at:now,updates:[{...candidate,is_stable:true}]},schema_version:1,observed_at:now,running:true,last_good_available:true,backup_valid:true,maintenance_active:false,blocked_unknown:false};
 for(const [id,name,changes,extra,x,py] of [
  ['test_nominal','TESTE: firmware estável após backup',{}, {},400,y+850],
  ['test_beta','TESTE: beta bloqueada',{latest_version:'v3.4.5.dev0'}, {},400,y+930],
  ['test_old','TESTE: downgrade bloqueado',{latest_version:'20230101'}, {},400,y+1010],
  ['test_no_window','TESTE: sem autorização diária',{}, {_update_apply_authorized:false},1300,y+850],
  ['test_busy','TESTE: fila aguarda manutenção',{}, {coordinator_test_facts:{...facts,maintenance_active:true}},1300,y+930],
 ])grouped(tests,{id:prefix+id,type:'inject',name,props:[{p:'payload',v:JSON.stringify({...candidate,...changes}),vt:'json'},{p:'_ha_updates_test',v:'true',vt:'bool'},{p:'_update_apply_authorized',v:'true',vt:'bool'},{p:'update_policy',v:'{"device_firmware_auto":true,"coordinator_facts_max_age_seconds":300,"coordinator_inventory_max_age_minutes":40}',vt:'json'},{p:'coordinator_test_facts',v:JSON.stringify({...facts,firmware_inventory:{schema_version:1,observed_at:now,updates:[{...candidate,...changes,is_stable:true}]}}),vt:'json'},{p:'monitor_now',v:String(now),vt:'num'},...Object.entries(extra).map(([p,v])=>({p,v:typeof v==='boolean'?String(v):JSON.stringify(v),vt:typeof v==='boolean'?'bool':'json'}))],repeat:'',crontab:'',once:false,onceDelay:1,x,y:py,wires:[[prefix+'classify']]});
 grouped(tests,{id:prefix+'test_failure',type:'inject',name:'TESTE: falha sem repetir firmware',props:[{p:'payload',v:JSON.stringify({schema_version:1,events:[{id:'synthetic',status:'failed',reason:'network_not_verified',at:now}]}),vt:'json'},{p:'_ha_updates_test',v:'true',vt:'bool'}],repeat:'',crontab:'',once:false,onceDelay:1,x:2200,y:y+850,wires:[[prefix+'result']]});
 grouped(tests,{id:prefix+'test_reset',type:'inject',name:'RESET: somente dedupe de TESTE',props:[{p:'payload'}],repeat:'',crontab:'',once:false,onceDelay:1,x:2200,y:y+1010,wires:[[prefix+'reset']]});
 fn(prefix+'reset',tests,'Limpar somente replay',"flow.set('coordinator_firmware_notices__test',{},'memoryOnly');msg.reset=true;msg.topic='test:update.synthetic_slzb_coordinator';msg.coordinator_topic=msg.topic;delete msg.coordinator_signature;return msg;",2550,y+1010,[[prefix+'dedupe']]);
}
