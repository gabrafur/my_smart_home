const toolName = 'codex_task_find_incident';
const digest = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const properties = {host: {type: 'string', enum: ['raspberry']}, object_id: digest, revision: digest};
const descriptor = {
  name: toolName,
  description: 'Look up an exact incident object and revision in the Raspberry project task receipts, including retained history. A related task is for another revision of the same authenticated object. No daemon call, resume or send.',
  inputSchema: {type: 'object', properties, required: Object.keys(properties), additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};

const classifications = {
  invalid_request: ['invalid_parameters', 'invalid_task_identifier', 'invalid_task_kind',
    'invalid_operation_id', 'invalid_incident_identifier', 'task_request_byte_limit',
    'nodered_admin_parameters_refused'],
  access_denied: ['thread_out_of_scope', 'task_scope_refused', 'target_not_allowed',
    'control_lease_expired', 'control_observation_refused', 'control_scope_changed',
    'codex_control_disabled', 'task_identity_refused', 'control_identity_refused',
    'nodered_admin_identity_refused', 'nodered_admin_disabled'],
  unavailable: ['control_socket_changed', 'control_peer_changed', 'task_coordinator_busy',
    'metadata_closed_response_required', 'metadata_dependencies_changed_after_peer_start',
    'backend_ip_not_local_in_pinned_namespace', 'runtime_core_or_settings_drift',
    'isolated_core_context_review_incomplete', 'shared_lock_identity_changed',
    'nodered_admin_transport_unconfirmed', 'local_changes_detected', 'file_not_supported'],
};
const states = new Map(Object.entries(classifications).flatMap(([state, reasons]) =>
  reasons.map(reason => [reason, state])));
const observationTools = new Set([
  toolName, 'codex_task_status', 'codex_thread_read', 'codex_thread_status',
  'nodered_admin_read', 'project_read',
]);
const plainObject = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

function success(id, data) {
  return {jsonrpc: '2.0', id, result: {content: [{type: 'text', text: JSON.stringify(data)}],
    structuredContent: data}};
}

function diagnostic(name, reason) {
  const state = states.get(reason) ?? 'unknown';
  const safeReason = state === 'unknown' ? 'observation_unconfirmed' : reason;
  return {state, reason: safeReason, collection_error: safeReason, source: `mcp.${name}`,
    automatic_retry: false};
}

function validRequest(request) {
  const params = request.params;
  return plainObject(params) && request.jsonrpc === '2.0'
    && (Number.isSafeInteger(request.id) ||
        (typeof request.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(request.id)))
    && Object.keys(request).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key))
    && Object.keys(params).every(key => ['name', 'arguments', '_meta'].includes(key))
    && (!Object.hasOwn(params, '_meta') || plainObject(params._meta))
    && plainObject(params.arguments);
}

export function makeObservationRoute(prior, invoke, audit = () => {}, {incidentLookup = true} = {}) {
  return async request => {
    const name = request?.params?.name;
    if (request?.method === 'tools/call' && name === toolName && incidentLookup && validRequest(request)) {
      const args = request.params.arguments;
      if (Object.keys(args).length !== 3 || args.host !== 'raspberry' ||
          ![args.object_id, args.revision].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
        return success(request.id, diagnostic(name, 'invalid_incident_identifier'));
      }
      try {
        audit({tool: name, outcome: 'started'});
        const value = await invoke({name, arguments: args});
        audit({tool: name, outcome: 'ok'});
        return success(request.id, value);
      } catch (error) {
        audit({tool: name, outcome: 'rejected'});
        return success(request.id, diagnostic(name, error?.message));
      }
    }
    const response = await prior(request);
    if (request?.method === 'tools/list' && incidentLookup && Array.isArray(response?.result?.tools)) {
      response.result.tools.push(structuredClone(descriptor));
    }
    if (request?.method !== 'tools/call' || !observationTools.has(name) || !validRequest(request)) return response;
    const result = response?.result;
    const entry = result?.content?.[0];
    if (result?.isError === true && result.content?.length === 1 && entry?.type === 'text') {
      return success(response.id, diagnostic(name, entry.text));
    }
    // Some connectors treat the explicit isError field as a failed tool reply.
    // Use the same success envelope as a registered task receipt.
    if (name === 'codex_task_status' && result?.isError === false &&
        result.structuredContent?.state === 'absent') {
      return success(response.id, result.structuredContent);
    }
    return response;
  };
}
