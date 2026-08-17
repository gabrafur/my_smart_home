const { configureLocalAiMcp } = require('./configure-local-ai-mcp');

try {
  configureLocalAiMcp();
  console.log('Local AI MCP configuration synchronized');
} catch (error) {
  // Local AI is an optimization, not a bridge dependency. Keep chat service
  // available and let the Codex policy fall back normally if synchronization
  // cannot be completed on a portable or temporarily incomplete deployment.
  console.warn(`Local AI MCP configuration unavailable: ${error.message}`);
}

require('./server');
