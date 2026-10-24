const test = msg.test_mode === true || msg._rtx_test === true;
const key = test ? 'rtx_auto_lifecycle_test' : 'rtx_auto_lifecycle_v1';
const store = test ? undefined : 'persistent';
const previous = flow.get(key,store) || {};
let result = msg.payload;
if (typeof result === 'string') { try { result=JSON.parse(result); } catch { result={}; } }
const correlated = result?.operation_id === previous.operation_id || test;
const known = correlated && ['ready','failed'].includes(result?.outcome);
flow.set(key,{...previous,pending:false,blocked:!known,last_outcome:known ? result.outcome : 'unknown'},store);
// Never reset on command acceptance: only the subsequent fresh health observation does that.
msg.payload={operation_id:previous.operation_id,outcome:known?result.outcome:'unknown',reason:known?result.reason:'result_requires_reconciliation'};
node.status({fill:known&&result.outcome==='ready'?'green':'yellow',shape:'ring',text:msg.payload.reason});
node.log('RTX_SAFE_PROXY_RESULT '+JSON.stringify(msg.payload));
return test ? msg : null;
