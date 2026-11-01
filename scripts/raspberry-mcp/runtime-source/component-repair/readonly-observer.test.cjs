// Parent executes serially; fake client only, no network or credentials.
const test=require('node:test'),assert=require('node:assert/strict');
const {observe}=require('./effects/nodered_observe.cjs');
const {normalizedIdentity}=require('./attestation_model.cjs');
const nodes=[{id:'host_observer_tab',type:'tab'},{id:'safe',z:'host_observer_tab',type:'function',func:'return msg;',wires:[[]]}];
const request={component_id:'observacao_host',operation_id:'a'.repeat(32),nonce:'b'.repeat(32),allowed_identities:[normalizedIdentity(nodes)]};
function client(){const calls=[];return {calls,async loginReadOnly(){calls.push('login_read');},async configuration(){calls.push('GET_flows');return {rev:'1'.repeat(64),flows:nodes};},async revoke(){calls.push('revoke');return true;},async deploy(){throw Error('must never deploy');}};}
test('readonly identity matches normalization and revokes',async()=>{const c=client(),r=await observe(request,c,()=>1000);assert.equal(r.state,'observed');assert.deepEqual(c.calls,['login_read','GET_flows','revoke']);assert(!JSON.stringify(r).includes('return msg'));});
test('unreviewed loaded identity withheld',async()=>{const c=client(),r=await observe({...request,allowed_identities:['0'.repeat(64)]},c);assert.equal(r.loaded_sha256,null);assert.equal(r.collection_error,'loaded_scope_not_reviewed');});
test('revocation uncertainty withholds healthy result',async()=>{const c=client();c.revoke=async()=>false;const r=await observe(request,c);assert.equal(r.state,'unknown');assert.equal(r.collection_error,'read_session_revocation_unconfirmed');});
test('closed request rejects injected path or runtime source',async()=>{await assert.rejects(observe({...request,path:'/tmp/free'},client()),/closed_observation_request/);});
