import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const cardSource = readFileSync(new URL('../www/codex-chat-card-v2.js', import.meta.url), 'utf8');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function createRuntime(storage = memoryStorage(), { storageThrows = false } = {}) {
  const registry = new Map();
  class FakeHTMLElement {
    constructor() {
      this.isConnected = false;
      this.styleValues = new Map();
      this.style = { setProperty: (name, value) => this.styleValues.set(name, value) };
    }

    attachShadow() {
      this.shadowRoot = { activeElement: null, querySelector: () => null };
      return this.shadowRoot;
    }

    getBoundingClientRect() { return { top: 56 }; }
  }
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const window = {
    ...listeners,
    customCards: [],
    confirm: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => { callback(); return 1; },
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ maxHeight: '140px' }),
    visualViewport: { ...listeners, height: 500, offsetTop: 0 },
  };
  if (storageThrows) Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  else window.localStorage = storage;
  const context = vm.createContext({
    console,
    document: { ...listeners, visibilityState: 'visible' },
    HTMLElement: FakeHTMLElement,
    customElements: {
      define: (name, constructor) => registry.set(name, constructor),
      get: (name) => registry.get(name),
    },
    window,
  });
  vm.runInContext(cardSource, context, { filename: 'codex-chat-card-v2.js' });
  return { Card: registry.get('codex-chat-card-v2'), storage, window };
}

function attachCard(runtime, userId, callWS = async () => ({})) {
  const card = new runtime.Card();
  card.render = () => {};
  card._hass = { user: { id: userId, name: `User ${userId}` }, callWS };
  card.attachChatState();
  card.state.historyLoaded = true;
  return card;
}

function expectedKey(userId) {
  const conversationId = `home-assistant:codex:${userId}`;
  return `codex-chat-card-state:v1:user:${encodeURIComponent(userId)}:assistant:codex:chat:${encodeURIComponent(conversationId)}`;
}

test('persists validated settings and draft per user and conversation across a module reload', () => {
  const storage = memoryStorage();
  const firstRuntime = createRuntime(storage);
  const firstCard = attachCard(firstRuntime, 'resident-a');
  firstCard.updateDraft('rascunho privado\ncom duas linhas');
  firstCard.updateModel('gpt-5.6-terra');
  firstCard.updateReasoning('ultra');
  firstCard.flushDraft();

  const stored = JSON.parse(storage.getItem(expectedKey('resident-a')));
  assert.deepEqual(stored, {
    version: 1,
    model: 'gpt-5.6-terra',
    reasoning: 'ultra',
    draft: 'rascunho privado\ncom duas linhas',
  });

  const reloadedRuntime = createRuntime(storage);
  const restored = attachCard(reloadedRuntime, 'resident-a');
  assert.equal(restored.state.draft, 'rascunho privado\ncom duas linhas');
  assert.deepEqual({ ...restored.state.settings }, { model: 'gpt-5.6-terra', reasoning: 'ultra' });

  const otherChat = attachCard(reloadedRuntime, 'resident-b');
  assert.equal(otherChat.state.draft, '');
  assert.deepEqual({ ...otherChat.state.settings }, { model: 'gpt-5.6-luna', reasoning: 'low' });
});

test('repairs missing models, incompatible reasoning, and corrupt storage deterministically', () => {
  const storage = memoryStorage();
  storage.setItem(expectedKey('removed-model'), JSON.stringify({
    version: 1,
    model: 'gpt-removed',
    reasoning: 'high',
    draft: 'preservar',
  }));
  storage.setItem(expectedKey('bad-reasoning'), JSON.stringify({
    version: 1,
    model: 'gpt-5.6-luna',
    reasoning: 'ultra',
    draft: '',
  }));
  storage.setItem(expectedKey('corrupt'), '{not-json');
  const runtime = createRuntime(storage);

  const removed = attachCard(runtime, 'removed-model');
  assert.deepEqual({ ...removed.state.settings }, { model: 'gpt-5.6-luna', reasoning: 'high' });
  assert.equal(removed.state.draft, 'preservar');
  assert.equal(JSON.parse(storage.getItem(expectedKey('removed-model'))).model, 'gpt-5.6-luna');

  const incompatible = attachCard(runtime, 'bad-reasoning');
  assert.deepEqual({ ...incompatible.state.settings }, { model: 'gpt-5.6-luna', reasoning: 'low' });
  assert.equal(storage.getItem(expectedKey('bad-reasoning')), null);

  const corrupt = attachCard(runtime, 'corrupt');
  assert.deepEqual({ ...corrupt.state.settings }, { model: 'gpt-5.6-luna', reasoning: 'low' });
  assert.equal(storage.getItem(expectedKey('corrupt')), null);
});

test('uses displayed settings in the request and keeps the draft after failure', async () => {
  const runtime = createRuntime();
  const payloads = [];
  let shouldFail = true;
  const card = attachCard(runtime, 'send-failure', async (payload) => {
    payloads.push(payload);
    if (shouldFail) throw new Error('synthetic backend failure');
    return { reply: 'ok', model: payload.model, reasoning_effort: payload.reasoning_effort };
  });
  card.updateModel('gpt-5.6-terra');
  card.updateReasoning('ultra');
  card.updateDraft('  tente novamente  ');

  await card.send();
  assert.equal(card.state.draft, '  tente novamente  ');
  assert.equal(card.state.loading, false);
  assert.deepEqual(
    { text: payloads[0].text, model: payloads[0].model, reasoning: payloads[0].reasoning_effort },
    { text: 'tente novamente', model: 'gpt-5.6-terra', reasoning: 'ultra' },
  );

  shouldFail = false;
  await card.send();
  assert.equal(card.state.draft, '');
  assert.deepEqual({ ...card.state.settings }, { model: 'gpt-5.6-terra', reasoning: 'ultra' });
  card.flushDraft();
});

test('does not erase a newer draft when an older in-flight send finishes after remount', async () => {
  const runtime = createRuntime();
  let accept;
  const response = new Promise((resolve) => { accept = resolve; });
  const first = attachCard(runtime, 'in-flight', async () => response);
  first.updateDraft('mensagem enviada');
  const pending = first.send();

  const remounted = attachCard(runtime, 'in-flight');
  assert.equal(remounted.state, first.state);
  assert.equal(remounted.state.loading, true);
  remounted.updateDraft('rascunho mais recente');
  accept({ reply: 'aceita', model: 'gpt-5.6-luna', reasoning_effort: 'low' });
  await pending;

  assert.equal(remounted.state.draft, 'rascunho mais recente');
  assert.equal(remounted.state.loading, false);
  remounted.flushDraft();
});

test('renders shared state when the Home Assistant user arrives after mount', () => {
  const runtime = createRuntime();
  const first = attachCard(runtime, 'late-user');
  first.state.messages.push({ role: 'assistant', text: 'histórico preservado' });
  first.updateDraft('rascunho preservado');
  first.updateModel('gpt-5.6-terra');
  first.updateReasoning('ultra');
  first.flushDraft();

  const remounted = new runtime.Card();
  const snapshots = [];
  remounted.isConnected = true;
  remounted.render = () => snapshots.push({
    draft: remounted.state.draft,
    model: remounted.state.settings.model,
    reasoning: remounted.state.settings.reasoning,
    messages: remounted.state.messages.length,
  });
  remounted.setConfig({ title: 'Codex' });
  remounted.hass = { user: { id: 'late-user', name: 'User late-user' }, callWS: async () => ({}) };

  assert.equal(remounted.state, first.state);
  assert.deepEqual(snapshots.at(-1), {
    draft: 'rascunho preservado',
    model: 'gpt-5.6-terra',
    reasoning: 'ultra',
    messages: 1,
  });
});

test('recovers from a synchronous WebSocket failure without leaving request state stuck', async () => {
  const runtime = createRuntime();
  const card = attachCard(runtime, 'synchronous-failure', () => { throw new Error('socket unavailable'); });
  card.updateDraft('preservar depois da exceção');

  await card.send();

  assert.equal(card.state.loading, false);
  assert.equal(card.state.requestPromise, null);
  assert.equal(card.state.draft, 'preservar depois da exceção');
  assert.match(card.state.messages.at(-1).text, /socket unavailable/);
  card.flushDraft();
});

test('model compatibility and explicit clear reset only the current chat', async () => {
  const storage = memoryStorage();
  const runtime = createRuntime(storage);
  const calls = [];
  const card = attachCard(runtime, 'clear-current', async (payload) => { calls.push(payload); return {}; });
  const other = attachCard(runtime, 'keep-other');
  other.updateDraft('não remover');
  other.flushDraft();
  card.updateModel('gpt-5.6-terra');
  card.updateReasoning('ultra');
  card.updateDraft('remover');
  card.state.messages.push({ role: 'user', text: 'histórico' });
  card.flushDraft();

  card.updateModel('gpt-5.6-luna');
  assert.deepEqual({ ...card.state.settings }, { model: 'gpt-5.6-luna', reasoning: 'low' });
  assert.equal(card.state.draft, 'remover');
  await card.clearChat();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'claude_code_chat/clear');
  assert.equal(card.state.messages.length, 0);
  assert.equal(card.state.draft, '');
  assert.deepEqual({ ...card.state.settings }, { model: 'gpt-5.6-luna', reasoning: 'low' });
  assert.equal(storage.getItem(expectedKey('clear-current')), null);
  assert.equal(JSON.parse(storage.getItem(expectedKey('keep-other'))).draft, 'não remover');
});

test('keeps working in memory when persistent storage is unavailable', () => {
  const runtime = createRuntime(undefined, { storageThrows: true });
  const card = attachCard(runtime, 'storage-blocked');
  card.updateDraft('somente em memória');
  card.updateModel('gpt-5.6-sol');
  card.updateReasoning('max');
  assert.equal(card.state.draft, 'somente em memória');
  assert.deepEqual({ ...card.state.settings }, { model: 'gpt-5.6-sol', reasoning: 'max' });
  assert.doesNotThrow(() => card.flushDraft());
});

test('visual viewport constrains the card above browser chrome or virtual keyboard', () => {
  const runtime = createRuntime();
  const card = attachCard(runtime, 'viewport');
  card.isConnected = true;
  card.scheduleViewportUpdate();
  assert.equal(card.styleValues.get('--codex-available-height'), '444px');
});
