const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function runLocalAiMcpStatus(options = {}) {
  const runtimeDir = options.runtimeDir || process.env.LOCAL_AI_MCP_RUNTIME_DIR || '/opt/local-ai-rtx';
  const server = path.join(runtimeDir, 'mcp_server.py');
  const spawnImpl = options.spawnImpl || spawn;
  if (!fs.existsSync(server)) {
    return Promise.resolve({ state: 'LOCAL_AI_UNKNOWN', reason: 'mcp_runtime_unavailable' });
  }
  return new Promise((resolve) => {
    const child = spawnImpl('/usr/bin/python3', [server], {
      cwd: runtimeDir,
      env: options.env || process.env,
    });
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ state: 'LOCAL_AI_UNKNOWN', reason: 'mcp_recovery_timeout' });
    }, options.timeoutMs || 180_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => finish({ state: 'LOCAL_AI_UNKNOWN', reason: 'mcp_recovery_start_failed' }));
    child.on('close', () => {
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            const structured = message.result?.structuredContent;
            finish(structured && typeof structured === 'object'
              ? structured
              : { state: 'LOCAL_AI_UNKNOWN', reason: 'mcp_recovery_invalid_response' });
            return;
          }
        } catch {
          // Ignore non-protocol output and fail closed below.
        }
      }
      finish({ state: 'LOCAL_AI_UNKNOWN', reason: 'mcp_recovery_invalid_response' });
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ai-bridge-health', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'local_ai_status', arguments: {} } }),
      '',
    ].join('\n'));
  });
}

module.exports = { runLocalAiMcpStatus };
