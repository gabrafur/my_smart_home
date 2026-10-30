// No source fragment is exported verbatim. Only reviewed diagnostic tokens survive.
const C=require('./diagnostic_templates.json');
const rules=[
 ['ha_started',/Home Assistant iniciado/g],['ha_started_message',/Home Assistant iniciou em/g],['host_last_boot',/Ultimo boot do Raspberry Pi/g],['startup_guidance',/Se esta inicializacao nao foi planejada, verifique energia, temperatura e logs\./g],['service_unavailable',/service not available/ig],['flow_failure',/falha em fluxo Node-RED/ig],['node_red',/\bNode-RED\b/ig],['ha',/\bHome Assistant\b/ig],['icloud',/\biCloud\b/ig],['public_bindings',/\bpublic_bindings\b/ig],['mqtt',/\bMQTT\b/ig],['mosquitto',/\bMosquitto\b/ig],['recorder',/\bRecorder\b/ig],['backup',/\bBackup\b/ig],['zigbee',/\bZigbee2MQTT\b/ig],
 ['flow_updates',/\batualizacoes_diarias\b/g],['node_codex_result',/Normalizar resultado Codex CLI/g],
 ['codex_registry_lookup_failed',/\bhost_update_stage_failed stage=codex-cli request_id=[A-Za-z0-9-]{1,80} failure_stage=registry-lookup stage_exit=69\b/g],
 ['flow_host',/\bobservacao_host\b/g],['flow_people',/\blocalizacao_pessoas\b/g],['node_age',/Idade dos recursos disponível\?/g],['node_icloud_primary',/EFEITO: atualizar localização iCloud primary/g],['node_icloud_secondary',/EFEITO: atualizar localização iCloud secondary/g],
 ['switch_operator',/operators\[rule\.t\] is not a function/g],['icloud_provider_unavailable',/iCloud location refresh provider is unavailable/g],['unsupported_icloud_core',/unsupported_icloud_core_version/g],['security_scan_failed',/security_scan_failed/g],
 ['execution_error',/erro de execução/ig],['unavailable',/\bindisponibilidade\b|\bunavailable\b|\bnot available\b/ig],['authentication',/authentication (?:required|failed)|autenticação|iCloudAuthRequired|not authorized/ig],['timeout',/\btimeout\b|\btimed out\b|tempo limite/ig],['connection_refused',/connection refused|ECONNREFUSED/ig],['connection_reset',/connection reset|ECONNRESET/ig],['permission_denied',/permission denied|EACCES/ig],['disk_full',/no space left on device|ENOSPC/ig],['invalid_configuration',/invalid config(?:uration)?|configuração inválida/ig],['database_locked',/database is locked/ig],['notification_cooldown',/O mesmo erro será silenciado por 6 horas para evitar notificações repetidas\./g]
];
const reasonCodes=new Set(['codex_registry_lookup_failed','service_unavailable','switch_operator','icloud_provider_unavailable','unsupported_icloud_core','security_scan_failed','execution_error','unavailable','authentication','timeout','connection_refused','connection_reset','permission_denied','disk_full','invalid_configuration','database_locked','setup_retry','MAC_NO_ACK','NWK_NO_ROUTE','MAC_NO_CHANNEL_ACCESS','zigbee_route_unconfirmed','zigbee_component_unavailable','zigbee_network_unavailable']);
const integrations=new Set(['node_red','ha','icloud','mqtt','mosquitto','recorder','backup','zigbee','public_bindings','radio_browser']);
function redactions(text,field){
 const out=[];const add=reason=>{if(!out.some(x=>x.reason===reason))out.push({field,reason});};
 if(/(?:password|passwd|senha|token|secret|api.?key|authorization|Bearer|cookie)\s*[:= ]/i.test(text))add('credential');
 if(/(?:OTP|2FA|PIN|código|verification code)\s*[:= ]+\S+/i.test(text))add('authentication_code');
 if(/(?:\b[a-z]{2,12}:\/\/|www\.)[^\s]{1,2048}/i.test(text))add('credential_url_or_private_url');
 if(/\b(?:lat(?:itude)?|lon(?:gitude)?|coordinates?|coordenadas?|GPS)\b|[-+]?\d{1,3}\.\d{3,}\s*[,;]\s*[-+]?\d{1,3}\.\d{3,}/i.test(text))add('location');
 if(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:rua|avenida|street|address|endereço)\b|[a-f0-9]{1,4}(?::[a-f0-9]{0,4}){2,}/i.test(text))add('address');
 if(/[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{1,32}|\b(?:pessoa|person|owner|nome|name)\s*[:=]/i.test(text))add('personal_data');
 return out;
}
// The public integration lifecycle producer supplies this exact title/body pair.
// Its generic reauthentication guidance is not evidence of an authentication error.
function radioBrowserTemplate(title,message){
 if(typeof title!=='string'||typeof message!=='string')return null;
 const t=title.slice(0,20000).match(/^(?:TESTE — )?Falha(?: persiste)? na integração Radio Browser(?=$|[\s.,:;!?—–-])/);
 const m=message.slice(0,20000).match(/^A integração Radio Browser permanece em setup_retry há (?:0|[1-9]\d{0,2}(?:\.\d{3})*) min\. Abra Configurações → Dispositivos e serviços no Home Assistant para consultar ou reautenticar a entrada\./);
 return t&&m?{titleLength:t[0].length,messageLength:m[0].length}:null;
}
// Match only paired, versioned Zigbee producer clauses. Private subjects/clocks never survive.
function zigbeeTemplate(title,message){
 if(typeof title!=='string'||typeof message!=='string')return null;
 const subject=String.raw`[^“”\r\n]{1,256}`;
 const when=String.raw`(?:0?[1-9]|[12]\d|3[01])/(?:0?[1-9]|1[0-2])/20\d{2},?\s+(?:[01]?\d|2[0-3]):[0-5]\d:[0-5]\d`;
 const patterns=[
  ['Falha de rota Zigbee',`O dispositivo Zigbee “${subject}” apresentou (?<radio>MAC_NO_ACK|NWK_NO_ROUTE|MAC_NO_CHANNEL_ACCESS) em ${when}\\. A recuperação automática foi iniciada \\(tentativa 1 de (?<limit>[1-5])\\)\\.`, 'zigbee_route_failure',true],
  ['Recuperação Zigbee não concluída',`“${subject}” continua sem rota após (?<attempts>[1-5]) tentativas\\. O processo automático foi encerrado; verifique a alimentação e a malha Zigbee\\.`, 'zigbee_route_unconfirmed',true],
  ['Rota Zigbee recuperada',`O dispositivo Zigbee “${subject}” voltou a publicar dados após (?<stable>[1-9]\\d{0,3}) segundos sem nova falha de rota\\. Recuperação confirmada em ${when}\\.`, 'zigbee_route_recovery_notice',true],
  ['Componente Zigbee indisponível',`O componente Zigbee “${subject}” ficou indisponível em ${when}\\. Verifique alimentação, alcance, bateria e a malha Zigbee\\.`, 'zigbee_component_unavailable',true],
  ['Componente Zigbee continua indisponível',`O componente Zigbee “${subject}” continua indisponível há pelo menos (?<hours>[1-9]\\d{0,2}) horas\\. Novo lembrete em ${when}\\.`, 'zigbee_component_unavailable',true],
  ['Componente Zigbee recuperado',`O componente Zigbee “${subject}” voltou a ficar disponível em ${when}\\.`, 'zigbee_component_recovery_notice',true],
  ['Falha na rede Zigbee',`A rede Zigbee está indisponível\\. O Zigbee2MQTT perdeu a conexão com a antena/coordenador ou parou de funcionar\\. Detectado em ${when}\\.`, 'zigbee_network_unavailable',false],
  ['Falha na rede Zigbee persiste',`A rede Zigbee continua indisponível há pelo menos (?<hours>[1-9]\\d{0,2}) horas\\. Novo lembrete em ${when}\\. Verifique o Zigbee2MQTT, a antena/coordenador e a conexão MQTT\\.`, 'zigbee_network_unavailable',false],
  ['Rede Zigbee recuperada',`A rede Zigbee voltou a funcionar e permaneceu conectada por (?<confirmation>[1-9]\\d{0,2}) segundos\\. Recuperada em ${when}\\.`, 'zigbee_network_recovery_notice',false]
 ];
 for(const [heading,body,code,privateSubject]of patterns.sort((a,b)=>b[0].length-a[0].length)){
  const t=title.slice(0,20000).match(new RegExp('^(?:TESTE — )?'+heading+'(?=$|[\\s.,:;!?—–-])'));
  if(!t)continue;
  const m=message.slice(0,20000).match(new RegExp('^'+body));if(!m)return null;
  const g=m.groups||{};
  if(g.hours&&Number(g.hours)>168||g.stable&&(Number(g.stable)<60||Number(g.stable)>3600)||g.confirmation&&Number(g.confirmation)>600)return null;
  const codes=['zigbee',code];if(g.radio)codes.push(g.radio);
  if(g.limit)codes.push('zigbee_attempt_1_of_'+g.limit);
  if(g.attempts)codes.push('zigbee_attempts_'+g.attempts);
  return {titleLength:t[0].length,messageLength:m[0].length,titleCodes:[code],messageCodes:codes,privateSubject};
 }
 return null;
}
function templateFragments(input,field,length,codes){
 const text=input.slice(0,20000);const redacted=redactions(text,field);
 if(input.length>20000)redacted.push({field,reason:'input_truncated'});
 if(text.slice(length).trim())redacted.push({field,reason:'non_allowlisted_text_may_contain_personal_data'});
 return {codes,redacted};
}
function fragments(input,field){
 const original=typeof input==='string'?input:'';const text=original.slice(0,20000);const redacted=redactions(text,field);const hits=[];const spans=[];
 if(original.length>20000)redacted.push({field,reason:'input_truncated'});
 for(const [code,pattern]of rules){pattern.lastIndex=0;for(const m of text.matchAll(pattern)){hits.push({code,at:m.index});spans.push([m.index,m.index+m[0].length]);}}
 hits.sort((a,b)=>a.at-b.at||a.code.localeCompare(b.code));const codes=[...new Set(hits.map(x=>x.code))].filter(code=>code!=='node_red'||!hits.some(h=>h.code==='flow_failure')).slice(0,16);
 let cursor=0;const pieces=[];for(const [start,end]of spans.sort((a,b)=>a[0]-b[0])){if(start>cursor)pieces.push(text.slice(cursor,start));cursor=Math.max(cursor,end);}pieces.push(text.slice(cursor));let residual=pieces.join(' ');
 // Grammar and punctuation are non-diagnostic. Everything else fails closed.
 residual=residual.replace(/\b(?:o|a|os|as|um|uma|no|na|do|da|de|ao|em|e|por|para|que|mesmo|registrou|nó|fluxo|the|a|in|at|is|of|failed|error|erro|falha)\b/ig,'').replace(/[\s“”"'.,:;!?()\[\]—–-]/g,'');
 if(residual)redacted.push({field,reason:'non_allowlisted_text_may_contain_personal_data'});
 return {codes,redacted};
}
function stackFrames(input){
 const text=typeof input==='string'?input.slice(0,20000):'';const frames=[];let dropped=false;
 for(const line of text.split('\n').slice(0,40)){
  let source=null;
  if(line.includes('homeassistant/components/icloud/account.py'))source='homeassistant/components/icloud/account.py';
  else if(line.includes('homeassistant/components/icloud/services.py'))source='homeassistant/components/icloud/services.py';
  else if(line.includes('homeassistant/custom_components/public_bindings/__init__.py')||line.includes('custom_components/public_bindings/__init__.py'))source='homeassistant/custom_components/public_bindings/__init__.py';
  else if(line.includes('homeassistant/core.py'))source='homeassistant/core.py';
  else if(line.includes('/core/function/10-switch.js'))source='node-red/core/function/10-switch.js';
  else if(line.includes('/core/function/10-function.js'))source='node-red/core/function/10-function.js';
  else if(line.includes('node-red-contrib-home-assistant-websocket')&&/\/api(?:\.js|\/)/.test(line))source='node-red-ha/api.js';
  else if(line.includes('node-red-contrib-home-assistant-websocket')&&/controller/i.test(line))source='node-red-ha/controller.js';
  if(!source){if(/\bat |File |Traceback/.test(line))dropped=true;continue;}
  const n=line.match(/line ([0-9]{1,6})|:([0-9]{1,6})(?::[0-9]{1,6})?\)?\s*$/);const number=n?Number(n[1]||n[2]):null;
  const fn=C.stack_functions.find(name=>new RegExp('(?:\\bin |\\bat |[. ])'+name+'(?:[. (]|$)').test(line))||null;
  frames.push({source,line:number,function:fn});if(frames.length===6)break;
 }
 return {frames,dropped};
}
function errorDTO(error,embedded='',depth=0,seen=new Set(),frameBudget=6){
 const raw=error&&typeof error==='object'?error:{};seen.add(raw);const name=C.error_types.includes(raw.name)?raw.name:C.error_types.find(n=>new RegExp('\\b'+n+'\\s*:').test((typeof raw.message==='string'?raw.message:'')+' '+embedded))||null;
 const message=fragments(typeof raw.message==='string'?raw.message:embedded,'error.message');const stack=stackFrames(raw.stack||embedded);stack.frames=stack.frames.slice(0,frameBudget);
 const reason=message.codes.filter(c=>reasonCodes.has(c));
 const causes=[];if(depth<2&&raw.cause&&typeof raw.cause==='object'&&!seen.has(raw.cause)){const child=errorDTO(raw.cause,raw.cause.message||'',depth+1,seen,Math.max(0,frameBudget-stack.frames.length));child.stack=child.stack.slice(0,Math.max(0,6-stack.frames.length));causes.push(child);}
 return {exception_type:name,message_codes:message.codes,reason_codes:reason,stack:stack.frames,causes,
  redacted_fields:[...message.redacted,...(stack.dropped?[{field:'error.stack',reason:'unreviewed_stack_frame'}]:[])],
  collection_error:!name&&!reason.length&&!stack.frames.length?'exception_or_stack_not_present':null};
}
function sanitizeContent(title,message,error=null){
 const reviewed=radioBrowserTemplate(title,message)||zigbeeTemplate(title,message);
 const t=reviewed?templateFragments(title,'title',reviewed.titleLength,reviewed.titleCodes||['integration_failure','radio_browser']):fragments(title,'title');
 const m=reviewed?templateFragments(message,'message',reviewed.messageLength,reviewed.messageCodes||['radio_browser','setup_retry']):fragments(message,'message');if(reviewed?.privateSubject&&!m.redacted.some(item=>item.reason==='non_allowlisted_text_may_contain_personal_data'))m.redacted.push({field:'message',reason:'non_allowlisted_text_may_contain_personal_data'});const all=[...t.codes,...m.codes];if(all.includes('flow_failure'))all.push('node_red');const why=[...new Set(all.filter(x=>reasonCodes.has(x)))];
 const guidance=why.includes('service_unavailable')?'check_service':why.includes('switch_operator')?'check_switch':why.includes('unsupported_icloud_core')?'check_core_compatibility':why.includes('authentication')?'check_manual_auth':all.includes('backup')?'check_backup':'check_integration';
 return {schema_version:1,title_codes:t.codes.length?t.codes:['notice'],message_codes:m.codes.length?m.codes:['no_safe_clause'],
  integration_codes:[...new Set(all.filter(x=>integrations.has(x)))],reason_codes:why,guidance_code:guidance,
  redacted_fields:[...t.redacted,...m.redacted].slice(0,16),error:errorDTO(error,reviewed?'':typeof message==='string'?message:''),
  raw_content_persisted:false,untrusted_source_text:true,rendering:'reviewed_diagnostic_fragments_only'};
}
function contextDTO(flow,node){return {flow:typeof flow==='string'&&Object.hasOwn(C.context_flows,flow)?flow:null,node:typeof node==='string'&&Object.hasOwn(C.context_nodes,node)?node:null};}
module.exports={sanitizeContent,errorDTO,fragments,stackFrames,contextDTO};
