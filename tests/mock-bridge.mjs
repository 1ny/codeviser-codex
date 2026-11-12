import { createInterface } from 'node:readline';

process.stdout.write(`${JSON.stringify({
  ready: true,
  connected: true,
  processBits: 32,
  mock: true
})}\n`);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const request = JSON.parse(line);
  let result;
  switch (request.command) {
    case 'health':
      result = { connected: true, session: 1, bridgePid: process.pid };
      break;
    case 'get_status':
      result = {
        api: { connected: true, session: 1, multiServerPort: 8888, cvdMasterPort: 20000 },
        target: { cvdState: 0, debugState: 0, pc: '0x00400000', errors: [] },
        bridgePid: process.pid
      };
      break;
    case 'shutdown':
      result = { shuttingDown: true, bridgePid: process.pid };
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      input.close();
      process.exit(0);
      break;
    default:
      result = { accepted: true, command: request.command, bridgePid: process.pid };
      break;
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
});
