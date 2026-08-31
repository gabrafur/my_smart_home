const { configureLocalAiMcp, configureLocalAiRuntimePaths } = require('./configure-local-ai-mcp');
const { configureGitWorkspace } = require('./configure-git-workspace');

try {
  if (configureGitWorkspace()) {
    console.log(`Git workspace trust recorded for ${process.env.WORKDIR || '/workspace'}`);
  }
} catch (error) {
  // Keep the bridge available for conversational use, but make the degraded
  // terminal state visible instead of failing every project hook silently.
  console.warn(`Git workspace trust unavailable: ${error.message}`);
}

try {
  configureLocalAiMcp();
  configureLocalAiRuntimePaths();
  console.log('Local AI MCP configuration synchronized');
} catch (error) {
  // Local AI is an optimization, not a bridge dependency. Keep chat service
  // available and let the Codex policy fall back normally if synchronization
  // cannot be completed on a portable or temporarily incomplete deployment.
  console.warn(`Local AI MCP configuration unavailable: ${error.message}`);
}

require('./server');
