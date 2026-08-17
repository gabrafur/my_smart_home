const CODEX_MODELS = Object.freeze({
  'gpt-5.6-luna': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-5.6-terra': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  'gpt-5.6-sol': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
});

const DEFAULT_REASONING_EFFORTS = Object.freeze([
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const DEFAULT_CODEX_OPTIONS = Object.freeze({
  model: 'gpt-5.6-terra',
  reasoningEffort: 'medium',
});

function normalizeOptional(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateCodexOptions({ model, reasoningEffort } = {}) {
  const normalizedModel = normalizeOptional(model) || DEFAULT_CODEX_OPTIONS.model;
  const normalizedReasoningEffort = normalizeOptional(reasoningEffort)
    || DEFAULT_CODEX_OPTIONS.reasoningEffort;

  if (normalizedModel && !Object.hasOwn(CODEX_MODELS, normalizedModel)) {
    throw new Error('unsupported Codex model');
  }

  const allowedEfforts = CODEX_MODELS[normalizedModel] || DEFAULT_REASONING_EFFORTS;
  if (normalizedReasoningEffort && !allowedEfforts.includes(normalizedReasoningEffort)) {
    throw new Error('unsupported reasoning effort for selected model');
  }

  return { model: normalizedModel, reasoningEffort: normalizedReasoningEffort };
}

function codexSessionKey(conversationId, options) {
  if (!conversationId) return null;
  const { model, reasoningEffort } = validateCodexOptions(options);
  return `codex:${conversationId}:model=${model}:reasoning=${reasoningEffort}`;
}

function codexExecOptions(options) {
  const { model, reasoningEffort } = validateCodexOptions(options);
  const args = ['--disable', 'apps'];
  if (model) args.push('--model', model);
  if (reasoningEffort) args.push('--config', `model_reasoning_effort="${reasoningEffort}"`);
  return args;
}

module.exports = {
  CODEX_MODELS,
  DEFAULT_REASONING_EFFORTS,
  DEFAULT_CODEX_OPTIONS,
  validateCodexOptions,
  codexSessionKey,
  codexExecOptions,
};
