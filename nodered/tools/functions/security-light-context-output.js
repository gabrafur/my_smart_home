const data = msg._light_context;
return [data.lifecycle_message ?? null, data.reconcile ?? null, data.replay ?? null];
