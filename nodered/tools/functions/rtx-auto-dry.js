msg.payload={operation_id:msg.operation_id,outcome:'failed',reason:'dry_run',simulated:true,dispatched:false};
node.log('RTX_SAFE_PROXY_DRY_RUN '+JSON.stringify(msg.payload));
return msg;
