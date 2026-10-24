const limits = { confirmation_seconds: [60,600], retry_seconds: [120,1800], max_attempts: [1,3], freshness_seconds: [60,120] };
const rule = limits[msg.topic];
const value = Number(msg.payload);
if (!rule || !Number.isInteger(value) || value < rule[0] || value > rule[1]) {
    node.status({fill:'red',shape:'ring',text:'Parâmetro rejeitado; último válido preservado'});
    return null;
}
const policy = flow.get('rtx_auto_policy_v1','persistent') || {};
policy[msg.topic] = value;
policy.complete = Object.keys(limits).every(k => Number.isFinite(policy[k]));
flow.set('rtx_auto_policy_v1',policy,'persistent');
return null;
