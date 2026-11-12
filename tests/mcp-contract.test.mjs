import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function startServer(policy = 'readonly') {
  const mockPath = join(root, 'tests', 'mock-bridge.mjs');
  const child = spawn(process.execPath, [join(root, 'mcp', 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CVD_ACCESS_POLICY: policy,
      CVD_BRIDGE_EXECUTABLE: process.execPath,
      CVD_BRIDGE_ARGS_JSON: JSON.stringify([mockPath])
    }
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on('line', line => {
    const message = JSON.parse(line);
    const callback = pending.get(String(message.id));
    if (callback) {
      pending.delete(String(message.id));
      callback(message);
    }
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const requestId = String(++id);
    const timer = setTimeout(() => rejectRequest(new Error(`MCP request timed out: ${method}`)), 5000);
    pending.set(requestId, message => {
      clearTimeout(timer);
      resolveRequest(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  return { child, request };
}

test('MCP negotiates a supported version and advertises CodeViser instructions', async t => {
  const server = startServer();
  t.after(() => server.child.kill());
  const response = await server.request('initialize', { protocolVersion: '2099-01-01' });
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.match(response.result.instructions, /CodeViser CVD debugger/i);
  assert.match(response.result.instructions, /even if the user does not name this MCP server/i);
});

test('status results include structured content and reuse one bridge process', async t => {
  const server = startServer();
  t.after(() => server.child.kill());
  await server.request('initialize', { protocolVersion: '2025-11-25' });
  const first = await server.request('tools/call', { name: 'cvd_get_status', arguments: {} });
  const second = await server.request('tools/call', { name: 'cvd_get_status', arguments: {} });
  assert.equal(first.result.isError, false);
  assert.equal(first.result.structuredContent.api.connected, true);
  assert.equal(first.result.structuredContent.bridgePid, second.result.structuredContent.bridgePid);
});

test('readonly policy rejects unavailable mutation tools', async t => {
  const server = startServer('readonly');
  t.after(() => server.child.kill());
  const response = await server.request('tools/call', { name: 'cvd_command', arguments: {
    command: 'SYStem.Up', confirmed: true
  } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /not available/);
});
