const token = env.get('BRIDGE_TOKEN');
if (!token) { msg.payload={outcome:'unknown',reason:'bridge_token_missing'}; return [null,msg]; }
msg.method='POST';
msg.url='http://ai-bridge:8099/local-ai/repair-proxy';
msg.headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
msg.payload={operation_id:msg.operation_id};
return [msg,null];
