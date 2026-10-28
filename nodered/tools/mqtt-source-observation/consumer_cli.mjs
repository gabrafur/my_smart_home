/* Fixed-path Node-RED metadata adapter. No shell, arbitrary paths or house effects. */
import {ConsumerStore,StoreInvalid} from './consumer_store.mjs';
import {ConsumerInvalid} from './consumer_state.mjs';
import {ReaderStatusInvalid} from './reader_status.mjs';
import {ProtocolInvalid} from './consumer_protocol.mjs';
let store;
try{
  if(process.getuid()!==1000||process.getgid()!==1000)throw new StoreInvalid('consumer_role_mismatch');
  const [operation,proposal,...extra]=process.argv.slice(2);
  if(extra.length||!['prepare','commit','snapshot'].includes(operation)
      ||(operation==='commit'?!/^[a-f0-9]{64}$/.test(proposal??''):proposal!==undefined))
    throw new StoreInvalid('consumer_command_invalid');
  store=new ConsumerStore('/data/.mqtt-source-observer-consumer','/data/.mqtt-source-observer-report',
    {consumerUid:1000,consumerGid:1000,publisherUid:0,lockFd:8});
  let value;
  if(operation==='prepare'){
    const facts=store.readerStatus();value={...store.prepare(),reader_facts:facts};
  }else if(operation==='commit'){
    const facts=store.readerStatus();
    if(facts.source_authorized!==true||!facts.clock_domain_matches||!facts.clock_ordered)
      throw new ReaderStatusInvalid('reader_not_authorized_or_clock_unknown');
    value=store.commit(proposal);
  }else value=
    {state:'snapshot',accounting:store.snapshot(),full24h_proven:false,all_event_latency_proven:false};
  console.log(JSON.stringify(value));
}catch(error){
  const code=error instanceof StoreInvalid||error instanceof ConsumerInvalid||error instanceof ReaderStatusInvalid?error.code:
    error instanceof ProtocolInvalid?'producer_report_invalid':'consumer_io_failed';
  console.log(JSON.stringify({state:'unknown',collection_error:code,full24h_proven:false,all_event_latency_proven:false}));
  process.exitCode=1;
}finally{store?.close();}
