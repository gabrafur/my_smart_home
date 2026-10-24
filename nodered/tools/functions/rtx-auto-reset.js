const test = msg.test_mode === true || msg._rtx_test === true;
flow.set(test ? 'rtx_auto_lifecycle_test' : 'rtx_auto_lifecycle_v1', {
    attempts:0,first_failure_at:Number(msg.rtx_now)||Date.now(),pending:false,blocked:false,last_attempt_at:0,
}, test ? undefined : 'persistent');
node.status({fill:'green',shape:'dot',text:'Endpoint confirmado; orçamento de reparo restaurado'});
return null;
