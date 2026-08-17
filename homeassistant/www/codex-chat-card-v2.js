const CARD_TAG = 'codex-chat-card-v2';
const MODELS = {
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

const REASONING_LABELS = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra' };

class CodexChatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.messages = [];
    this.loading = false;
    this.clearing = false;
    this.loadingStartedAt = null;
    this.loadingTimer = null;
    this.loaded = false;
    this.settings = this.loadSettings();
  }

  setConfig(config) { this.config = config || {}; this.render(); }

  set hass(hass) {
    this._hass = hass;
    if (!this.loaded) { this.loaded = true; this.loadHistory(); }
  }

  getCardSize() { return 8; }

  disconnectedCallback() { this.stopLoadingFeedback(); }

  loadSettings() {
    return { model: 'gpt-5.6-luna', reasoning: 'low' };
  }

  saveSettings() {}

  allowedReasoning() { return this.settings.model ? MODELS[this.settings.model] : [...new Set(Object.values(MODELS).flat())]; }

  async loadHistory() {
    try {
      const result = await this._hass.callWS({ type: 'claude_code_chat/history', limit: this.config?.history_limit || 200 });
      this.messages = (result.turns || []).flatMap((turn) => [{ role: 'user', text: turn.prompt }, { role: 'assistant', text: turn.reply }]);
    } catch (error) {
      this.messages = [{ role: 'error', text: `Não foi possível carregar o histórico: ${error.message || error}` }];
    }
    this.render(); this.scrollToEnd();
  }

  async send() {
    const input = this.shadowRoot.querySelector('textarea');
    const text = input?.value.trim();
    if (!text || this.loading) return;
    input.value = ''; this.messages.push({ role: 'user', text }); this.loading = true; this.render(); this.startLoadingFeedback(); this.scrollToEnd();
    const payload = { type: 'claude_code_chat/process', text };
    if (this.settings.model) payload.model = this.settings.model;
    if (this.settings.reasoning) payload.reasoning_effort = this.settings.reasoning;
    try {
      const result = await this._hass.callWS(payload);
      this.messages.push({ role: 'assistant', text: result.reply });
    } catch (error) {
      this.messages.push({ role: 'error', text: `Erro ao enviar: ${error.message || error}` });
    }
    this.stopLoadingFeedback(); this.loading = false; this.render(); this.scrollToEnd();
  }

  async clearChat() {
    if (this.loading || this.clearing) return;
    const confirmed = window.confirm('Apagar todo o histórico e o contexto desta conversa? Esta ação não pode ser desfeita.');
    if (!confirmed) return;
    this.clearing = true;
    this.render();
    try {
      await this._hass.callWS({ type: 'claude_code_chat/clear' });
      this.messages = [];
    } catch (error) {
      this.messages.push({ role: 'error', text: `Não foi possível limpar a conversa: ${error.message || error}` });
    }
    this.clearing = false;
    this.render();
  }

  loadingMessage() {
    const elapsed = Math.max(0, Math.floor((Date.now() - this.loadingStartedAt) / 1000));
    const duration = elapsed < 60 ? `${elapsed} s` : `${Math.floor(elapsed / 60)} min ${elapsed % 60} s`;
    if (elapsed < 10) return `Iniciando o Codex… ${duration}`;
    if (elapsed < 30) return `Codex está analisando o pedido… ${duration}`;
    return `Ainda trabalhando; tarefas complexas podem levar alguns minutos… ${duration}`;
  }

  updateLoadingFeedback() {
    const status = this.shadowRoot.querySelector('.typing');
    if (status && this.loadingStartedAt) status.textContent = this.loadingMessage();
  }

  startLoadingFeedback() {
    this.stopLoadingFeedback();
    this.loadingStartedAt = Date.now();
    this.updateLoadingFeedback();
    this.loadingTimer = window.setInterval(() => this.updateLoadingFeedback(), 1000);
  }

  stopLoadingFeedback() {
    if (this.loadingTimer) window.clearInterval(this.loadingTimer);
    this.loadingTimer = null;
    this.loadingStartedAt = null;
  }

  scrollToEnd() { requestAnimationFrame(() => { const feed = this.shadowRoot.querySelector('.feed'); if (feed) feed.scrollTop = feed.scrollHeight; }); }

  escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

  option(value, label, selected) { return `<option value="${this.escape(value)}"${selected ? ' selected' : ''}>${this.escape(label)}</option>`; }

  modelOptions() {
    return Object.keys(MODELS).map((model) => this.option(model, model, this.settings.model === model)).join('');
  }

  reasoningOptions() {
    const allowed = this.allowedReasoning();
    const selected = allowed.includes(this.settings.reasoning) ? this.settings.reasoning : allowed[0];
    return allowed.map((effort) => this.option(effort, REASONING_LABELS[effort], selected === effort)).join('');
  }

  render() {
    if (!this.shadowRoot) return;
    const rows = this.messages.map((item) => `<div class="row ${item.role}"><div class="bubble" style="cursor:text;user-select:text;-webkit-user-select:text;-webkit-touch-callout:default">${this.escape(item.text)}</div></div>`).join('');
    this.shadowRoot.innerHTML = `<style>:host{display:block}ha-card{overflow:hidden}.header{padding:18px 20px 4px;font-size:20px;font-weight:600}.sub{padding:0 20px 12px;color:var(--secondary-text-color);font-size:13px}.settings{display:grid;grid-template-columns:minmax(180px,1fr) minmax(150px,1fr);gap:10px;padding:0 20px 14px}.setting{display:grid;gap:4px;color:var(--secondary-text-color);font-size:12px;font-weight:600}.setting select{min-width:0;border:1px solid var(--divider-color);border-radius:9px;padding:8px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit}.note{grid-column:1/-1;margin:0;color:var(--secondary-text-color);font-size:12px;line-height:1.35}.feed{height:min(58vh,620px);min-height:320px;overflow-y:auto;padding:10px 16px;background:var(--primary-background-color)}.row{display:flex;margin:8px 0}.row.user{justify-content:flex-end}.bubble{max-width:min(78%,760px);padding:11px 14px;border-radius:16px;background:var(--secondary-background-color);color:var(--primary-text-color);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}.user .bubble{background:var(--primary-color);color:var(--text-primary-color,white);border-bottom-right-radius:4px}.assistant .bubble{border-bottom-left-radius:4px}.error .bubble{color:var(--error-color)}.composer{display:flex;gap:10px;padding:14px;align-items:flex-end}textarea{flex:1;min-height:44px;max-height:140px;resize:vertical;box-sizing:border-box;border:1px solid var(--divider-color);border-radius:14px;padding:11px 13px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit}button{width:46px;height:46px;border:0;border-radius:50%;cursor:pointer;color:white;background:var(--primary-color);font-size:21px}button:disabled,select:disabled{opacity:.45;cursor:default}.typing{padding:0 20px 8px;color:var(--secondary-text-color);font-size:13px}@media(max-width:600px){.settings{grid-template-columns:1fr}.feed{min-height:280px}}</style><ha-card><div class="header">${this.escape(this.config?.title || 'Codex')}</div><div class="sub">Histórico salvo e restaurado automaticamente</div><div class="settings"><label class="setting">Modelo<select data-setting="model" ${this.loading ? 'disabled' : ''}>${this.modelOptions()}</select></label><label class="setting">Reasoning<select data-setting="reasoning" ${this.loading ? 'disabled' : ''}>${this.reasoningOptions()}</select></label><p class="note">A seleção inicial é Terra com reasoning médio. Ao alterar uma opção, o Codex usa uma sessão separada para não misturar contextos.</p></div><div class="feed">${rows || '<div class="sub">Carregando histórico…</div>'}</div>${this.loading ? '<div class="typing">Codex está trabalhando…</div>' : ''}<div class="composer"><textarea placeholder="Digite sua mensagem…" ${this.loading ? 'disabled' : ''}></textarea><button title="Enviar" ${this.loading ? 'disabled' : ''}>➤</button></div></ha-card>`;
    const userName = this._hass?.user?.name || 'usuário autenticado';
    this.shadowRoot.querySelector('.sub').textContent = `Escopo: somente este servidor e o que está instalado nele · Usuário: ${userName} · Histórico preservado`;
    this.shadowRoot.querySelector('.note').textContent = 'A seleção inicial prioriza velocidade: Luna com reasoning baixo. Terra e Sol continuam disponíveis para tarefas mais difíceis.';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'clear-history';
    clearButton.textContent = this.clearing ? 'Limpando…' : 'Limpar conversa';
    clearButton.title = 'Apagar histórico e contexto desta conversa';
    clearButton.disabled = this.loading || this.clearing || this.messages.length === 0;
    clearButton.style.cssText = 'grid-column:1/-1;justify-self:end;width:auto;height:36px;padding:0 14px;border-radius:10px;background:var(--error-color);font-size:13px';
    this.shadowRoot.querySelector('.settings').append(clearButton);
    clearButton.addEventListener('click', () => this.clearChat());
    if (this.clearing) {
      this.shadowRoot.querySelector('textarea').disabled = true;
      this.shadowRoot.querySelector('.composer button').disabled = true;
    }
    if (this.loaded && this.messages.length === 0) {
      const emptyState = this.shadowRoot.querySelector('.feed .sub');
      if (emptyState) emptyState.textContent = 'Conversa vazia. A próxima mensagem iniciará um novo contexto.';
    }
    this.shadowRoot.querySelector('.composer button')?.addEventListener('click', () => this.send());
    this.shadowRoot.querySelector('textarea')?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.send(); } });
    this.shadowRoot.querySelector('[data-setting="model"]')?.addEventListener('change', (event) => { this.settings.model = event.target.value; if (!this.allowedReasoning().includes(this.settings.reasoning)) this.settings.reasoning = ''; this.saveSettings(); this.render(); });
    this.shadowRoot.querySelector('[data-setting="reasoning"]')?.addEventListener('change', (event) => { this.settings.reasoning = event.target.value; this.saveSettings(); });
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, CodexChatCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) window.customCards.push({ type: CARD_TAG, name: 'Codex Chat com histórico' });
