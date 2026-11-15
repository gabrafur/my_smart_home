'use strict';
// Private diagnostic text, never a public projection or an execution policy.
const {createHash}=require('node:crypto');
const MAX_TEXT_BYTES=262144;
const hash=value=>createHash('sha256').update(value).digest('hex');
const validTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const MARKER='[SEGREDO REMOVIDO]';
function plain(value){
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>MAX_TEXT_BYTES)throw Error('notification_text_limit_or_type');
 // Invalid surrogate pairs cannot be transported identically by Node/Python.
 for(let i=0;i<value.length;i++){
  const c=value.charCodeAt(i);
  if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw Error('invalid_text_encoding');}
  else if(c>=0xdc00&&c<=0xdfff)throw Error('invalid_text_encoding');
 }
 return value;
}
function protectSecrets(input,field){
 let text=plain(input);const redactions=[];
 const replace=(pattern,reason,render)=>{let count=0;text=text.replace(pattern,(...args)=>{count++;return render(...args);});if(count)redactions.push({field,reason,count});};
 // One forward scan, including unterminated keys. Repeated BEGIN markers
 // must not trigger quadratic backtracking over an untrusted body.
 const begin=/-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----/g;
 let start=0,parts=[],keys=0,match;
 while((match=begin.exec(text))!==null){
  const footer='-----END '+match[1]+'-----',end=text.indexOf(footer,begin.lastIndex);
  parts.push(text.slice(start,match.index),MARKER);keys++;
  start=end<0?text.length:end+footer.length;begin.lastIndex=start;
  if(end<0)break;
 }
 if(keys){parts.push(text.slice(start));text=parts.join('');redactions.push({field,reason:'private_key',count:keys});}
 replace(/^[ \t]*(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gim,
  'credential_header',match=>match.slice(0,match.indexOf(':')+1)+' '+MARKER);
 replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+=*/gi,'bearer_credential',()=> 'Bearer '+MARKER);
 replace(/(["']?(?:password|passwd|senha|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|otp|2fa|pin|verification[_-]?code)["']?[ \t]*[:=][ \t]*)(?!\[SEGREDO REMOVIDO\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]\r\n]+)/gi,
  'credential_value',(_,prefix)=>prefix+MARKER);
 replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,4096}@/gi,'url_userinfo',(_,scheme)=>scheme+MARKER+'@');
 replace(/(https?:\/\/(?:hc-ping\.com|ping\.healthchecks\.io)\/)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi,'ping_credential',(_,host)=>host+MARKER);
 replace(/\beyJ[A-Za-z0-9_-]{10,16384}\.[A-Za-z0-9_-]{10,16384}\.[A-Za-z0-9_-]{10,16384}\b/g,'signed_token',()=>MARKER);
 replace(/((?:\bOTP|\b2FA|\bPIN|verification code|c[oó]digo (?:de (?:autentica[çc][aã]o|verifica[çc][aã]o)|de uso [uú]nico))[ \t]*[:=]?[ \t]+)[0-9]{4,10}\b/gi,
  'authentication_code',(_,prefix)=>prefix+MARKER);
 return {text,redactions};
}
function projectPersistent(notification,observedAt){
 if(!notification||typeof notification!=='object'||Array.isArray(notification)||
    typeof notification.notification_id!=='string'||!notification.notification_id.length||notification.notification_id.length>512||
    !validTime(observedAt))throw Error('invalid_notification_identity_or_clock');
 const title=protectSecrets(notification.title??'','title');
 const message=protectSecrets(notification.message??'','message');
 const text={title:title.text,message:message.text};
 const bytes=Buffer.byteLength(JSON.stringify(text),'utf8');
 if(bytes>MAX_TEXT_BYTES)throw Error('notification_text_limit_or_type');
 return {schema_version:1,source:'homeassistant.persistent_notification.private_text',
  object_id:hash(notification.notification_id),observed_at:new Date(observedAt).toISOString(),
  source_occurred_at:validTime(notification.created_at)?new Date(notification.created_at).toISOString():null,
  content_digest:hash(JSON.stringify([text.title,text.message])),text,
  redacted_fields:[...title.redactions,...message.redactions],
  content_complete:true,complete_except_protected_secret_values:true,
  collection_error:null,content_bytes:bytes,mime_type:'text/plain',
  untrusted_source_text:true,execution_authority:false,
  coverage:['exact_persistent_notification_frame','full_title_and_message_except_credentials',
   'no_allowlist_of_diagnostic_sentences','not_all_household_notification_channels','not_recovery_or_execution_proof']};
}
module.exports={MAX_TEXT_BYTES,hash,plain,protectSecrets,projectPersistent};
