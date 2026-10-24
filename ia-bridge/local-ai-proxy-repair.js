'use strict';
// Fixed actuator only. Node-RED owns schedule, confirmation, retry budget and alerts.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
function privateIpv4(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  const p = value.split('.').map(Number);
  return p.every((v, i) => v >= 0 && v <= 255 && String(v) === value.split('.')[i]) &&
    (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
}
function settings(config) {
  const u = new URL(config.endpoint);
  const p = config.gpu_probe;
  if (!config.enabled || u.protocol !== 'http:' || u.port !== '11435' || u.username || u.password ||
      !privateIpv4(u.hostname) || !p || p.ssh_host !== u.hostname || p.container !== 'homeassistant' ||
      !/^[A-Za-z0-9_.-]+$/.test(p.ssh_user) || !/^\/config\/\.ssh\/[A-Za-z0-9_.-]+$/.test(p.ssh_key_path) ||
      !Number.isInteger(Number(p.ssh_port || 22)) || Number(p.ssh_port || 22) < 1 || Number(p.ssh_port || 22) > 65535) {
    throw new Error('invalid_fixed_configuration');
  }
  return { endpoint: u.origin, probe: p, host: u.hostname };
}
function script(host) {
  if (!privateIpv4(host)) throw new Error('invalid_host');
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='Stop';$ip='${host}';$attempted=$false;try {
$svc=@(Get-CimInstance Win32_Service | Where-Object {$_.Name -in @('iphlpsvc','Tailscale')} | Select-Object Name,State,ProcessId);
if(-not(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ip -ErrorAction SilentlyContinue | Where-Object {$_.AddressState -eq 'Preferred'})){throw 'address_not_ready'};
$rules=(& netsh interface portproxy show v4tov4 | Out-String).Trim();
$pattern='(?m)^\\s*'+[regex]::Escape($ip)+'\\s+11435\\s+127\\.0\\.0\\.1\\s+11434\\s*$';
if($rules -notmatch $pattern){throw 'proxy_baseline_mismatch'};
$http=(& curl.exe --silent --output NUL --max-time 3 --write-out '%{http_code}' http://127.0.0.1:11434/api/tags 2>$null | Out-String).Trim();
if($http -ne '200'){throw 'backend_not_ready'};
$public=(& curl.exe --silent --output NUL --max-time 3 --write-out '%{http_code}' "http://\${ip}:11435/api/tags" 2>$null | Out-String).Trim();
if($public -ne '200'){
$attempted=$true;
& netsh interface portproxy delete v4tov4 listenaddress=$ip listenport=11435 protocol=tcp | Out-Null;if($LASTEXITCODE -ne 0){throw 'delete_failed'};
& netsh interface portproxy add v4tov4 listenaddress=$ip listenport=11435 connectaddress=127.0.0.1 connectport=11434 protocol=tcp | Out-Null;if($LASTEXITCODE -ne 0){throw 'restore_failed'};
Start-Sleep -Seconds 2;
};
$after=(& netsh interface portproxy show v4tov4 | Out-String).Trim();if($after -ne $rules){throw 'configuration_changed'};
$afterSvc=@(Get-CimInstance Win32_Service | Where-Object {$_.Name -in @('iphlpsvc','Tailscale')} | Select-Object Name,State,ProcessId);
if(($svc|ConvertTo-Json -Compress) -ne ($afterSvc|ConvertTo-Json -Compress)){throw 'shared_service_changed'};
$public=(& curl.exe --silent --output NUL --max-time 3 --write-out '%{http_code}' "http://\${ip}:11435/api/tags" 2>$null | Out-String).Trim();
[pscustomobject]@{reason=if($public -eq '200'){'ready'}else{'published_endpoint_unreachable'};effect_attempted=$attempted;services_preserved=$true;configuration_preserved=$true}|ConvertTo-Json -Compress
}catch{
$reason=[string]$_.Exception.Message;$known=@('address_not_ready','proxy_baseline_mismatch','backend_not_ready','delete_failed','restore_failed','configuration_changed','shared_service_changed');if($known -notcontains $reason){$reason='remote_failure'};
[pscustomobject]@{reason=$reason;effect_attempted=$attempted}|ConvertTo-Json -Compress
}`;
}
function sshArgs(s) {
  const p = s.probe;
  return ['exec', 'homeassistant', 'ssh', '-i', p.ssh_key_path, '-p', String(p.ssh_port || 22),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=/config/.ssh/known_hosts', `${p.ssh_user}@${s.host}`,
    'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script(s.host), 'utf16le').toString('base64')];
}
async function repairProxy(operationId, options = {}) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(operationId || '')) return { outcome: 'rejected', reason: 'invalid_operation_id' };
  const root = options.root || path.join(process.env.HISTORY_DIR || '/workspace/.agent-history', 'rtx-proxy-repair');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const receipt = path.join(root, operationId + '.json');
  if (fs.existsSync(receipt)) return JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const lock = path.join(root, 'active.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { return { outcome: 'unknown', reason: 'operation_in_progress_or_interrupted' }; }
  const save = value => { fs.writeFileSync(receipt, JSON.stringify({ operation_id: operationId, ...value }), { mode: 0o600 }); return { operation_id: operationId, ...value }; };
  let result;
  try {
    const config = options.config || JSON.parse(fs.readFileSync(process.env.LOCAL_AI_CONFIG || '/home/node/.codex/local-ai.json', 'utf8'));
    const s = settings(config);
    save({ outcome: 'unknown', reason: 'operation_started' });
    const output = await (options.run || run)('docker', sshArgs(s), { timeout: 25000, maxBuffer: 8192, encoding: 'utf8' });
    const remote = JSON.parse(output.stdout.trim());
    const allowed = ['ready','published_endpoint_unreachable','address_not_ready','proxy_baseline_mismatch','backend_not_ready','delete_failed','restore_failed','configuration_changed','shared_service_changed','remote_failure'];
    if (!allowed.includes(remote.reason) || typeof remote.effect_attempted !== 'boolean') throw new Error('invalid_remote_result');
    const unsafe = ['restore_failed','configuration_changed','shared_service_changed','remote_failure'].includes(remote.reason);
    let reachable = false;
    if (remote.reason === 'ready') {
      try { const r = await (options.fetch || fetch)(s.endpoint + '/api/tags', { signal: AbortSignal.timeout(4000) }); reachable = r.ok && Array.isArray((await r.json()).models); } catch {}
    }
    result = save({ outcome: unsafe ? 'unknown' : reachable ? 'ready' : 'failed', reason: reachable ? 'endpoint_verified_from_bridge' : remote.reason === 'ready' ? 'bridge_path_unreachable' : remote.reason, effect_attempted: remote.effect_attempted, services_preserved: remote.services_preserved === true, verified_at: new Date().toISOString() });
  } catch {
    result = save({ outcome: 'unknown', reason: 'execution_result_unknown' });
  } finally {
    fs.closeSync(fd);
    // Ambiguous effects remain blocked across restarts until operator reconciliation.
    if (result?.outcome !== 'unknown') fs.unlinkSync(lock);
  }
  return result;
}
module.exports = { privateIpv4, settings, script, sshArgs, repairProxy };
