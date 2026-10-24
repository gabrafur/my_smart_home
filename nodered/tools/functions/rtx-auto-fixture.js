msg.test_mode=true;
msg._rtx_test=true;
msg.rtx_now=Date.now();
msg.rtx_status={available:msg.payload==='healthy',state:msg.payload==='healthy'?'LOCAL_AI_AVAILABLE':'LOCAL_AI_UNAVAILABLE',checked_at:new Date(msg.rtx_now).toISOString()};
msg.rtx_host_entity={state:msg.payload==='offline'?'offline':'online',last_updated:new Date(msg.rtx_now).toISOString()};
if(msg.payload==='reset') { flow.set('rtx_auto_lifecycle_test',undefined);return null; }
// Advance only the isolated synthetic lifecycle to exercise the real visual gates.
if(msg.payload==='eligible') flow.set('rtx_auto_lifecycle_test',{attempts:0,pending:false,blocked:false,first_failure_at:msg.rtx_now-700000,last_attempt_at:0});
if(msg.payload==='exhausted') flow.set('rtx_auto_lifecycle_test',{attempts:3,pending:false,blocked:false,first_failure_at:msg.rtx_now-700000,last_attempt_at:0});
if(msg.payload==='unknown') flow.set('rtx_auto_lifecycle_test',{attempts:1,pending:false,blocked:true,first_failure_at:msg.rtx_now-700000,last_attempt_at:0});
return msg;
