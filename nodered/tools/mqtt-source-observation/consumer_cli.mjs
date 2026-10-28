/* Fixed-path Node-RED metadata adapter. No shell, arbitrary paths or house effects. */
import {ConsumerStore,StoreInvalid} from './consumer_store.mjs';
import {ConsumerInvalid} from './consumer_state.mjs';
import {ReaderStatusInvalid} from './reader_status.mjs';
import {ProtocolInvalid} from './consumer_protocol.mjs';
import {decodeCommit,CheckpointInvalid} from './canvas_checkpoint.mjs';
import {pathToFileURL} from 'node:url';
const openDefault=ownOnly=>new ConsumerStore('/data/.mqtt-source-observer-consumer','/data/.mqtt-source-observer-report',
  {consumerUid:1000,consumerGid:1000,publisherUid:0,lockFd:8,ownOnly});
export function executeCommand(argv,{uid,gid,open=openDefault}={}){
let store,operation,canFallback=false;
try{
  if((uid??process.getuid())!==1000||(gid??process.getgid())!==1000)throw new StoreInvalid('consumer_role_mismatch');
  const [command,proposal,...extra]=argv;operation=command;
  if(extra.length||!['prepare','commit','snapshot','checkpoint-prepare','checkpoint-commit'].includes(operation)
      ||(['commit','checkpoint-commit'].includes(operation)?typeof proposal!=='string':proposal!==undefined))
    throw new StoreInvalid('consumer_command_invalid');
  canFallback=operation==='prepare';
  store=open(operation.startsWith('checkpoint-'));
  let value;
  if(canFallback){
    const facts=store.readerStatus();value={...store.prepare(),reader_facts:facts};
  }else if(operation==='commit'){
    const facts=store.readerStatus();
    if(facts.source_authorized!==true||!facts.clock_domain_matches||!facts.clock_ordered)
      throw new ReaderStatusInvalid('reader_not_authorized_or_clock_unknown');
    const candidate=decodeCommit(proposal);
    value=store.commit(candidate.proposal_sha,candidate.checkpoint);
  }else if(operation==='checkpoint-prepare')value=store.prepareCheckpoint();
  else if(operation==='checkpoint-commit'){
    const candidate=decodeCommit(proposal);value=store.commitCheckpoint(candidate.proposal_sha,candidate.checkpoint);
  }else value=
    {state:'snapshot',accounting:store.snapshot(),full24h_proven:false,all_event_latency_proven:false};
  return {value,exitCode:0};
}catch(error){
  const code=error instanceof StoreInvalid||error instanceof ConsumerInvalid||error instanceof ReaderStatusInvalid||error instanceof CheckpointInvalid?error.code:
    error instanceof ProtocolInvalid?'producer_report_invalid':'consumer_io_failed';
  let own=null;
  if(canFallback){
    store?.close();store=null;
    try{
      store=open(true);
      own=store.prepareCheckpoint();
    }catch{ /* Missing/corrupt own history remains absent; never bootstrap. */ }
  }
  const value={state:'unknown',collection_error:code,checkpoint_only:own,
    full24h_proven:false,all_event_latency_proven:false};
  // A valid negative envelope with an own-history proposal has been handled.
  // Exit zero prevents the exec return-code branch racing the stdout branch;
  // state/collection_error still explicitly describe source failure.
  return {value,exitCode:own===null?1:0};
}finally{store?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=executeCommand(process.argv.slice(2));
  console.log(JSON.stringify(result.value));process.exitCode=result.exitCode;
}
