// Internal subprocess port. Parent supplies private inherited FDs, never MCP args.
// No installed entrypoint, sudo rule, network listener or registration is added.
const fs=require('node:fs'),net=require('node:net');
const {NodeRedWorker,FixedNodeRedClient,ReceiptStore}=require('./nodered_effect.cjs');
const need=(v,r)=>{if(!v)throw Error(r);};
function descriptor(name){const value=process.env[name];need(typeof value==='string'&&/^[0-9]{1,4}$/.test(value),'inherited_descriptor_required');const n=Number(value);need(n>=3&&n<1024,'inherited_descriptor_refused');return n;}
function admissionPort(fd){
 const socket=new net.Socket({fd,readable:true,writable:true});let buffer='',sequence=0,pending=null;
 function fail(){if(pending){clearTimeout(pending.timer);pending.reject(Error('protected_admission_unconfirmed'));pending=null;}socket.destroy();}
 socket.setEncoding('utf8');socket.on('error',fail);socket.on('end',fail);
 socket.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>8192){fail();return;}
  const newline=buffer.indexOf('\n');if(newline<0)return;
  try{
   const row=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);need(pending&&buffer===''&&row.version===1&&row.sequence===sequence&&typeof row.ok==='boolean','admission_reply_shape');
   const wait=pending;pending=null;clearTimeout(wait.timer);
   if(row.ok===true&&row.grant&&typeof row.grant==='object')wait.resolve(row.grant);else wait.reject(Error('protected_admission_refused'));
  }catch{fail();}
 });
 return {check:binding=>new Promise((resolve,reject)=>{
  need(!pending&&sequence<2,'admission_request_limit');sequence++;const body=JSON.stringify({version:1,sequence,binding})+'\n';need(Buffer.byteLength(body)<=4096,'admission_request_limit');
  const timer=setTimeout(fail,10000);pending={resolve,reject,timer};socket.write(body);
 }),close:()=>{if(pending)fail();else socket.destroy();}};
}
async function main(){
 need(process.argv.length===2,'fixed_subprocess_arguments');const authFd=descriptor('COMPONENT_AUTH_FD'),admissionFd=descriptor('COMPONENT_ADMISSION_FD');need(authFd!==admissionFd,'inherited_descriptor_collision');
 const authRaw=fs.readFileSync(authFd);fs.closeSync(authFd);need(authRaw.length<=8192,'operator_binding_limit');const operator=JSON.parse(authRaw.toString('utf8'));authRaw.fill(0);
 need(operator&&Object.keys(operator).sort().join(',')==='authentication,state_folder'&&typeof operator.state_folder==='string','operator_binding_shape');
 const raw=fs.readFileSync(0);need(raw.length<=1048576+8192,'prepared_input_limit');const request=JSON.parse(raw.toString('utf8'));need(request&&Object.keys(request).sort().join(',')==='action,prepared'&&['apply','rollback'].includes(request.action),'prepared_input_shape');
 const port=admissionPort(admissionFd);
 try{
  const client=new FixedNodeRedClient(operator.authentication);operator.authentication=null;
  const worker=new NodeRedWorker({client,store:new ReceiptStore(operator.state_folder,request.action),purpose:request.action,admission:port.check});
  const result=await worker.execute(request.prepared);process.stdout.write(JSON.stringify(result)+'\n');
 }finally{port.close();}
}
if(require.main===module)main().catch(()=>{process.stdout.write(JSON.stringify({state:'uncertain',collection_error:'fixed_worker_entry_unconfirmed',executor_terminal:false,receipt_verified:false,automatic_retry:false})+'\n');process.exitCode=1;});
