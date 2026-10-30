// HA persistent-notice supplement. Shared Node-RED diagnostic parsing stays
// independent. Only fixed codes survive; no source text or numeric values.
const catalog=require('./operational_notice_templates.json');
const titles=new Map([
 ['Raspberry Pi - crescimento de storage','op_storage_growth_title'],
 ['Codex — pouca folga até o reset','op_codex_margin_low_title'],
 ['Codex — autonomia recuperada','op_codex_margin_recovered_title']
]);
const amount='[0-9]{1,3}(?:[.,][0-9]{1,2})?';
const bodies=new Map([
 ['op_storage_growth_title',new RegExp('^(?:⚠\\uFE0F? )?Storage crescendo rapidamente: \\+'+amount+' pp/24h, \\+'+amount+' pp/7d\\. Uso atual: '+amount+'% \\([0-9]{1,6}(?:[.,][0-9]{1,2})? GiB livres\\)\\. A limpeza segura foi solicitada automaticamente\\.$')],
 ['op_codex_margin_low_title',new RegExp('^(?:⚠\\uFE0F? )?Ritmo atual: '+amount+'%/dia\\. Uso projetado: '+amount+'%\\.$')],
 ['op_codex_margin_recovered_title',new RegExp('^(?:✅ )?O ritmo voltou a ser sustentável até o reset\\. Folga projetada: '+amount+'%\\.$')]
]);
const messages=new Map([
 ['op_storage_growth_title','op_storage_growth_requested'],
 ['op_codex_margin_low_title','op_codex_margin_low_forecast'],
 ['op_codex_margin_recovered_title','op_codex_margin_recovered_forecast']
]);
function supplement(diagnostic,title,message){
 const code=typeof title==='string'?titles.get(title):null;
 if(!code||!Object.hasOwn(catalog.fragments,code))return diagnostic;
 const complete=typeof message==='string'&&message.length<=1024&&bodies.get(code).test(message);
 const knownFields=new Set(complete?['title','message']:['title']);
 const result={...diagnostic,title_codes:[code],redacted_fields:diagnostic.redacted_fields.filter(row=>
  !(knownFields.has(row.field)&&row.reason==='non_allowlisted_text_may_contain_personal_data'))};
 if(complete){
  result.message_codes=[messages.get(code)];
  result.guidance_code=code==='op_storage_growth_title'?'op_check_storage_growth':'op_check_codex_capacity';
 }
 return result;
}
module.exports={supplement};
