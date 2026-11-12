import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableTools, normalizePolicy } from '../mcp/server.mjs';

const names = policy => new Set(getAvailableTools(policy, false).map(tool => tool.name));

test('readonly exposes diagnostics but no target mutation', () => {
  const tools = names('readonly');
  assert(tools.has('cvd_get_status'));
  assert(tools.has('cvd_read_memory'));
  assert(!tools.has('cvd_run'));
  assert(!tools.has('cvd_run_script'));
  assert(!tools.has('cvd_command'));
});

test('scripts exposes bounded target control and approved scripts', () => {
  const tools = names('scripts');
  assert(tools.has('cvd_run'));
  assert(tools.has('cvd_stop'));
  assert(tools.has('cvd_reset'));
  assert(tools.has('cvd_run_script'));
  assert(!tools.has('cvd_command'));
});

test('unrestricted exposes exact commands; GUI remains separately opt-in', () => {
  assert(names('unrestricted').has('cvd_command'));
  assert(!names('unrestricted').has('cvd_execute_menu'));
  const guiNames = new Set(getAvailableTools('unrestricted', true).map(tool => tool.name));
  assert(guiNames.has('cvd_execute_menu'));
});

test('invalid policy is rejected', () => {
  assert.throws(() => normalizePolicy('admin'));
});
