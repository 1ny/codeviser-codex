import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const statusDirectory = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CodeViserCodexBridge') : here;
const statusLog = process.env.CVD_STATUS_LOG || join(statusDirectory, 'status.log');
try { mkdirSync(dirname(statusLog), { recursive: true }); } catch {}
function logStatus(level, event, details = {}) {
  try { appendFileSync(statusLog, `${JSON.stringify({ time: new Date().toISOString(), level, event, ...details })}\n`, 'utf8'); } catch {}
}
const ps32 = process.env.CVD_POWERSHELL32 || 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const bridgeArgs = [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', join(here, 'cvd-bridge.ps1'),
  '-DllDirectory', process.env.CVD_API_DIR || 'C:\\JnDTech\\CVI\\CVD\\API\\BinR',
  '-HostAddress', process.env.CVD_HOST || '127.0.0.1',
  '-MultiServerPort', process.env.CVD_MULTI_PORT || '8888',
  '-CvdMasterPort', process.env.CVD_MASTER_PORT || '20000',
  '-TimeoutMs', process.env.CVD_TIMEOUT_MS || '5000'
];

let bridgeSequence = 0;
let bridgeQueue = Promise.resolve();

function runBridgeCall(command, args = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = String(++bridgeSequence);
    const bridge = spawn(ps32, bridgeArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const bridgeLines = createInterface({ input: bridge.stdout, crlfDelay: Infinity });
    let responseReceived = false;
    let responseValue;
    let responseError;
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      bridge.kill();
      rejectCall(new Error(`CVD command timed out: ${command}`));
    }, Number(process.env.CVD_TIMEOUT_MS || 5000) + 12000);
    timer.unref();

    bridge.stderr.on('data', data => {
      const text = String(data);
      stderr += text;
      process.stderr.write(`[cvd-bridge] ${text}`);
    });

    bridgeLines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { process.stderr.write(`[cvd-bridge] invalid JSON: ${line}\n`); return; }

      if (Object.hasOwn(message, 'ready')) {
        if (!message.ready) {
          responseReceived = true;
          responseError = new Error(message.error || 'CVD bridge failed to start.');
          bridge.stdin.end();
          return;
        }
        bridge.stdin.write(`${JSON.stringify({ id, command, ...args })}\n`);
        return;
      }

      if (String(message.id) !== id || responseReceived) return;
      responseReceived = true;
      if (message.ok) responseValue = message.result;
      else responseError = new Error(message.error || 'CVD bridge request failed.');
      bridge.stdin.write(`${JSON.stringify({ id: `shutdown-${id}`, command: 'shutdown' })}\n`);
    });

    bridge.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectCall(error);
    });

    bridge.on('exit', (code, signal) => {
      logStatus(code === 0 ? 'info' : 'error', 'bridge_exit', { code, signal, command });
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (responseError) rejectCall(responseError);
      else if (responseReceived) resolveCall(responseValue);
      else rejectCall(new Error(`CVD bridge exited before responding (code=${code}, signal=${signal}). ${stderr}`.trim()));
    });
  });
}

function bridgeCall(command, args = {}) {
  const operation = bridgeQueue.then(() => runBridgeCall(command, args));
  bridgeQueue = operation.catch(() => {});
  return operation;
}

const memoryTypes = { LM: 0, VM: 1, PM: 2, AHB: 3, EAHB: 4, ZAHB: 5, EZAHB: 6, APB: 7, EAPB: 8, AXI: 9, EAXI: 10, ZAXI: 11, EZAXI: 12, DBG: 13, EDBG: 14 };
const registerTypes = { GE: 0, C15: 1, C14: 2, ICE: 3, C10: 4, C11: 5 };
const configuredSourceRoot = process.env.CVD_SOURCE_ROOT ? resolve(process.env.CVD_SOURCE_ROOT) : '';
const sourceExtensions = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx', '.s', '.asm', '.inc', '.ld', '.map']);

function sourceRootOrThrow(requestedRoot = '') {
  const sourceRoot = requestedRoot ? resolve(String(requestedRoot)) : configuredSourceRoot;
  if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error('Source folder is not configured. Pass the project source directory in the root argument.');
  }
  return sourceRoot;
}

function sourcePathOrThrow(path, requestedRoot = '') {
  const root = sourceRootOrThrow(requestedRoot);
  const fullPath = resolve(root, String(path || ''));
  const rel = relative(root, fullPath);
  if (rel.startsWith(`..${sep}`) || rel === '..' || rel.includes(`..${sep}`) || !existsSync(fullPath)) {
    throw new Error('Requested source path is outside the configured source folder or does not exist.');
  }
  return { root, fullPath, relativePath: rel };
}

function enumerateSourceFiles(root, maxFiles = 10000) {
  const files = [];
  const pendingDirs = [root];
  const ignored = new Set(['.git', '.svn', '.hg', 'node_modules', 'bin', 'obj', 'build', 'out']);
  while (pendingDirs.length && files.length < maxFiles) {
    const current = pendingDirs.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name.toLowerCase())) pendingDirs.push(fullPath);
      } else if (entry.isFile()) {
        const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        if (sourceExtensions.has(extension)) files.push(fullPath);
      }
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

function searchSource(query, limit = 50, requestedRoot = '') {
  const root = sourceRootOrThrow(requestedRoot);
  const rawQuery = String(query || '').trim();
  const terms = [...new Set(rawQuery.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length >= 2))];
  if (!terms.length) throw new Error('Provide at least one source search term.');
  const matches = [];
  let scannedFiles = 0;
  for (const file of enumerateSourceFiles(root)) {
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (stat.size > 2 * 1024 * 1024) continue;
    let lines;
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
    scannedFiles++;
    const relativePath = relative(root, file);
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index];
      const lower = text.toLowerCase();
      const foundTerms = terms.filter(term => lower.includes(term));
      if (!foundTerms.length) continue;
      let score = foundTerms.length * 10;
      if (lower.includes(rawQuery.toLowerCase())) score += 20;
      if (/\b(?:static|const|volatile|extern|uint\d+_t|int\d+_t|float|double|bool|char|short|long|struct|enum)\b/i.test(text)) score += 4;
      if (/[=;]/.test(text)) score += 2;
      matches.push({ path: relativePath, line: index + 1, text: text.trim().slice(0, 500), matchedTerms: foundTerms, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  const selected = matches.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
  return { sourceRoot: root, query: rawQuery, terms, scannedFiles, totalMatches: matches.length, matches: selected };
}

function readSource(path, line = 1, context = 20, requestedRoot = '') {
  const resolved = sourcePathOrThrow(path, requestedRoot);
  const lines = readFileSync(resolved.fullPath, 'utf8').split(/\r?\n/);
  const requestedLine = Math.max(1, Math.min(Number(line) || 1, Math.max(1, lines.length)));
  const radius = Math.max(0, Math.min(Number(context) || 20, 100));
  const startLine = Math.max(1, requestedLine - radius);
  const endLine = Math.min(lines.length, requestedLine + radius);
  const content = [];
  for (let number = startLine; number <= endLine; number++) content.push({ line: number, text: lines[number - 1] });
  return { sourceRoot: resolved.root, path: resolved.relativePath, requestedLine, startLine, endLine, content };
}

const hotkeyFile = process.env.CVD_HOTKEY_FILE || 'C:\\JnDTech\\CVI\\CVD\\Script\\cvd_hotkey.xml';
const safeMenuIdPrefixes = [
  'CVD_HOTKEY_VIEW_', 'CVD_HOTKEY_REGISTER_GENERAL', 'CVD_HOTKEY_REGISTER_CP',
  'CVD_HOTKEY_REGISTER_USER', 'CVD_HOTKEY_REGISTER_FPU', 'CVD_HOTKEY_SYMBOL_',
  'CVD_HOTKEY_PERF_PA_LIST', 'CVD_HOTKEY_SRP_STATUS_REGISTER',
  'CVD_HOTKEY_SRP_MAPLIST', 'CVD_HOTKEY_SRP_PROFILE', 'CVD_HOTKEY_HELP',
  'CVD_HOTKEY_BREAK_BP_LIST'
];

function decodeXml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function menuCategory(id) {
  const match = id.match(/^CVD_HOTKEY_([^_]+)/);
  return match ? match[1].toLowerCase() : 'other';
}

function loadMenuCatalog() {
  const xml = readFileSync(hotkeyFile, 'utf8');
  const entries = [];
  for (const tag of xml.matchAll(/<SHORTCUT_INFO\s+([^>]*?)\s*\/>/g)) {
    const attrs = {};
    for (const attr of tag[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) attrs[attr[1]] = decodeXml(attr[2]);
    if (!attrs.ID || !attrs.name) continue;
    const safeToExecute = safeMenuIdPrefixes.some(prefix => attrs.ID.startsWith(prefix));
    entries.push({
      id: attrs.ID,
      name: attrs.name.trim(),
      description: (attrs.desc || '').trim(),
      hotkey: (attrs.key || '').trim(),
      category: menuCategory(attrs.ID),
      safeToExecute,
      executable: safeToExecute && Boolean((attrs.key || '').trim())
    });
  }
  return entries;
}

function searchMenus(query, limit = 10) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const catalog = loadMenuCatalog();
  if (!terms.length) return catalog.slice(0, limit);
  return catalog
    .map(entry => {
      const name = entry.name.toLowerCase();
      const description = entry.description.toLowerCase();
      const id = entry.id.toLowerCase();
      const category = entry.category.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 12;
        if (name.includes(term)) score += 8;
        if (description.includes(term)) score += 4;
        if (category.includes(term)) score += 3;
        if (id.includes(term)) score += 2;
      }
      return { ...entry, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 30)));
}

const apiCapabilities = [
  { tool: 'cvd_health', keywords: 'connection health session port api status', description: 'Check API connection, ports, and session.' },
  { tool: 'cvd_get_state', keywords: 'cvd state status', description: 'Read CVD state.' },
  { tool: 'cvd_get_debug_state', keywords: 'debug target state status halt run', description: 'Read target debug state.' },
  { tool: 'cvd_get_pc', keywords: 'pc program counter current address', description: 'Read the current program counter.' },
  { tool: 'cvd_read_register', keywords: 'register core r0 r1 r2 r3 sp lr pc', description: 'Read a target register.' },
  { tool: 'cvd_read_memory', keywords: 'memory dump read address ram rom', description: 'Read target memory.' },
  { tool: 'cvd_get_symbol', keywords: 'symbol function variable address size elf image', description: 'Resolve a loaded debug symbol.' },
  { tool: 'cvd_search_source', keywords: 'source code variable data declaration reference usage find search', description: 'Search configured C/C++ source files for related variables and code.' },
  { tool: 'cvd_run', keywords: 'run go continue resume target', description: 'Resume target execution.' },
  { tool: 'cvd_stop', keywords: 'stop halt break target', description: 'Stop target execution.' },
  { tool: 'cvd_reset', keywords: 'reset system target', description: 'Reset the target.' },
  { tool: 'cvd_command', keywords: 'exact command script print cd do', description: 'Execute an exact user-specified CVD command.' }
];

function discoverCapabilities(query, limit = 10) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const apis = apiCapabilities
    .map(item => ({ ...item, score: terms.reduce((score, term) => score + (item.keywords.includes(term) ? 5 : 0) + (item.description.toLowerCase().includes(term) ? 3 : 0), 0) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const menus = searchMenus(query, limit);
  return { query, apiTools: apis, menuMatches: menus, menuSource: hotkeyFile };
}

const tools = [
  { name: 'cvd_health', description: 'Check the local CodeViser CVD API bridge, ports, and session.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_reconnect', description: 'Reconnect the bridge to CVD-Multi-Server and the selected CVD Master API port.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_get_state', description: 'Read the current CVD state value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_get_debug_state', description: 'Read the current target debug-state value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_get_pc', description: 'Read the target program counter.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_run', description: 'Resume target execution from the current PC. Use only when the user explicitly asks to run or continue.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_stop', description: 'Stop target execution. Use only when the user explicitly asks to stop or halt.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_reset', description: 'Reset the target through CVD. Use only when the user explicitly asks for a reset.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_command', description: 'Execute one CVD command-line command. Use only when the user explicitly provides or requests that exact command. Never invent write, flash, erase, or configuration commands.', inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 1024 }, confirmed: { type: 'boolean', description: 'Must be true to acknowledge that this changes CVD or target state.' } }, required: ['command', 'confirmed'], additionalProperties: false } },
  { name: 'cvd_read_register', description: 'Read one target register. For Cortex-M, GE with index 0..15 is the usual general-register set.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: Object.keys(registerTypes), default: 'GE' }, index: { type: 'integer', minimum: 0 } }, required: ['index'], additionalProperties: false } },
  { name: 'cvd_read_memory', description: 'Read up to 1024 bytes from target memory. Address may be 0x-prefixed hex.', inputSchema: { type: 'object', properties: { space: { type: 'string', enum: Object.keys(memoryTypes), default: 'VM' }, address: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]+$' }, size: { type: 'integer', minimum: 1, maximum: 1024 } }, required: ['address', 'size'], additionalProperties: false } },
  { name: 'cvd_get_symbol', description: 'Resolve a loaded debug symbol to its address and size.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', minLength: 1 } }, required: ['symbol'], additionalProperties: false } },
  { name: 'cvd_search_source', description: 'Search a C/C++ project source directory. Pass the exact project directory as root. Use several concise domain terms and identifier fragments to find candidate variables, declarations, assignments, and references. This tool is read-only.', inputSchema: { type: 'object', properties: { root: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, required: ['root', 'query'], additionalProperties: false } },
  { name: 'cvd_read_source', description: 'Read a source-code excerpt around a search result. Pass the same project root used for source search; path must be relative to it. This tool is read-only.', inputSchema: { type: 'object', properties: { root: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 1 }, context: { type: 'integer', minimum: 0, maximum: 100, default: 20 } }, required: ['root', 'path', 'line'], additionalProperties: false } },
  { name: 'cvd_search_menu', description: 'Search the installed CVD menu and hotkey catalog. Translate the user intent to concise English search terms such as performance function list, callstack, trace, profile, memory, or register. Results explain whether a menu can be executed safely.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 } }, required: ['query'], additionalProperties: false } },
  { name: 'cvd_list_menus', description: 'List installed CVD menu catalog entries, optionally filtered by category. Use search for normal natural-language requests.', inputSchema: { type: 'object', properties: { category: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, additionalProperties: false } },
  { name: 'cvd_execute_menu', description: 'Execute one safe, exact CVD menu result by its catalog ID using its installed hotkey. Call only after menu search identifies the exact menu and the user asked to open or execute it. Reset, run-control, load, flash, clear, exit, and other mutating menus are blocked.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, confirmed: { type: 'boolean', description: 'Must be true to acknowledge the exact menu chosen from search results.' } }, required: ['id', 'confirmed'], additionalProperties: false } }
  ,{ name: 'cvd_discover_capability', description: 'Discover how to satisfy a CVD request when no obvious dedicated API tool exists. Translate the user intent to concise English capability terms. Returns both dedicated API tools and installed CVD menu candidates. Always call this before claiming that a requested CVD feature is unavailable.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 } }, required: ['query'], additionalProperties: false } }
];

async function callTool(name, args) {
  switch (name) {
    case 'cvd_health': return bridgeCall('health');
    case 'cvd_reconnect': return bridgeCall('reconnect');
    case 'cvd_get_state': return bridgeCall('get_state');
    case 'cvd_get_debug_state': return bridgeCall('get_debug_state');
    case 'cvd_get_pc': return bridgeCall('get_pc');
    case 'cvd_run': return bridgeCall('run');
    case 'cvd_stop': return bridgeCall('stop');
    case 'cvd_reset': return bridgeCall('reset');
    case 'cvd_command': {
      if (args.confirmed !== true) throw new Error('cvd_command requires confirmed=true. Ask the user to explicitly confirm the exact CVD command.');
      return bridgeCall('command', { text: args.command });
    }
    case 'cvd_read_register': return bridgeCall('read_register', { type: registerTypes[args.type || 'GE'], index: args.index });
    case 'cvd_read_memory': return bridgeCall('read_memory', { type: memoryTypes[args.space || 'VM'], address: args.address, size: args.size });
    case 'cvd_get_symbol': return bridgeCall('get_symbol', { symbol: args.symbol });
    case 'cvd_search_source': return searchSource(args.query, args.limit, args.root);
    case 'cvd_read_source': return readSource(args.path, args.line, args.context, args.root);
    case 'cvd_search_menu': return { query: args.query, source: hotkeyFile, matches: searchMenus(args.query, args.limit) };
    case 'cvd_list_menus': {
      const category = String(args.category || '').toLowerCase();
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, 100));
      const menus = loadMenuCatalog().filter(entry => !category || entry.category === category).slice(0, limit);
      return { source: hotkeyFile, category: category || null, count: menus.length, menus };
    }
    case 'cvd_execute_menu': {
      if (args.confirmed !== true) throw new Error('cvd_execute_menu requires confirmed=true after selecting an exact menu search result.');
      const entry = loadMenuCatalog().find(item => item.id === args.id);
      if (!entry) throw new Error(`Unknown CVD menu ID: ${args.id}`);
      if (!entry.safeToExecute) throw new Error(`Blocked menu: ${entry.name}. Only read-only/view menus can be executed.`);
      if (!entry.hotkey) throw new Error(`Menu '${entry.name}' has no installed hotkey. It can be searched and explained, but not executed automatically yet.`);
      return bridgeCall('menu_hotkey', { menuId: entry.id, name: entry.name, hotkey: entry.hotkey });
    }
    case 'cvd_discover_capability': return discoverCapabilities(args.query, args.limit);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (!Object.hasOwn(message, 'id')) return;
  try {
    let result;
    switch (message.method) {
      case 'initialize':
        result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codeviser', version: '0.5.0' } };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        try {
          const value = await callTool(message.params?.name, message.params?.arguments || {});
          logStatus('info', 'tool_ok', { tool: message.params?.name });
          result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
        } catch (error) {
          logStatus('error', 'tool_failed', { tool: message.params?.name, error: error.message });
          result = { content: [{ type: 'text', text: error.message }], isError: true };
        }
        break;
      }
      default: throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32000, message: error.message } });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  try { void handle(JSON.parse(line)); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
});

async function shutdown() {
  try { await bridgeQueue; } catch {}
}
process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
input.on('close', async () => { await shutdown(); process.exit(0); });
