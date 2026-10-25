// Only persistent notifications, not mobile messages or arbitrary HA events.
// No raw title/body is exported: known operational categories have fixed labels.
const {createHash}=require('node:crypto');
const {sanitizeContent}=require('./content_sanitizer.cjs');
const kinds=[['external','Iluminação externa'],['backup','Backup'],['global_observer','Observador de automações'],['smart_home_proactive_test','TESTE de observabilidade']];
const exactIds=new Map([['git_backup_failure',['backup','Backup']],['proactive_native_events_acceptance_20261023',['smart_home_proactive_test','TESTE de observabilidade']]]);
function iso(value){const t=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(t)?new Date(t).toISOString():null;}
function sanitize(notification,observedAt){
 if(!notification||typeof notification.notification_id!=='string'||notification.notification_id.length>512)return null;
 const rawId=notification.notification_id;
 const id=createHash('sha256').update(rawId).digest('hex');
 const exact=exactIds.get(rawId);
 const match=kinds.find(([prefix])=>rawId===prefix||rawId.startsWith(prefix+'_'));
 const text=String(notification.title||'')+' '+String(notification.message||'');
 const diagnostic=/security_scan_failed/.test(text)?['backup','Backup recusado pela verificação de segurança']:
  /iCloud/i.test(text)&&/autentica|auth|verifica|verification/i.test(text)?['icloud_auth','iCloud requer atenção à autenticação']:null;
 return {id,source:'homeassistant.persistent_notification',observed_at:observedAt,
  created_or_updated_at:iso(notification.created_at),origin:'not_provided_by_HA',
  category:exact?.[0]||match?.[0]||diagnostic?.[0]||'unclassified',summary:exact?.[1]||match?.[1]||diagnostic?.[1]||'Notificação persistente; conteúdo não exportado',
  category_basis:exact?'identifier_exact':match?'identifier_prefix':diagnostic?'untrusted_text_pattern':'unknown',
  diagnostics:sanitizeContent(notification.title,notification.message),
  content_withheld:true,destination_delivery:'not_applicable',collection_error:null};
}
function view(notifications,now=new Date().toISOString()){
 if(!Array.isArray(notifications)||notifications.length>512)throw new Error('invalid_snapshot');
 return {source:'HA WebSocket persistent_notification/get',observed_at:now,
  coverage:['current_persistent_notifications','no_notify_delivery_receipts','no_inbox_or_phone_messages'],
  notifications:notifications.map(n=>sanitize(n,now)).filter(Boolean),collection_error:null,
  mutations_performed:false};
}
module.exports={sanitize,view};
