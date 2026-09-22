import fs from "node:fs";

// Append independent diagnostics branches; notification and safety gates stay canonical.
export function installGlobalDiagnostics(nodes, existing = []) {
  const tab = "global_flow_observer_tab", group = "global_observer_diagnostic_group";
  const source = name => fs.readFileSync(new URL(`functions/${name}.js`, import.meta.url), "utf8").trimEnd();
  const add = node => { nodes.push({z:tab,g:group,...node}); nodes.find(n=>n.id===group).nodes.push(node.id); };
  const fn = (id,name,file,x,y,wires,outputs=1) => add({id,type:"function",name,func:source(file),outputs,timeout:0,noerr:0,initialize:"",finalize:"",libs:[],x,y,wires});
  nodes.push({id:group,type:"group",z:tab,name:"Diagnóstico detalhado — registrar antes do dedupe; TESTE somente em memória",style:{label:true,color:"#0891b2"},nodes:[],x:64,y:1700,w:2820,h:440});
  for (const [origin, sources, y] of [
    ["catch",["global_observer_events_in","global_observer_internal_catch","global_observer_notification_catch"],1780],
    ["dispatch",["global_observer_alert_to_dispatch_in"],1870]
  ]) {
    const incoming = `global_observer_diagnostic_${origin}_in`;
    const outs = [];
    for (const id of sources) {
      const parent=nodes.find(n=>n.id===id), out=id+"_diagnostic_out";
      parent.wires[0].push(out); outs.push(out);
      const anchor=existing.find(n=>n.id===id) ?? parent;
      nodes.push({id:out,type:"link out",z:tab,g:parent.g,name:`${origin}: ${parent.name} → diagnóstico`,mode:"link",links:[incoming],x:anchor.x+120,y:anchor.y+55,wires:[]});
      nodes.find(n=>n.id===parent.g).nodes.push(out);
    }
    add({id:incoming,type:"link in",name:`Receber ${origin} para registro`,links:outs,x:140,y,wires:[[incoming+"_tag"]]});
    add({id:incoming+"_tag",type:"change",name:`Origem: ${origin}`,rules:[{t:"set",p:"_observer_diagnostic_origin",pt:"msg",to:origin,tot:"str"}],x:320,y,wires:[["global_observer_diagnostic_build"]]});
  }
  fn("global_observer_diagnostic_build","Preservar causa, stack e retorno; remover credenciais","global-flow-observer-diagnostic-build",650,1810,[["global_observer_diagnostic_test_gate"]]);
  Object.assign(nodes.find(n=>n.id==="global_observer_diagnostic_build"), {
    libs:[{var:"fs",module:"fs"}],
    initialize:'fs.mkdirSync("/data/failure-history", {recursive:true,mode:0o700});\nfs.chmodSync("/data/failure-history", 0o700);'
  });
  add({id:"global_observer_diagnostic_test_gate",type:"switch",name:"Diagnóstico de TESTE?",property:"_observer_diagnostic_test",propertyType:"msg",rules:[{t:"true"},{t:"else"}],checkall:"true",repair:false,outputs:2,x:1000,y:1810,wires:[["global_observer_diagnostic_dry"],["global_observer_diagnostic_file"]]});
  fn("global_observer_diagnostic_dry","TESTE FINAL: registro simulado","global-flow-observer-diagnostic-dry",1340,1760,[],0);
  add({id:"global_observer_diagnostic_file",type:"file",name:"EFEITO: anexar causa ao histórico privado",filename:"filename",filenameType:"msg",appendNewline:true,createDir:true,overwriteFile:"false",encoding:"utf8",x:1340,y:1860,wires:[["global_observer_diagnostic_ack"]]});
  add({id:"global_observer_diagnostic_ack",type:"function",name:"Registro gravado",func:'node.status({fill:"green",shape:"dot",text:"causa detalhada gravada"});\nreturn null;',outputs:0,libs:[],x:1660,y:1860,wires:[]});
  add({id:"global_observer_diagnostic_tick",type:"inject",name:"Retenção: diariamente",props:[{p:"payload"}],repeat:"86400",crontab:"",once:true,onceDelay:"2",payloadType:"date",x:270,y:2030,wires:[["global_observer_diagnostic_retention"]]});
  fn("global_observer_diagnostic_retention","Ler retenção da política visual (1–30 dias)","global-flow-observer-diagnostic-retention",650,2030,[["global_observer_diagnostic_purge"]]);
  add({id:"global_observer_diagnostic_purge",type:"exec",name:"Remover somente histórico vencido",command:"node /data/tools/purge-failure-history.mjs",addpay:"payload",append:"",useSpawn:"false",timer:"30",winHide:false,oldrc:false,x:1050,y:2030,wires:[[],[],["global_observer_diagnostic_purge_result"]]});
  add({id:"global_observer_diagnostic_purge_result",type:"function",name:"Verificar retenção",func:'if (Number(msg.payload?.code ?? msg.payload) !== 0) node.warn("NODERED_FAILURE_HISTORY_PURGE_FAILED");\nreturn null;',outputs:0,libs:[],x:1420,y:2030,wires:[]});
  add({id:"global_observer_diagnostic_catch",type:"catch",name:"Falha ao registrar — sem recursão",scope:["global_observer_diagnostic_build","global_observer_diagnostic_file","global_observer_diagnostic_purge"],uncaught:false,x:2060,y:1780,wires:[["global_observer_diagnostic_failure"]]});
  add({id:"global_observer_diagnostic_failure",type:"function",name:"Fallback: erro do registro no log do runtime",func:'node.warn("NODERED_FAILURE_HISTORY_WRITE_FAILED " + String(msg.error?.message ?? "unknown").slice(0, 2000));\nreturn null;',outputs:0,libs:[],x:2520,y:1780,wires:[]});
  add({id:"global_observer_diagnostic_comment",type:"comment",name:"TESTE: reset → erro repetido → status → avaliar; conferir registro simulado",info:"Todos os catches são gravados, inclusive erros repetidos e suprimidos. Status confirmados e alertas de domínio são registrados na entrada do dispatch. Histórico JSONL privado em /data/failure-history, retenção pela política error_retention_days. Campos ausentes permanecem null; campos acima de 20.000 caracteres e cadeias acima de oito causas declaram truncamento. Não serializa msg inteiro. Falha no próprio escritor segue somente ao log do runtime.",x:2160,y:2030,wires:[]});
}
