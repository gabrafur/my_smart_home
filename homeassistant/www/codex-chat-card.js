class CodexChatCard extends HTMLElement {
  constructor() { super(); this.attachShadow({mode:"open"}); this.messages=[]; this.loading=false; this.loaded=false; }
  setConfig(config) { this.config=config||{}; this.render(); }
  set hass(hass) { this._hass=hass; if (!this.loaded) { this.loaded=true; this.loadHistory(); } }
  getCardSize() { return 8; }
  async loadHistory() {
    try { const result=await this._hass.callWS({type:"claude_code_chat/history",limit:this.config?.history_limit||200}); this.messages=(result.turns||[]).flatMap(turn=>[{role:"user",text:turn.prompt},{role:"assistant",text:turn.reply}]); }
    catch(error) { this.messages=[{role:"error",text:`Não foi possível carregar o histórico: ${error.message||error}`}]; }
    this.render(); this.scrollToEnd();
  }
  async send() {
    const input=this.shadowRoot.querySelector("textarea"); const text=input?.value.trim(); if (!text||this.loading) return;
    input.value=""; this.messages.push({role:"user",text}); this.loading=true; this.render(); this.scrollToEnd();
    try { const result=await this._hass.callWS({type:"claude_code_chat/process",text}); this.messages.push({role:"assistant",text:result.reply}); }
    catch(error) { this.messages.push({role:"error",text:`Erro ao enviar: ${error.message||error}`}); }
    this.loading=false; this.render(); this.scrollToEnd();
  }
  scrollToEnd() { requestAnimationFrame(()=>{const feed=this.shadowRoot.querySelector(".feed"); if(feed) feed.scrollTop=feed.scrollHeight;}); }
  escape(value) { return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char])); }
  render() {
    if(!this.shadowRoot)return; const rows=this.messages.map(item=>`<div class="row ${item.role}"><div class="bubble">${this.escape(item.text)}</div></div>`).join("");
    this.shadowRoot.innerHTML=`<style>:host{display:block}ha-card{overflow:hidden}.header{padding:18px 20px 10px;font-size:20px;font-weight:600}.sub{padding:0 20px 14px;color:var(--secondary-text-color);font-size:13px}.feed{height:min(62vh,650px);min-height:360px;overflow-y:auto;padding:10px 16px;background:var(--primary-background-color)}.row{display:flex;margin:8px 0}.row.user{justify-content:flex-end}.bubble{max-width:min(78%,760px);padding:11px 14px;border-radius:16px;background:var(--secondary-background-color);color:var(--primary-text-color);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}.user .bubble{background:var(--primary-color);color:var(--text-primary-color,white);border-bottom-right-radius:4px}.assistant .bubble{border-bottom-left-radius:4px}.error .bubble{color:var(--error-color)}.composer{display:flex;gap:10px;padding:14px;align-items:flex-end}textarea{flex:1;min-height:44px;max-height:140px;resize:vertical;box-sizing:border-box;border:1px solid var(--divider-color);border-radius:14px;padding:11px 13px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit}button{width:46px;height:46px;border:0;border-radius:50%;cursor:pointer;color:white;background:var(--primary-color);font-size:21px}button:disabled{opacity:.45;cursor:default}.typing{padding:0 20px 8px;color:var(--secondary-text-color);font-size:13px}</style><ha-card><div class="header">${this.escape(this.config?.title||"Codex")}</div><div class="sub">Histórico salvo e restaurado automaticamente</div><div class="feed">${rows||'<div class="sub">Carregando histórico…</div>'}</div>${this.loading?'<div class="typing">Codex está trabalhando…</div>':''}<div class="composer"><textarea placeholder="Digite sua mensagem…" ${this.loading?"disabled":""}></textarea><button title="Enviar" ${this.loading?"disabled":""}>➤</button></div></ha-card>`;
    this.shadowRoot.querySelector("button")?.addEventListener("click",()=>this.send()); this.shadowRoot.querySelector("textarea")?.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();this.send();}});
  }
}
customElements.define("codex-chat-card",CodexChatCard); window.customCards=window.customCards||[]; window.customCards.push({type:"codex-chat-card",name:"Codex Chat com histórico"});
