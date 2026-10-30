// Extend the existing admin action family. Existing notice migration stays intact.
export const actions = ['npm_logs', 'npm_temporary'].flatMap(scope =>
  ['plan', 'quarantine', 'restore'].map(verb => `storage_${verb}_${scope}`))
  .concat('storage_revoke_cache_cleanup');
const tools = ['admin_action_apply', 'admin_action_status', 'admin_action_reconcile', 'admin_action_revoke'];
export function valid(tool, a) {
  return tools.includes(tool) && a && Object.keys(a).sort().join() === 'action,host,idempotency_key'
    && a.host === 'raspberry' && actions.includes(a.action)
    && typeof a.idempotency_key === 'string' && /^storage-[a-f0-9]{32}$/.test(a.idempotency_key)
    && (tool === 'admin_action_revoke') === (a.action === 'storage_revoke_cache_cleanup');
}
export function makeStorageRoute(prior, invoke, dispatch, audit = () => {}) {
  return async q => {
    const name = q?.params?.name, a = q?.params?.arguments;
    if (q?.method === 'tools/call' && tools.includes(name)
        && typeof a?.action === 'string' && a.action.startsWith('storage_')) {
      if (!valid(name, a)) return {jsonrpc: '2.0', id: q.id, result: {
        isError: true, content: [{type: 'text', text: 'storage_scope_refused'}]}};
      return dispatch({...q, params: {...q.params, name: 'project_files'}}, undefined,
        row => audit({...row, tool: name}), () => invoke(q.params));
    }
    const r = await prior(q);
    if (q?.method === 'tools/call' && name === 'disk_space' && !r?.result?.isError) {
      let extra;
      try {
        extra = await invoke({name: 'storage_metadata_read', arguments: {host: 'raspberry'}});
      } catch {
        extra = {storage_metadata_refresh: {state: 'unknown', source: 'fixed_storage_metadata_extension',
          observed_at: null, age_seconds: null, collection_error: 'storage_refresh_unavailable',
          coverage: ['legacy_filesystem_snapshot_preserved', 'no_cleanup']}};
      }
      const merge = value => value?.data && typeof value.data === 'object' && !Array.isArray(value.data)
        ? {...value, data: {...value.data, ...extra}} : value;
      if (r?.result?.structuredContent) r.result.structuredContent = merge(r.result.structuredContent);
      for (const item of r?.result?.content ?? []) if (item.type === 'text') {
        try {item.text = JSON.stringify(merge(JSON.parse(item.text)));} catch {/* Preserve the legacy error frame. */}
      }
    }
    if (q?.method === 'tools/list') for (const descriptor of r?.result?.tools ?? []) {
      if (!tools.includes(descriptor.name)) continue;
      const schema = descriptor.inputSchema;
      const original = structuredClone(schema);
      descriptor.inputSchema = {type: 'object', oneOf: [original, {type: 'object', additionalProperties: false,
        properties: {host: {const: 'raspberry'}, action: {enum: descriptor.name === 'admin_action_revoke'
          ? ['storage_revoke_cache_cleanup'] : actions.filter(x => x !== 'storage_revoke_cache_cleanup')},
          idempotency_key: {type: 'string', pattern: '^storage-[a-f0-9]{32}$'}},
        required: ['host', 'action', 'idempotency_key']}]};
      descriptor.description += ' Storage extension: plan before recoverable quarantine; fixed npm scopes only. No permanent deletion, free paths, shell, automatic retries or recurring schedule. Status and reconcile only observe recorded results.';
    }
    return r;
  };
}
