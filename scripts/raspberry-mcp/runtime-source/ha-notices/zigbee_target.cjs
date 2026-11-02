// Read-only identification grammar; automation decisions remain with the producer.
const C={zigbee_target_policy:require('./zigbee_target_policy.json')};
function zigbeeTemplate(title,message){
 if(typeof title!=='string'||typeof message!=='string')return null;
 const subject=String.raw`(?<subject>[^“”\r\n]{1,256})`;
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
  let messageLength=m[0].length;
  const pendingSuffix=' O incidente de rota permanece aberto; o funcionamento dos comandos não está comprovado.';
  if(code==='zigbee_component_recovery_notice'&&message.slice(messageLength).startsWith(pendingSuffix)){
   codes.push('zigbee_component_recovery_route_pending');messageLength+=pendingSuffix.length;
  }
  return {titleLength:t[0].length,messageLength,titleCodes:[code],messageCodes:codes,privateSubject,subject:g.subject||null};
 }
 return null;
}
// Identification is separate from message rendering and never authorizes an effect.
function safeZigbeeName(value){
 if(typeof value!=='string'||value.length<1||value.length>96||value.normalize('NFC')!==value||value.trim()!==value||!/[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(value)||!/^[A-Za-zÀ-ÖØ-öø-ÿ0-9 _/-]+$/u.test(value))return false;
 const tokens=value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/[ _/-]+/);
 return tokens.length<=8&&tokens.filter(x=>/[0-9]/.test(x)).length<=2&&tokens.every(x=>C.zigbee_target_policy.name_tokens.includes(x)||/^(?:andar)?[0-9]{1,2}$/.test(x));
}
function zigbeeProducerId(subject,kind){
 const rule=C.zigbee_target_policy.kinds[kind];if(!rule)return null;
 let hash=0x811c9dc5;for(const byte of Buffer.from(subject,'utf8')){hash^=byte;hash=Math.imul(hash,0x01000193)>>>0;}
 const slug=subject.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
 return rule.prefix+(slug||(kind.startsWith('zigbee_component_')?'component':'device'))+'_'+hash.toString(16).padStart(8,'0')+rule.suffix;
}
function zigbeeTarget(notificationId,title,message){
 if(typeof notificationId!=='string'||typeof title!=='string'||typeof message!=='string'||title.length>128||message.length>4096||/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(title+message)||title.startsWith('TESTE'))return null;
 const reviewed=zigbeeTemplate(title,message);
 if(!reviewed?.privateSubject||reviewed.titleLength!==title.length||reviewed.messageLength!==message.length||!reviewed.subject||['desconhecido','desconhecida','unknown','n/a'].includes(reviewed.subject.toLowerCase()))return null;
 const kind=reviewed.titleCodes[0];
 if(zigbeeProducerId(reviewed.subject,kind)!==notificationId)return null;
 return {schema_version:1,kind,friendly_name:safeZigbeeName(reviewed.subject)?reviewed.subject:null};
}
module.exports={zigbeeTarget,safeZigbeeName,zigbeeProducerId};
