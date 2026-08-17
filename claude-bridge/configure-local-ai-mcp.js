const fs = require('fs');
const os = require('os');
const path = require('path');

const START_MARKER = '# BEGIN CODEX LOCAL AI RTX MCP';
const END_MARKER = '# END CODEX LOCAL AI RTX MCP';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function managedBlock(runtimeDir) {
  const server = path.join(runtimeDir, 'mcp_server.py');
  return `${START_MARKER}
[mcp_servers.local-ai-rtx]
command = "/usr/bin/python3"
args = [${JSON.stringify(server)}]
cwd = ${JSON.stringify(runtimeDir)}
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 240
default_tools_approval_mode = "auto"
${END_MARKER}`;
}

function replaceManagedBlock(current, block) {
  const pattern = new RegExp(
    `${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`,
    'g',
  );
  const withoutManaged = current.replace(pattern, '').trimEnd();
  if (/^\s*\[mcp_servers\.local-ai-rtx\]\s*$/m.test(withoutManaged)) {
    throw new Error('unmanaged local-ai-rtx MCP configuration already exists');
  }
  return `${withoutManaged}${withoutManaged ? '\n\n' : ''}${block}\n`;
}

function configureLocalAiMcp(options = {}) {
  const runtimeDir = options.runtimeDir || process.env.LOCAL_AI_MCP_RUNTIME_DIR || '/opt/codex-local-ai';
  const configPath = options.configPath
    || process.env.CODEX_CONFIG_PATH
    || path.join(os.homedir(), '.codex', 'config.toml');
  const server = path.join(runtimeDir, 'mcp_server.py');
  if (!fs.existsSync(server)) {
    throw new Error(`Local AI MCP server is unavailable at ${server}`);
  }

  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const updated = replaceManagedBlock(current, managedBlock(runtimeDir));
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, updated, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, 0o600);
}

module.exports = {
  END_MARKER,
  START_MARKER,
  configureLocalAiMcp,
  managedBlock,
  replaceManagedBlock,
};
