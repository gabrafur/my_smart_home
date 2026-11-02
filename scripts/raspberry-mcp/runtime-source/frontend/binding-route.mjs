// Uninstalled compatible extension. Preserves all existing tool annotations.
export const tools = ['admin_action_apply', 'admin_action_status', 'admin_action_reconcile', 'admin_action_revoke'];
export const actions = ['nodered_plan_reader_binding', 'nodered_apply_reader_binding',
  'nodered_plan_restore_reader_binding', 'nodered_restore_reader_binding', 'nodered_revoke_reader_binding'];
const allowedActions = tool => tool === 'admin_action_revoke'
  ? ['nodered_revoke_reader_binding'] : actions.filter(action => action !== 'nodered_revoke_reader_binding');

export function valid(tool, args) {
  return tools.includes(tool) && args && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).sort().join() === 'action,host,idempotency_key'
    && args.host === 'raspberry' && allowedActions(tool).includes(args.action)
    && typeof args.idempotency_key === 'string' && /^nodered-peer-[a-f0-9]{32}$/.test(args.idempotency_key);
}

export function makeBindingRoute(prior, invoke, dispatch, audit = () => {}) {
  return async request => {
    const name = request?.params?.name, args = request?.params?.arguments;
    if (request?.method === 'tools/call' && tools.includes(name)
        && typeof args?.action === 'string' && args.action.startsWith('nodered_')) {
      if (!valid(name, args)) return {jsonrpc: '2.0', id: request.id,
        result: {isError: true, content: [{type: 'text', text: 'nodered_binding_scope_refused'}]}};
      // Same bounded dispatch/audit boundary as the existing storage extension.
      // The original action reaches its closed broker, never project_files.
      return dispatch({...request, params: {...request.params, name: 'project_files'}}, undefined,
        row => audit({...row, tool: name}), () => invoke(request.params));
    }
    const response = await prior(request);
    if (request?.method === 'tools/list') for (const descriptor of response?.result?.tools ?? []) {
      if (!tools.includes(descriptor.name) || descriptor.inputSchema?.type !== 'object') continue;
      const original = structuredClone(descriptor.inputSchema);
      descriptor.inputSchema = {type: 'object', oneOf: [original, {
        type: 'object', additionalProperties: false,
        properties: {host: {const: 'raspberry'}, action: {enum: allowedActions(descriptor.name)},
          idempotency_key: {type: 'string', pattern: '^nodered-peer-[a-f0-9]{32}$'}},
        required: ['host', 'action', 'idempotency_key']}]};
      descriptor.description = (descriptor.description ?? '')
        + ' Limited Node-RED reader binding: fresh preview before one derived return-peer change or own restore;'
        + ' fixed reviewed Compose service, existing listener and network; current instance pinned in each preview.'
        + ' No shell, restart, device command, automatic retry'
        + ' or server scheduling. Status and reconcile observe stored results.'
        + ' Revoke disables only this fixed catalogue and preserves receipts; it does not reactivate or reset quotas.'
        + ' Client event authority is separately discoverable and requires specific owner approval.'
        + ' Existing interface approvals remain required.';
    }
    return response;
  };
}
