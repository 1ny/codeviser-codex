import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScriptHeaderText, validateScriptArguments } from '../mcp/server.mjs';

const text = `; {
;   "interface": 1,
;   "safe": true,
;   "arguments": {
;     "symbol": { "type": "symbol" },
;     "count": { "type": "number", "optional": true }
;   }
; }
PRINT "test"`;

test('CMM JSON header is parsed and validated', () => {
  const header = parseScriptHeaderText(text);
  assert.equal(header.interface, 1);
  assert.equal(header.safe, true);
  assert.deepEqual(validateScriptArguments(header, { symbol: 'BatteryVoltage', count: '10.' }), [
    'BatteryVoltage', '10.'
  ]);
});

test('unknown and unsafe argument values are rejected', () => {
  const header = parseScriptHeaderText(text);
  assert.throws(() => validateScriptArguments(header, { symbol: 'bad;command' }));
  assert.throws(() => validateScriptArguments(header, { symbol: 'Good', extra: 'x' }));
});

test('missing or incompatible interface header is rejected', () => {
  assert.throws(() => parseScriptHeaderText('SYStem.Up'));
  assert.throws(() => parseScriptHeaderText('; { "interface": 2, "arguments": {} }'));
});
