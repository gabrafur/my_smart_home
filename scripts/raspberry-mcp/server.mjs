// stdio only. The deployed sandbox must expose only snapshot.json and audit output.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { call, descriptors, MAX_BYTES, TOOLS, validateCall } from './core.mjs';
export function dispatch(request, readSnapshot, audit) {
  let tool = 'none';
  let outcome = 'rejected';
  let result;
  const id = Number.isSafeInteger(request?.id) || (typeof request?.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(request.id)) ? request.id : null;
  try {
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || Object.keys(request).some(k => !['jsonrpc','id','method','params'].includes(k))) throw Error('invalid_request');
    if (request.method === 'notifications/initialized' && request.id === undefined) return null;
    if (id === null) throw Error('invalid_request');
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'raspberry-readonly', version: '0.1.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: descriptors() }; break;
      case 'tools/call': {
        validateCall(request.params);
        tool = request.params.name;
        const data = call(request.params, readSnapshot());
        result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        break;
      }
      default: throw Error('method_not_found');
    }
    outcome = 'ok';
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    const message = ['invalid_request','invalid_parameters','method_not_found'].includes(error.message) ? error.message : 'snapshot_unavailable';
    return { jsonrpc: '2.0', id, error: { code: message === 'method_not_found' ? -32601 : message === 'invalid_parameters' ? -32602 : -32600, message } };
  } finally {
    // Fail closed if audit cannot be written; never persist arguments or error text.
    audit({ time: new Date().toISOString(), tool: TOOLS.includes(tool) ? tool : 'none', outcome });
  }
}
export function readSnapshot() {
  const fd = fs.openSync('/run/raspberry-mcp/snapshot.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('unavailable');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_BYTES) throw Error('unavailable');
    return JSON.parse(buffer.subarray(0,size).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
export function serve(input = process.stdin, output = process.stdout, audit = row => fs.writeSync(2, JSON.stringify(row) + '\n')) {
  let pending = Buffer.alloc(0), windowStart = Date.now(), count = 0;
  input.on('data', chunk => {
    // Sequential bounded framing, including multiple messages in one chunk.
    for (const part of chunk.toString('utf8').split(/(?<=\n)/)) {
      pending = Buffer.concat([pending, Buffer.from(part)]);
      if (pending.length > MAX_BYTES) { audit({ time: new Date().toISOString(), tool: 'none', outcome: 'oversize' }); input.destroy(); return; }
      if (!part.endsWith('\n')) continue;
      if (Date.now() - windowStart >= 60000) { count = 0; windowStart = Date.now(); }
      if (++count > 60) { audit({ time: new Date().toISOString(), tool: 'none', outcome: 'rate_limited' }); input.destroy(); return; }
      let request;
      try { request = JSON.parse(pending.toString('utf8')); } catch { request = null; }
      pending = Buffer.alloc(0);
      try {
        const response = dispatch(request, readSnapshot, audit);
        if (response && !output.write(JSON.stringify(response) + '\n')) input.pause(), output.once('drain', () => input.resume());
      } catch { input.destroy(); return; }
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
