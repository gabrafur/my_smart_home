"""Headless-browser layout checks for the Codex panel card."""

from __future__ import annotations

import html
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CARD = ROOT / "homeassistant" / "www" / "codex-chat-card-v2.js"
VIEWPORTS = ((390, 844), (320, 667), (430, 932), (844, 390), (1440, 900))


class CodexChatCardBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chromium = shutil.which("chromium") or shutil.which("chromium-browser")
        if cls.chromium is None:
            raise unittest.SkipTest("Chromium is not available for browser layout checks")

    def render_viewport(self, width: int, height: int) -> dict:
        card = CARD.read_text(encoding="utf-8")
        harness = f"""<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
html,body{{width:100%;height:100%;margin:0;overflow:hidden;font-family:sans-serif}}
body{{--header-height:56px;--primary-background-color:#eee;--card-background-color:#fff;--secondary-background-color:#ddd;--primary-color:#1686d9;--primary-text-color:#111;--secondary-text-color:#555;--divider-color:#bbb;--error-color:#b3261e}}
#toolbar{{height:var(--header-height);background:#1686d9}}#panel{{height:calc(100% - var(--header-height));min-height:0}}
</style></head><body><div id="toolbar"></div><div id="panel"></div>
<script>{card}</script>
<script>
const pageErrors=[];
window.addEventListener('error',(event)=>pageErrors.push(String(event.error||event.message)));
window.addEventListener('unhandledrejection',(event)=>pageErrors.push(String(event.reason)));
(async()=>{{
  let card=document.createElement('codex-chat-card-v2');
  document.querySelector('#panel').append(card);
  card.setConfig({{title:'Codex',history_limit:200}});
  let historyCalls=0;
  card.hass={{user:{{id:'browser-test',name:'Browser Test'}},callWS:async(payload)=>{{
    if(payload.type==='claude_code_chat/history'){{
      historyCalls+=1;
      return {{turns:Array.from({{length:80}},(_,index)=>({{prompt:`Pergunta ${{index}}`,reply:`Resposta longa ${{index}} `.repeat(8)}}))}};
    }}
    return {{reply:'ok',model:payload.model,reasoning_effort:payload.reasoning_effort}};
  }}}};
  await card.state.historyPromise;
  let input=card.shadowRoot.querySelector('textarea');
  input.value='rascunho no navegador';
  input.dispatchEvent(new InputEvent('input',{{bubbles:true,inputType:'insertText',data:'r'}}));
  let model=card.shadowRoot.querySelector('[data-setting="model"]');
  model.value='gpt-5.6-terra';
  model.dispatchEvent(new Event('change',{{bubbles:true}}));
  let reasoning=card.shadowRoot.querySelector('[data-setting="reasoning"]');
  reasoning.value='ultra';
  reasoning.dispatchEvent(new Event('change',{{bubbles:true}}));
  card.flushDraft();
  const persistedBeforeRemount=JSON.parse(localStorage.getItem(card.chatKey));
  card.remove();
  card=document.createElement('codex-chat-card-v2');
  document.querySelector('#panel').append(card);
  card.setConfig({{title:'Codex',history_limit:200}});
  card.hass={{user:{{id:'browser-test',name:'Browser Test'}},callWS:async(payload)=>{{
    if(payload.type==='claude_code_chat/history') historyCalls+=1;
    return {{turns:[]}};
  }}}};
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const feed=card.shadowRoot.querySelector('.feed');
  const composer=card.shadowRoot.querySelector('.composer');
  const hostRect=card.getBoundingClientRect();
  const feedRect=feed.getBoundingClientRect();
  const composerRect=composer.getBoundingClientRect();
  const result={{
    viewport:[innerWidth,innerHeight],
    documentScrollHeight:document.documentElement.scrollHeight,
    hostBottom:hostRect.bottom,
    composerTop:composerRect.top,
    composerBottom:composerRect.bottom,
    feedBottom:feedRect.bottom,
    feedClientHeight:feed.clientHeight,
    feedScrollHeight:feed.scrollHeight,
    feedOverflow:getComputedStyle(feed).overflowY,
    composerPaddingBottom:Number.parseFloat(getComputedStyle(composer).paddingBottom),
    restoredDraft:card.shadowRoot.querySelector('textarea').value,
    restoredModel:card.shadowRoot.querySelector('[data-setting="model"]').value,
    restoredReasoning:card.shadowRoot.querySelector('[data-setting="reasoning"]').value,
    persistedBeforeRemount,
    historyCalls,
    pageErrors,
  }};
  parent.postMessage(result,'*');
}})().catch((error)=>{{parent.postMessage({{fatal:String(error?.stack||error)}},'*')}});
</script></body></html>"""
        with tempfile.TemporaryDirectory(prefix="codex-card-browser-") as directory:
            child = Path(directory) / "card.html"
            page = Path(directory) / "index.html"
            profile = Path(directory) / "profile"
            child.write_text(harness, encoding="utf-8")
            page.write_text(
                f"""<!doctype html><html><body><iframe src="card.html" style="width:{width}px;height:{height}px;border:0"></iframe>
<script>addEventListener('message',(event)=>{{document.body.textContent=JSON.stringify(event.data)}})</script></body></html>""",
                encoding="utf-8",
            )
            process = subprocess.run(
                [
                    self.chromium,
                    "--headless=new",
                    "--no-sandbox",
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    f"--user-data-dir={profile}",
                    "--window-size=1000,1200",
                    "--virtual-time-budget=2000",
                    "--dump-dom",
                    page.as_uri(),
                ],
                check=True,
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            )
        match = re.search(r"<body[^>]*>(.*?)</body>", process.stdout, re.DOTALL)
        self.assertIsNotNone(match, process.stdout[-2000:])
        payload = html.unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip()
        result = json.loads(payload)
        self.assertNotIn("fatal", result, result.get("fatal"))
        return result

    def test_composer_stays_visible_and_messages_own_the_scroll(self):
        for width, height in VIEWPORTS:
            with self.subTest(viewport=(width, height)):
                result = self.render_viewport(width, height)
                actual_height = result["viewport"][1]
                self.assertEqual(result["viewport"], [width, height])
                self.assertLessEqual(result["documentScrollHeight"], actual_height)
                self.assertLessEqual(result["hostBottom"], actual_height + 0.5)
                self.assertLess(result["composerTop"], result["composerBottom"])
                self.assertLessEqual(result["composerBottom"], actual_height + 0.5)
                self.assertLessEqual(result["feedBottom"], result["composerTop"] + 0.5)
                self.assertGreater(result["feedClientHeight"], 0)
                self.assertGreater(result["feedScrollHeight"], result["feedClientHeight"])
                self.assertEqual(result["feedOverflow"], "auto")
                self.assertGreaterEqual(result["composerPaddingBottom"], 10)
                self.assertEqual(result["historyCalls"], 1)
                self.assertEqual(result["restoredDraft"], "rascunho no navegador")
                self.assertEqual(result["restoredModel"], "gpt-5.6-terra")
                self.assertEqual(result["restoredReasoning"], "ultra")
                self.assertEqual(result["persistedBeforeRemount"]["draft"], "rascunho no navegador")
                self.assertEqual(result["pageErrors"], [])


if __name__ == "__main__":
    unittest.main()
