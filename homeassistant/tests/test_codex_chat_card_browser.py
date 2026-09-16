"""Headless-browser layout checks for the Codex panel card."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CARD = ROOT / "homeassistant" / "www" / "codex-chat-card-v2.js"
VIEWPORTS = ((390, 844), (320, 667), (430, 932), (844, 390), (1440, 900))


class CodexChatCardBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured = os.environ.get("CODEX_BROWSER")
        names = [configured] if configured else [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ]
        candidates = []
        for name in names:
            executable = shutil.which(name) if name else None
            if executable and executable not in candidates:
                candidates.append(executable)
        if not candidates:
            if configured:
                raise RuntimeError(f"Configured CODEX_BROWSER is not executable: {configured}")
            raise unittest.SkipTest("Chromium is not available for browser layout checks")
        cls.chromium = candidates[0]

        configured_driver = os.environ.get("CODEX_CHROMEDRIVER")
        cls.chromedriver = shutil.which(configured_driver or "chromedriver")
        if not cls.chromedriver:
            if configured_driver:
                raise RuntimeError(
                    f"Configured CODEX_CHROMEDRIVER is not executable: {configured_driver}"
                )
            raise unittest.SkipTest("ChromeDriver is not available for browser layout checks")

    @staticmethod
    def webdriver_request(base_url: str, method: str, path: str, payload=None) -> dict:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ChromeDriver request failed ({error.code}): {detail}") from error

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
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            base_url = f"http://127.0.0.1:{port}"
            driver = subprocess.Popen(
                [self.chromedriver, f"--port={port}"],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            session_id = None
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        self.webdriver_request(base_url, "GET", "/status")
                        break
                    except (OSError, RuntimeError):
                        if driver.poll() is not None:
                            self.fail(f"ChromeDriver exited during startup with {driver.returncode}")
                        if time.monotonic() >= deadline:
                            self.fail("ChromeDriver did not become ready")
                        time.sleep(0.1)

                response = self.webdriver_request(
                    base_url,
                    "POST",
                    "/session",
                    {
                        "capabilities": {
                            "alwaysMatch": {
                                "browserName": "chrome",
                                "goog:chromeOptions": {
                                    "binary": self.chromium,
                                    "args": [
                                        "--headless",
                                        "--no-sandbox",
                                        "--disable-gpu",
                                        "--disable-dev-shm-usage",
                                        "--disable-background-networking",
                                        "--no-first-run",
                                        "--no-default-browser-check",
                                        f"--user-data-dir={profile}",
                                        "--window-size=1000,1200",
                                    ],
                                },
                            }
                        }
                    },
                )
                session_id = response["value"]["sessionId"]
                self.webdriver_request(
                    base_url,
                    "POST",
                    f"/session/{session_id}/url",
                    {"url": page.as_uri()},
                )
                deadline = time.monotonic() + 10
                while True:
                    response = self.webdriver_request(
                        base_url,
                        "POST",
                        f"/session/{session_id}/execute/sync",
                        {"script": "return document.body.textContent", "args": []},
                    )
                    payload = response.get("value", "").strip()
                    try:
                        result = json.loads(payload)
                        break
                    except json.JSONDecodeError:
                        if time.monotonic() >= deadline:
                            self.fail(f"Browser harness did not return JSON: {payload[-2000:]}")
                        time.sleep(0.1)
            finally:
                if session_id:
                    try:
                        self.webdriver_request(base_url, "DELETE", f"/session/{session_id}")
                    except (OSError, RuntimeError):
                        pass
                driver.terminate()
                try:
                    driver.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    driver.kill()
                    driver.wait(timeout=5)
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
