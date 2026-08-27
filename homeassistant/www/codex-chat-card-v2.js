const CARD_TAG = 'codex-chat-card-v2';
const MODELS = {
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

const REASONING_LABELS = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra' };
const STORAGE_VERSION = 1;
const STORAGE_PREFIX = `codex-chat-card-state:v${STORAGE_VERSION}`;
const DRAFT_DEBOUNCE_MS = 300;
const DEFAULT_SETTINGS = Object.freeze({ model: 'gpt-5.6-luna', reasoning: 'low' });
const CHAT_STATES = new Map();
const ACTIVE_CARDS = new Set();

function defaultSettings() { return { ...DEFAULT_SETTINGS }; }

function normalizeSettings(candidate = {}) {
  const model = Object.hasOwn(MODELS, candidate.model) ? candidate.model : DEFAULT_SETTINGS.model;
  const allowed = MODELS[model];
  const reasoning = allowed.includes(candidate.reasoning)
    ? candidate.reasoning
    : (allowed.includes(DEFAULT_SETTINGS.reasoning) ? DEFAULT_SETTINGS.reasoning : allowed[0]);
  return { model, reasoning };
}

function createChatState(persistent = {}) {
  return {
    settings: normalizeSettings(persistent.settings),
    draft: typeof persistent.draft === 'string' ? persistent.draft : '',
    messages: [],
    historyLoaded: false,
    historyPromise: null,
    loading: false,
    loadingStartedAt: null,
    requestPromise: null,
    clearing: false,
  };
}

class CodexChatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.state = createChatState();
    this.chatKey = null;
    this.config = {};
    this.draftSaveTimer = null;
    this.loadingTimer = null;
    this.viewportFrame = null;
    this.isComposing = false;
    this.pendingRenderOptions = null;
    this.ephemeralDraftChanged = false;
    this.ephemeralSettingsChanged = false;
    this.onPageHide = () => this.flushDraft();
    this.onVisibilityChange = () => { if (document.visibilityState === 'hidden') this.flushDraft(); };
    this.onViewportChange = () => this.scheduleViewportUpdate();
    this.onStorage = (event) => this.handleStorageChange(event);
  }

  setConfig(config) { this.config = config || {}; this.attachChatState(); this.render(); }

  set hass(hass) {
    const previousUserId = this._hass?.user?.id;
    this._hass = hass;
    if (previousUserId !== hass?.user?.id || !this.chatKey) {
      this.attachChatState();
      this.render();
    }
    if (!this.state.historyLoaded && !this.state.historyPromise) this.loadHistory();
    this.scheduleViewportUpdate();
  }

  getCardSize() { return 8; }

  get messages() { return this.state.messages; }

  set messages(messages) { this.state.messages = messages; }

  connectedCallback() {
    ACTIVE_CARDS.add(this);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('resize', this.onViewportChange, { passive: true });
    window.addEventListener('storage', this.onStorage);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.visualViewport?.addEventListener('resize', this.onViewportChange, { passive: true });
    window.visualViewport?.addEventListener('scroll', this.onViewportChange, { passive: true });
    this.attachChatState();
    if (this.state.loading) this.startLoadingFeedback();
    if (this._hass && !this.state.historyLoaded && !this.state.historyPromise) this.loadHistory();
    this.scheduleViewportUpdate();
  }

  disconnectedCallback() {
    ACTIVE_CARDS.delete(this);
    this.flushDraft();
    this.stopLoadingFeedback();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('storage', this.onStorage);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
    if (this.viewportFrame) window.cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = null;
  }

  conversationId() {
    const userId = this._hass?.user?.id;
    return userId ? `home-assistant:codex:${userId}` : null;
  }

  storageKey() {
    const userId = this._hass?.user?.id;
    const conversationId = this.conversationId();
    if (!userId || !conversationId) return null;
    return `${STORAGE_PREFIX}:user:${encodeURIComponent(userId)}:assistant:codex:chat:${encodeURIComponent(conversationId)}`;
  }

  getStorage() {
    try { return window.localStorage; } catch (_error) { return null; }
  }

  readPersistentState(key) {
    const storage = this.getStorage();
    if (!storage || !key) return { settings: defaultSettings(), draft: '', needsRepair: false };
    try {
      const raw = storage.getItem(key);
      if (!raw) return { settings: defaultSettings(), draft: '', needsRepair: false };
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== STORAGE_VERSION) return { settings: defaultSettings(), draft: '', needsRepair: true };
      const settings = normalizeSettings({ model: parsed.model, reasoning: parsed.reasoning });
      const draft = typeof parsed.draft === 'string' ? parsed.draft : '';
      const needsRepair = settings.model !== parsed.model || settings.reasoning !== parsed.reasoning || typeof parsed.draft !== 'string';
      return { settings, draft, needsRepair };
    } catch (_error) {
      return { settings: defaultSettings(), draft: '', needsRepair: true };
    }
  }

  attachChatState() {
    const key = this.storageKey();
    if (!key || key === this.chatKey) return;
    this.flushDraft();
    const ephemeralState = this.state;
    let sharedState = CHAT_STATES.get(key);
    if (!sharedState) {
      const persistent = this.readPersistentState(key);
      sharedState = createChatState(persistent);
      CHAT_STATES.set(key, sharedState);
      if (persistent.needsRepair) this.writePersistentState(key, sharedState);
    }
    if (!this.chatKey && this.ephemeralDraftChanged) sharedState.draft = ephemeralState.draft;
    if (!this.chatKey && this.ephemeralSettingsChanged) sharedState.settings = normalizeSettings(ephemeralState.settings);
    this.chatKey = key;
    this.state = sharedState;
    if (this.ephemeralDraftChanged || this.ephemeralSettingsChanged) this.persistState();
    this.ephemeralDraftChanged = false;
    this.ephemeralSettingsChanged = false;
  }

  writePersistentState(key, state) {
    const storage = this.getStorage();
    if (!storage || !key) return;
    const settings = normalizeSettings(state.settings);
    try {
      if (state.draft === '' && settings.model === DEFAULT_SETTINGS.model && settings.reasoning === DEFAULT_SETTINGS.reasoning) {
        storage.removeItem(key);
      } else {
        storage.setItem(key, JSON.stringify({ version: STORAGE_VERSION, model: settings.model, reasoning: settings.reasoning, draft: state.draft }));
      }
    } catch (_error) {
      // Storage may be disabled or full; live state remains authoritative for this page session.
    }
  }

  persistState() {
    if (!this.chatKey) return;
    this.state.settings = normalizeSettings(this.state.settings);
    this.writePersistentState(this.chatKey, this.state);
  }

  scheduleDraftSave() {
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => { this.draftSaveTimer = null; this.persistState(); }, DRAFT_DEBOUNCE_MS);
  }

  flushDraft() {
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
    const input = this.shadowRoot?.querySelector('textarea');
    if (input && (this.isComposing || this.shadowRoot.activeElement === input)) this.state.draft = input.value;
    this.persistState();
  }

  removePersistentState() {
    if (!this.chatKey) return;
    try { this.getStorage()?.removeItem(this.chatKey); } catch (_error) { /* live state is already clear */ }
  }

  handleStorageChange(event) {
    if (!this.chatKey || event.key !== this.chatKey || this.draftSaveTimer) return;
    const persistent = this.readPersistentState(this.chatKey);
    this.state.settings = persistent.settings;
    this.state.draft = persistent.draft;
    this.notifyState();
  }

  updateDraft(value) {
    this.state.draft = String(value ?? '');
    if (!this.chatKey) this.ephemeralDraftChanged = true;
    this.scheduleDraftSave();
  }

  updateModel(model) {
    this.state.settings = normalizeSettings({ model, reasoning: this.state.settings.reasoning });
    if (!this.chatKey) this.ephemeralSettingsChanged = true;
    this.persistState();
    this.notifyState();
  }

  updateReasoning(reasoning) {
    this.state.settings = normalizeSettings({ model: this.state.settings.model, reasoning });
    if (!this.chatKey) this.ephemeralSettingsChanged = true;
    this.persistState();
    this.notifyState();
  }

  allowedReasoning() { return MODELS[this.state.settings.model] || MODELS[DEFAULT_SETTINGS.model]; }

  async loadHistory() {
    if (!this._hass || this.state.historyLoaded) return;
    if (this.state.historyPromise) return this.state.historyPromise;
    const state = this.state;
    state.historyPromise = (async () => {
      try {
        const result = await this._hass.callWS({ type: 'claude_code_chat/history', limit: this.config?.history_limit || 200 });
        state.messages = (result.turns || []).flatMap((turn) => [
          { role: 'user', text: turn.prompt },
          { role: 'assistant', text: turn.reply },
        ]);
      } catch (error) {
        state.messages = [{ role: 'error', text: `Não foi possível carregar o histórico: ${error.message || error}` }];
      } finally {
        state.historyLoaded = true;
        state.historyPromise = null;
        this.notifyState({ forceScrollEnd: true });
      }
    })();
    this.notifyState();
    return state.historyPromise;
  }

  async send() {
    const state = this.state;
    const text = state.draft.trim();
    if (!text || state.loading || state.clearing || !state.historyLoaded) return;
    state.settings = normalizeSettings(state.settings);
    const sentDraft = state.draft;
    const sentSettings = { ...state.settings };
    state.messages.push({ role: 'user', text });
    state.loading = true;
    state.loadingStartedAt = Date.now();
    this.flushDraft();
    this.notifyState({ forceScrollEnd: true });
    const payload = { type: 'claude_code_chat/process', text, model: sentSettings.model, reasoning_effort: sentSettings.reasoning };
    try {
      state.requestPromise = this._hass.callWS(payload);
      const result = await state.requestPromise;
      state.messages.push({ role: 'assistant', text: result.reply });
      if (MODELS[result.model]?.includes(result.reasoning_effort)) {
        state.settings = { model: result.model, reasoning: result.reasoning_effort };
      }
      if (state.draft === sentDraft) state.draft = '';
      this.persistState();
    } catch (error) {
      state.messages.push({ role: 'error', text: `Erro ao enviar: ${error.message || error}` });
      this.persistState();
    } finally {
      state.requestPromise = null;
      state.loading = false;
      state.loadingStartedAt = null;
      this.notifyState({ focusComposer: true });
    }
  }

  hasConversationState() {
    const settings = normalizeSettings(this.state.settings);
    return this.state.messages.length > 0 || this.state.draft !== ''
      || settings.model !== DEFAULT_SETTINGS.model || settings.reasoning !== DEFAULT_SETTINGS.reasoning;
  }

  async clearChat() {
    const state = this.state;
    if (state.loading || state.clearing || !this.hasConversationState()) return;
    const confirmed = window.confirm('Apagar o histórico, o rascunho e as escolhas desta conversa? Esta ação não pode ser desfeita.');
    if (!confirmed) return;
    state.clearing = true;
    this.notifyState();
    try {
      await this._hass.callWS({ type: 'claude_code_chat/clear' });
      this.messages = [];
      state.settings = defaultSettings();
      state.draft = '';
      state.historyLoaded = true;
      this.removePersistentState();
    } catch (error) {
      state.messages.push({ role: 'error', text: `Não foi possível limpar a conversa: ${error.message || error}` });
    } finally {
      state.clearing = false;
      this.notifyState({ focusComposer: true, forceScrollEnd: true });
    }
  }

  loadingMessage() {
    const elapsed = Math.max(0, Math.floor((Date.now() - this.state.loadingStartedAt) / 1000));
    const duration = elapsed < 60 ? `${elapsed} s` : `${Math.floor(elapsed / 60)} min ${elapsed % 60} s`;
    if (elapsed < 10) return `Iniciando o Codex… ${duration}`;
    if (elapsed < 30) return `Codex está analisando o pedido… ${duration}`;
    return `Ainda trabalhando; tarefas complexas podem levar alguns minutos… ${duration}`;
  }

  updateLoadingFeedback() {
    const status = this.shadowRoot.querySelector('.typing');
    if (status && this.state.loadingStartedAt) status.textContent = this.loadingMessage();
  }

  startLoadingFeedback() {
    if (!this.state.loadingStartedAt) return;
    if (!this.loadingTimer) this.loadingTimer = window.setInterval(() => this.updateLoadingFeedback(), 1000);
    this.updateLoadingFeedback();
  }

  stopLoadingFeedback() {
    if (this.loadingTimer) window.clearInterval(this.loadingTimer);
    this.loadingTimer = null;
  }

  notifyState(options = {}) {
    let rendered = false;
    for (const card of ACTIVE_CARDS) {
      if (card.state !== this.state) continue;
      card.render({ ...options, focusComposer: Boolean(options.focusComposer && card === this) });
      if (this.state.loading) card.startLoadingFeedback();
      else card.stopLoadingFeedback();
      rendered = true;
    }
    if (!rendered && this.isConnected) this.render(options);
  }

  scheduleViewportUpdate() {
    if (this.viewportFrame) return;
    this.viewportFrame = window.requestAnimationFrame(() => {
      this.viewportFrame = null;
      const viewport = window.visualViewport;
      if (!viewport || !this.isConnected) return;
      const rect = this.getBoundingClientRect();
      const viewportBottom = viewport.offsetTop + viewport.height;
      const visibleTop = Math.max(rect.top, viewport.offsetTop);
      const availableHeight = Math.floor(viewportBottom - visibleTop);
      if (availableHeight > 0) this.style.setProperty('--codex-available-height', `${availableHeight}px`);
    });
  }

  captureDomState() {
    const feed = this.shadowRoot.querySelector('.feed');
    const input = this.shadowRoot.querySelector('textarea');
    if (input && !this.isComposing && this.shadowRoot.activeElement === input) this.state.draft = input.value;
    return {
      feedScrollTop: feed?.scrollTop || 0,
      feedNearEnd: !feed || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 80,
      inputFocused: Boolean(input && this.shadowRoot.activeElement === input),
      selectionStart: input?.selectionStart,
      selectionEnd: input?.selectionEnd,
    };
  }

  scrollToEnd() {
    window.requestAnimationFrame(() => {
      const feed = this.shadowRoot.querySelector('.feed');
      if (feed) feed.scrollTop = feed.scrollHeight;
    });
  }

  autoSizeTextarea(input = this.shadowRoot.querySelector('textarea')) {
    if (!input) return;
    input.style.height = 'auto';
    const maximum = Number.parseFloat(window.getComputedStyle(input).maxHeight) || 140;
    input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
    input.style.overflowY = input.scrollHeight > maximum ? 'auto' : 'hidden';
  }

  escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

  option(value, label, selected) { return `<option value="${this.escape(value)}"${selected ? ' selected' : ''}>${this.escape(label)}</option>`; }

  modelOptions() {
    return Object.keys(MODELS).map((model) => this.option(model, model, this.state.settings.model === model)).join('');
  }

  reasoningOptions() {
    return this.allowedReasoning().map((effort) => this.option(effort, REASONING_LABELS[effort], this.state.settings.reasoning === effort)).join('');
  }

  bindEvents() {
    const input = this.shadowRoot.querySelector('textarea');
    this.shadowRoot.querySelector('.clear-history')?.addEventListener('click', () => this.clearChat());
    this.shadowRoot.querySelector('.send')?.addEventListener('click', () => this.send());
    input?.addEventListener('input', (event) => {
      this.updateDraft(event.target.value);
      this.autoSizeTextarea(event.target);
      const disabled = this.state.loading || this.state.clearing;
      const sendButton = this.shadowRoot.querySelector('.send');
      const clearButton = this.shadowRoot.querySelector('.clear-history');
      if (sendButton) sendButton.disabled = disabled || !this.state.historyLoaded || !this.state.draft.trim();
      if (clearButton) clearButton.disabled = disabled || !this.hasConversationState();
    });
    input?.addEventListener('compositionstart', () => { this.isComposing = true; });
    input?.addEventListener('compositionend', (event) => {
      this.isComposing = false;
      this.updateDraft(event.target.value);
      this.autoSizeTextarea(event.target);
      if (this.pendingRenderOptions) {
        const options = this.pendingRenderOptions;
        this.pendingRenderOptions = null;
        this.render(options);
      }
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        this.send();
      }
    });
    this.shadowRoot.querySelector('[data-setting="model"]')?.addEventListener('change', (event) => this.updateModel(event.target.value));
    this.shadowRoot.querySelector('[data-setting="reasoning"]')?.addEventListener('change', (event) => this.updateReasoning(event.target.value));
  }

  render(options = {}) {
    if (!this.shadowRoot) return;
    if (this.isComposing) {
      this.pendingRenderOptions = {
        forceScrollEnd: Boolean(options.forceScrollEnd || this.pendingRenderOptions?.forceScrollEnd),
        focusComposer: Boolean(options.focusComposer || this.pendingRenderOptions?.focusComposer),
      };
      return;
    }
    this.state.settings = normalizeSettings(this.state.settings);
    const previous = this.captureDomState();
    const disabled = this.state.loading || this.state.clearing;
    const sendDisabled = disabled || !this.state.historyLoaded || !this.state.draft.trim();
    const rows = this.state.messages.map((item) => `<div class="row ${item.role}"><div class="bubble">${this.escape(item.text)}</div></div>`).join('');
    const emptyText = this.state.historyPromise ? 'Carregando histórico…' : 'Conversa vazia. A próxima mensagem iniciará um novo contexto.';
    const userName = this._hass?.user?.name || 'usuário autenticado';
    const userLabel = `Usuário: ${userName}`;
    this.shadowRoot.innerHTML = `<style>
:host{display:block;height:100%;min-height:0;max-height:100vh;max-height:min(100dvh,var(--codex-available-height,100dvh));overflow:hidden;box-sizing:border-box}
ha-card{display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;height:100%;min-height:0;overflow:hidden;box-sizing:border-box}
.top{min-height:0;background:var(--card-background-color)}.header-row{display:flex;align-items:center;gap:12px;padding:12px 16px 4px}.header{min-width:0;flex:1;font-size:20px;font-weight:600}
.sub{padding:0 16px 8px;color:var(--secondary-text-color);font-size:12px;line-height:1.35;overflow-wrap:anywhere}.settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px;padding:0 16px 10px}
.setting{display:grid;min-width:0;gap:4px;color:var(--secondary-text-color);font-size:12px;font-weight:600}.setting select{width:100%;min-width:0;min-height:44px;border:1px solid var(--divider-color);border-radius:9px;padding:8px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit}
.note{grid-column:1/-1;margin:0;color:var(--secondary-text-color);font-size:12px;line-height:1.35}.feed{min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;padding:10px 16px;background:var(--primary-background-color);box-sizing:border-box}
.row{display:flex;margin:8px 0}.row.user{justify-content:flex-end}.bubble{max-width:min(78%,760px);padding:11px 14px;border-radius:16px;background:var(--secondary-background-color);color:var(--primary-text-color);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;cursor:text;user-select:text;-webkit-user-select:text;-webkit-touch-callout:default}
.user .bubble{background:var(--primary-color);color:var(--text-primary-color,white);border-bottom-right-radius:4px}.assistant .bubble{border-bottom-left-radius:4px}.error .bubble{color:var(--error-color)}.typing{padding:7px 16px;color:var(--secondary-text-color);font-size:13px;background:var(--card-background-color)}
.composer{display:flex;min-width:0;gap:10px;align-items:flex-end;padding:10px max(12px,var(--safe-area-inset-right,env(safe-area-inset-right,0px))) max(10px,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))) max(12px,var(--safe-area-inset-left,env(safe-area-inset-left,0px)));background:var(--card-background-color);box-sizing:border-box}
textarea{flex:1;min-width:0;height:44px;min-height:44px;max-height:min(140px,25dvh);resize:none;overflow-y:hidden;box-sizing:border-box;border:1px solid var(--divider-color);border-radius:14px;padding:11px 13px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit;line-height:1.35}
button{min-width:44px;min-height:44px;border:0;border-radius:50%;cursor:pointer;color:white;background:var(--primary-color);font:inherit}.send{width:46px;height:46px;font-size:21px;flex:0 0 auto}.clear-history{width:auto;min-width:44px;height:44px;padding:0 12px;border-radius:10px;background:var(--error-color);font-size:13px;flex:0 0 auto}
button:disabled,select:disabled,textarea:disabled{opacity:.45;cursor:default}@media(max-width:600px){.header-row{padding-inline:12px}.sub,.settings,.feed{padding-inline:12px}.bubble{max-width:88%}}@media(max-height:500px){.header-row{padding-block:4px}.sub,.note{display:none}.settings{padding-bottom:5px}.typing{padding-block:3px}.composer{padding-top:6px}.clear-history{height:40px;min-height:40px}}
</style><ha-card aria-busy="${this.state.loading ? 'true' : 'false'}"><div class="top"><div class="header-row"><div class="header">${this.escape(this.config?.title || 'Codex')}</div><button type="button" class="clear-history" title="Apagar histórico, rascunho e escolhas desta conversa" aria-label="Limpar conversa" ${disabled || !this.hasConversationState() ? 'disabled' : ''}>${this.state.clearing ? 'Limpando…' : 'Limpar conversa'}</button></div><div class="sub">Escopo: somente este servidor e o que está instalado nele · ${this.escape(userLabel)} · Histórico preservado</div><div class="settings"><label class="setting">Modelo<select data-setting="model" aria-label="Modelo Codex" ${disabled ? 'disabled' : ''}>${this.modelOptions()}</select></label><label class="setting">Reasoning<select data-setting="reasoning" aria-label="Nível de reasoning" ${disabled ? 'disabled' : ''}>${this.reasoningOptions()}</select></label><p class="note">Luna com reasoning baixo é o padrão. As escolhas e o rascunho permanecem nesta conversa até a limpeza explícita.</p></div></div><div class="feed" role="log" aria-label="Mensagens da conversa" aria-live="polite">${rows || `<div class="sub">${emptyText}</div>`}</div>${this.state.loading ? `<div class="typing" role="status">${this.escape(this.loadingMessage())}</div>` : ''}<div class="composer"><textarea aria-label="Mensagem para o Codex" placeholder="Digite sua mensagem…" ${disabled ? 'disabled' : ''}>${this.escape(this.state.draft)}</textarea><button type="button" class="send" title="Enviar mensagem" aria-label="Enviar mensagem" ${sendDisabled ? 'disabled' : ''}>➤</button></div></ha-card>`;
    this.bindEvents();
    const input = this.shadowRoot.querySelector('textarea');
    this.autoSizeTextarea(input);
    window.requestAnimationFrame(() => {
      const feed = this.shadowRoot.querySelector('.feed');
      if (feed) feed.scrollTop = options.forceScrollEnd || previous.feedNearEnd ? feed.scrollHeight : previous.feedScrollTop;
      if ((options.focusComposer || previous.inputFocused) && input && !input.disabled) {
        try { input.focus({ preventScroll: true }); } catch (_error) { input.focus(); }
        if (previous.inputFocused && Number.isInteger(previous.selectionStart)) input.setSelectionRange(previous.selectionStart, previous.selectionEnd);
      }
    });
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, CodexChatCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) window.customCards.push({ type: CARD_TAG, name: 'Codex Chat com histórico' });
