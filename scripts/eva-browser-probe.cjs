#!/usr/bin/env node
// Read-only local browser probe. Account URLs and browser data remain private.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function classify({ status, exactTarget, title, body, loginVisible, composerVisible }) {
  if (/just a moment|verify you are human|verifique se voc[eê] [eé] humano|checking your browser/i.test(`${title}\n${body}`)) return 'access_challenge';
  if (loginVisible) return 'login_required';
  if (/this conversation is no longer available|couldn.t open this conversation|esta conversa n[aã]o est[aá] mais dispon[ií]vel/i.test(body)) return 'conversation_unavailable';
  if (status >= 200 && status < 300 && exactTarget && composerVisible) return 'target_ui_detected';
  return 'unverified_page';
}

async function main() {
  process.umask(0o077);
  if (process.argv.length !== 2) throw new Error('no_arguments_supported');
  const root = path.join(os.homedir(), '.local/share/eva-direct-browser');
  const configPath = path.join(root, 'config.json');
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('private_config_required');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const target = new URL(config.url);
  if (target.origin !== 'https://chatgpt.com' || !target.pathname.startsWith('/dots/') || target.username || target.password || target.search || target.hash) throw new Error('invalid_target');
  if (!path.isAbsolute(config.profile) || !path.isAbsolute(config.executablePath)) throw new Error('absolute_paths_required');
  fs.mkdirSync(config.profile, { recursive: true, mode: 0o700 });
  const profileStat = fs.lstatSync(config.profile);
  if (!profileStat.isDirectory() || profileStat.uid !== process.getuid() || (profileStat.mode & 0o077)) throw new Error('private_profile_required');
  const lock = path.join(root, 'probe.lock');
  // A crashed probe requires inspection before removing its lock; never overlap profiles.
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, `${process.pid}\n`);
  let context;
  let operation;
  try {
    operation = path.join(root, 'operations', randomUUID());
    fs.mkdirSync(operation, { recursive: true, mode: 0o700 });
    const save = (name, value) => fs.writeFileSync(path.join(operation, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    save('intent.json', { at: new Date().toISOString(), action: 'local_readonly_probe', desktopUsed: false, sends: 0 });
    const { chromium } = require(path.join(root, 'node_modules/playwright-core'));
    context = await chromium.launchPersistentContext(config.profile, {
      executablePath: config.executablePath, headless: config.headless !== false,
      viewport: { width: 1280, height: 900 }, args: ['--disable-dev-shm-usage'],
    });
    const page = context.pages()[0] || await context.newPage();
    const response = await page.goto(target.href, { timeout: 45000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    const body = await page.locator('body').innerText({ timeout: 5000 });
    const observation = {
      status: response?.status() ?? null,
      exactTarget: page.url() === target.href,
      title: await page.title(), body,
      loginVisible: await page.getByRole('button', { name: /^(log in|sign in|entrar|iniciar sess[aã]o)$/i }).first().isVisible(),
      composerVisible: await page.locator('#prompt-textarea, [contenteditable="true"][role="textbox"]').first().isVisible(),
    };
    save('observation.json', observation);
    await page.screenshot({ path: path.join(operation, 'page.png') });
    const result = {
      at: new Date().toISOString(), state: classify(observation),
      httpStatus: observation.status, exactTarget: observation.exactTarget,
      desktopUsed: false, sends: 0, functionalHealthVerified: false,
    };
    save('result.json', result);
    console.log(JSON.stringify({ ...result, receipt: path.join(operation, 'result.json') }));
  } catch {
    const result = { at: new Date().toISOString(), state: 'browser_error', desktopUsed: false, sends: 0, functionalHealthVerified: false };
    if (operation) fs.writeFileSync(path.join(operation, 'result.json'), JSON.stringify(result) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    try { if (context) await context.close(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

module.exports = { classify };
if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ state: 'configuration_or_lock_error' }));
  process.exitCode = 1;
});
