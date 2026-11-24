// A missing receipt is an answer, not a malformed request. Without this overlay the
// isError reply of codex_task_status reaches some clients as INVALID_ARGUMENT, and the
// assistant cannot tell a proven absence from a refusal. Everything else is unchanged.
const ABSENT = new Map([['task_not_found', 'creation'], ['send_not_found', 'turn']]);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
export function absence(request, response) {
  const args = request?.params?.arguments;
  if (request?.method !== 'tools/call' || request.params?.name !== 'codex_task_status' || !plain(args)) return null;
  const content = response?.result?.content;
  if (response?.result?.isError !== true || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return null;
  // The reason must match the requested kind; anything else stays an error.
  if (ABSENT.get(content[0].text) !== args.kind) return null;
  return {state: 'absent', kind: args.kind, operation_id: args.operation_id, reason: content[0].text,
    source: 'task_control_retained_receipts', record_found: false, dispatch_proven: false,
    coverage: ['retained_adapter_receipts_only', 'not_proof_that_no_other_channel_acted'],
    new_task_authorized: false, automatic_retry: false,
    next_step: 'use_codex_task_list_to_find_registered_tasks_before_proposing_a_new_one', collection_error: null};
}
export function makeTaskAbsenceRoute(prior) {
  return async (request, ...rest) => {
    const response = await prior(request, ...rest);
    const value = absence(request, response);
    if (!value) return response;
    return {jsonrpc: '2.0', id: response.id, result: {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value, isError: false}};
  };
}
