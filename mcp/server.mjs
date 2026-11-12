import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, statSync
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_VERSION = '0.6.0';
export const SUPPORTED_PROTOCOL_VERSION = '2025-11-25';
export const SCRIPT_INTERFACE_VERSION = 1;
export const ACCESS_POLICIES = Object.freeze(['readonly', 'scripts', 'unrestricted']);

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const statusDirectory = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'CodeViserCodexBridge')
  : here;
const statusLog = process.env.CVD_STATUS_LOG || join(statusDirectory, 'status.log');

try { mkdirSync(dirname(statusLog), { recursive: true }); } catch {}

function logStatus(level, event, details = {}) {
  try {
    appendFileSync(statusLog, `${JSON.stringify({
      time: new Date().toISOString(), level, event, ...details
    })}\n`, 'utf8');
  } catch {}
}

export function normalizePolicy(value = 'scripts') {
  const policy = String(value || '').trim().toLowerCase();
  if (!ACCESS_POLICIES.includes(policy)) {
    throw new Error(`Invalid CVD_ACCESS_POLICY '${value}'. Expected readonly, scripts, or unrestricted.`);
  }
  return policy;
}

const accessPolicy = normalizePolicy(process.env.CVD_ACCESS_POLICY || 'scripts');
const guiAutomationEnabled =
  accessPolicy === 'unrestricted' &&
  /^(1|true|yes|on)$/i.test(process.env.CVD_ENABLE_GUI_AUTOMATION || '');

const ps32 = process.env.CVD_POWERSHELL32 ||
  'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const bridgeArgs = [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', join(here, 'cvd-bridge.ps1'),
  '-DllDirectory', process.env.CVD_API_DIR || 'C:\\JnDTech\\CVI\\CVD\\API\\BinR',
  '-HostAddress', process.env.CVD_HOST || '127.0.0.1',
  '-MultiServerPort', process.env.CVD_MULTI_PORT || '8888',
  '-CvdMasterPort', process.env.CVD_MASTER_PORT || '20000',
  '-TimeoutMs', process.env.CVD_TIMEOUT_MS || '5000'
];

function bridgeLaunch() {
  if (!process.env.CVD_BRIDGE_EXECUTABLE) {
    return { executable: ps32, args: bridgeArgs };
  }
  let args = [];
  if (process.env.CVD_BRIDGE_ARGS_JSON) {
    args = JSON.parse(process.env.CVD_BRIDGE_ARGS_JSON);
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) {
      throw new Error('CVD_BRIDGE_ARGS_JSON must be a JSON array of strings.');
    }
  }
  return { executable: process.env.CVD_BRIDGE_EXECUTABLE, args };
}

class PersistentBridge {
  constructor() {
    this.child = null;
    this.lines = null;
    this.startPromise = null;
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
  }

  async ensureStarted() {
    if (this.child && this.startPromise) return this.startPromise;

    const generation = ++this.generation;
    const { executable, args } = bridgeLaunch();
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines = lines;

    this.startPromise = new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(() => {
        const error = new Error('CVD bridge startup timed out.');
        error.transport = true;
        rejectStart(error);
        try { child.kill(); } catch {}
      }, 15000);
      timer.unref();

      const onReady = message => {
        clearTimeout(timer);
        if (message.ready) {
          logStatus('info', 'persistent_bridge_started', {
            pid: child.pid,
            connected: Boolean(message.connected),
            processBits: message.processBits
          });
          resolveStart(message);
        } else {
          const error = new Error(message.error || 'CVD bridge failed to start.');
          error.transport = true;
          rejectStart(error);
          try { child.kill(); } catch {}
        }
      };

      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); }
        catch {
          logStatus('error', 'bridge_invalid_json', { line: String(line).slice(0, 500) });
          return;
        }

        if (Object.hasOwn(message, 'ready')) {
          if (generation === this.generation) onReady(message);
          return;
        }

        const id = String(message.id ?? '');
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'CVD bridge request failed.'));
      });

      child.stderr.on('data', data => {
        const value = String(data);
        process.stderr.write(`[cvd-bridge] ${value}`);
        logStatus('error', 'bridge_stderr', { message: value.slice(0, 1000) });
      });

      child.on('error', error => {
        clearTimeout(timer);
        error.transport = true;
        rejectStart(error);
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const error = new Error(`CVD bridge exited (code=${code}, signal=${signal}).`);
        error.transport = true;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (generation === this.generation) {
          this.child = null;
          this.lines = null;
          this.startPromise = null;
        }
        logStatus(code === 0 ? 'info' : 'error', 'persistent_bridge_exit', { code, signal });
      });
    });

    return this.startPromise;
  }

  async call(command, args = {}, timeoutMs = 20000) {
    await this.ensureStarted();
    if (!this.child?.stdin?.writable) {
      const error = new Error('CVD bridge input is not writable.');
      error.transport = true;
      throw error;
    }

    const id = String(++this.sequence);
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`CVD operation timed out: ${command}`);
        error.transport = true;
        rejectCall(error);
        this.restart();
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.child.stdin.write(`${JSON.stringify({ id, command, ...args })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        error.transport = true;
        rejectCall(error);
      });
    });
  }

  restart() {
    if (this.child) {
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.lines = null;
    this.startPromise = null;
  }

  async shutdown() {
    if (!this.child) return;
    try { await this.call('shutdown', {}, 3000); } catch {}
    try { this.child?.stdin?.end(); } catch {}
  }
}

const persistentBridge = new PersistentBridge();
let bridgeQueue = Promise.resolve();
const retryableBridgeCommands = new Set([
  'health', 'reconnect', 'get_status', 'get_state', 'get_debug_state',
  'get_pc', 'read_register', 'read_memory', 'get_symbol'
]);

function bridgeCall(command, args = {}, timeoutMs = 20000) {
  const operation = bridgeQueue.then(async () => {
    try {
      return await persistentBridge.call(command, args, timeoutMs);
    } catch (error) {
      if (!error.transport || !retryableBridgeCommands.has(command)) throw error;
      logStatus('info', 'bridge_transport_retry', { command, error: error.message });
      persistentBridge.restart();
      return persistentBridge.call(command, args, timeoutMs);
    }
  });
  bridgeQueue = operation.catch(() => {});
  return operation;
}

const memoryTypes = {
  LM: 0, VM: 1, PM: 2, AHB: 3, EAHB: 4, ZAHB: 5, EZAHB: 6,
  APB: 7, EAPB: 8, AXI: 9, EAXI: 10, ZAXI: 11, EZAXI: 12,
  DBG: 13, EDBG: 14
};
const registerTypes = { GE: 0, C15: 1, C14: 2, ICE: 3, C10: 4, C11: 5 };
const configuredSourceRoot = process.env.CVD_SOURCE_ROOT
  ? resolve(process.env.CVD_SOURCE_ROOT)
  : '';
const sourceExtensions = new Set([
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx', '.s', '.asm', '.inc', '.ld', '.map'
]);

function sourceRootOrThrow(requestedRoot = '') {
  const sourceRoot = requestedRoot ? resolve(String(requestedRoot)) : configuredSourceRoot;
  if (!sourceRoot || !existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error('Source folder is not configured. Pass the project source directory in root.');
  }
  return realpathSync(sourceRoot);
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(rel).startsWith('..'));
}

function sourcePathOrThrow(path, requestedRoot = '') {
  const root = sourceRootOrThrow(requestedRoot);
  const fullPath = realpathSync(resolve(root, String(path || '')));
  if (!isInside(root, fullPath) || !existsSync(fullPath)) {
    throw new Error('Requested source path is outside the configured source folder or does not exist.');
  }
  return { root, fullPath, relativePath: relative(root, fullPath) };
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
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

function searchSource(query, limit = 50, requestedRoot = '') {
  const root = sourceRootOrThrow(requestedRoot);
  const rawQuery = String(query || '').trim();
  const terms = [...new Set(
    rawQuery.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length >= 2)
  )];
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
      matches.push({
        path: relativePath, line: index + 1, text: text.trim().slice(0, 500),
        matchedTerms: foundTerms, score
      });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return {
    sourceRoot: root, query: rawQuery, terms, scannedFiles, totalMatches: matches.length,
    matches: matches.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
  };
}

function readSource(path, line = 1, context = 20, requestedRoot = '') {
  const found = sourcePathOrThrow(path, requestedRoot);
  const lines = readFileSync(found.fullPath, 'utf8').split(/\r?\n/);
  const requestedLine = Math.max(1, Math.min(Number(line) || 1, Math.max(1, lines.length)));
  const radius = Math.max(0, Math.min(Number(context) || 20, 100));
  const startLine = Math.max(1, requestedLine - radius);
  const endLine = Math.min(lines.length, requestedLine + radius);
  const content = [];
  for (let number = startLine; number <= endLine; number++) {
    content.push({ line: number, text: lines[number - 1] });
  }
  return {
    sourceRoot: found.root, path: found.relativePath, requestedLine, startLine, endLine, content
  };
}

const hotkeyFile = process.env.CVD_HOTKEY_FILE ||
  'C:\\JnDTech\\CVI\\CVD\\Script\\cvd_hotkey.xml';
const safeMenuIdPrefixes = [
  'CVD_HOTKEY_VIEW_', 'CVD_HOTKEY_REGISTER_GENERAL', 'CVD_HOTKEY_REGISTER_CP',
  'CVD_HOTKEY_REGISTER_USER', 'CVD_HOTKEY_REGISTER_FPU', 'CVD_HOTKEY_SYMBOL_',
  'CVD_HOTKEY_PERF_PA_LIST', 'CVD_HOTKEY_SRP_STATUS_REGISTER',
  'CVD_HOTKEY_SRP_MAPLIST', 'CVD_HOTKEY_SRP_PROFILE', 'CVD_HOTKEY_HELP',
  'CVD_HOTKEY_BREAK_BP_LIST'
];

function decodeXml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function loadMenuCatalog() {
  const xml = readFileSync(hotkeyFile, 'utf8');
  const entries = [];
  for (const tag of xml.matchAll(/<SHORTCUT_INFO\s+([^>]*?)\s*\/>/g)) {
    const attrs = {};
    for (const attr of tag[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
      attrs[attr[1]] = decodeXml(attr[2]);
    }
    if (!attrs.ID || !attrs.name) continue;
    const safeToExecute = safeMenuIdPrefixes.some(prefix => attrs.ID.startsWith(prefix));
    entries.push({
      id: attrs.ID,
      name: attrs.name.trim(),
      description: (attrs.desc || '').trim(),
      hotkey: (attrs.key || '').trim(),
      category: attrs.ID.match(/^CVD_HOTKEY_([^_]+)/)?.[1]?.toLowerCase() || 'other',
      safeToExecute,
      executable: safeToExecute && Boolean((attrs.key || '').trim()) && guiAutomationEnabled
    });
  }
  return entries;
}

function searchMenus(query, limit = 10) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return loadMenuCatalog().map(entry => {
    const haystacks = [
      [entry.name.toLowerCase(), 8], [entry.description.toLowerCase(), 4],
      [entry.category.toLowerCase(), 3], [entry.id.toLowerCase(), 2]
    ];
    const score = terms.reduce(
      (total, term) => total + haystacks.reduce(
        (inner, [value, weight]) => inner + (value.includes(term) ? weight : 0), 0
      ), 0
    );
    return { ...entry, score };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 30)));
}

function configuredScriptRoots() {
  const configured = String(process.env.CVD_SCRIPT_ROOTS || join(packageRoot, 'skills'))
    .split(';').map(value => value.trim()).filter(Boolean);
  return configured.filter(root => existsSync(root) && statSync(root).isDirectory())
    .map(root => realpathSync(root));
}

export function parseScriptHeaderText(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 80);
  const commentLines = [];
  for (const line of lines) {
    const match = line.match(/^\s*;\s?(.*)$/);
    if (!match) {
      if (commentLines.length) break;
      if (line.trim()) break;
      continue;
    }
    commentLines.push(match[1]);
  }
  const joined = commentLines.join('\n').trim();
  const start = joined.indexOf('{');
  const end = joined.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('CMM script is missing its JSON interface header.');
  const header = JSON.parse(joined.slice(start, end + 1));
  if (header.interface !== SCRIPT_INTERFACE_VERSION) {
    throw new Error(`Unsupported CMM interface ${header.interface}; expected ${SCRIPT_INTERFACE_VERSION}.`);
  }
  if (header.arguments !== undefined &&
      (!header.arguments || typeof header.arguments !== 'object' || Array.isArray(header.arguments))) {
    throw new Error('CMM header arguments must be an object.');
  }
  return header;
}

function safePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 256 ||
      !pattern.startsWith('^') || !pattern.endsWith('$')) {
    throw new Error('Custom CMM argument patterns must be anchored with ^ and $ and be at most 256 characters.');
  }
  return new RegExp(pattern);
}

function validateScriptValue(name, value, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`Invalid argument specification for '${name}'.`);
  }
  const text = String(value);
  if (text.length > 512 || /[\r\n\0]/.test(text)) {
    throw new Error(`CMM argument '${name}' is too long or contains a control character.`);
  }
  let accepted = false;
  let quote = false;
  if (Array.isArray(spec.enum)) {
    accepted = spec.enum.map(String).includes(text);
  } else if (spec.pattern) {
    accepted = safePattern(spec.pattern).test(text);
  } else {
    switch (spec.type) {
      case 'address': accepted = /^[A-Za-z0-9_:.+\-\[\]]+$/.test(text); break;
      case 'symbol': accepted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(text); break;
      case 'wildcard': accepted = /^[A-Za-z0-9_:.*?\[\]]+$/.test(text); break;
      case 'number': accepted = /^[0-9]+\.?$/.test(text); break;
      case 'string':
        accepted = !/["&\x00-\x1f]/.test(text);
        quote = true;
        break;
      default: throw new Error(`Unknown CMM argument type for '${name}'.`);
    }
  }
  if (!accepted) throw new Error(`CMM argument '${name}' did not match its declared schema.`);
  return quote ? `"${text}"` : text;
}

export function validateScriptArguments(header, supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error('CMM arguments must be an object.');
  }
  const definitions = header.arguments || {};
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(definitions, key)) throw new Error(`Unknown CMM argument: ${key}`);
  }
  const rendered = [];
  for (const [name, spec] of Object.entries(definitions)) {
    if (!Object.hasOwn(supplied, name)) {
      if (spec.optional === true) continue;
      throw new Error(`Missing required CMM argument: ${name}`);
    }
    rendered.push(validateScriptValue(name, supplied[name], spec));
  }
  return rendered;
}

function resolveSkillScript(skill, script) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(skill || ''))) {
    throw new Error('skill must contain only letters, digits, dot, underscore, or hyphen.');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(String(script || ''))) {
    throw new Error('script must be a simple file name without directories.');
  }
  const fileName = String(script).toLowerCase().endsWith('.cmm') ? String(script) : `${script}.cmm`;
  for (const root of configuredScriptRoots()) {
    const skillDirectory = resolve(root, String(skill));
    const skillFile = join(skillDirectory, 'SKILL.md');
    const candidate = resolve(skillDirectory, 'scripts', fileName);
    if (!existsSync(skillFile) || !existsSync(candidate)) continue;
    const realCandidate = realpathSync(candidate);
    if (!isInside(root, realCandidate) || extname(realCandidate).toLowerCase() !== '.cmm') continue;
    const stat = statSync(realCandidate);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('CMM script is not a normal file or is too large.');
    return { root, path: realCandidate, skillFile };
  }
  throw new Error(`Approved CMM script not found: ${skill}/${fileName}`);
}

function listApprovedScripts() {
  const skills = [];
  for (const root of configuredScriptRoots()) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillDirectory = join(root, entry.name);
      const skillFile = join(skillDirectory, 'SKILL.md');
      const scriptsDirectory = join(skillDirectory, 'scripts');
      if (!existsSync(skillFile) || !existsSync(scriptsDirectory)) continue;
      const scripts = [];
      for (const file of readdirSync(scriptsDirectory, { withFileTypes: true })) {
        if (!file.isFile() || extname(file.name).toLowerCase() !== '.cmm') continue;
        const path = join(scriptsDirectory, file.name);
        try {
          const header = parseScriptHeaderText(readFileSync(path, 'utf8'));
          scripts.push({
            name: file.name.slice(0, -4),
            safe: header.safe === true,
            arguments: header.arguments || {},
            interface: header.interface
          });
        } catch (error) {
          scripts.push({ name: file.name.slice(0, -4), valid: false, error: error.message });
        }
      }
      skills.push({ skill: entry.name, root, scripts });
    }
  }
  return { policy: accessPolicy, skillRoots: configuredScriptRoots(), skills };
}

async function runApprovedScript(args) {
  const found = resolveSkillScript(args.skill, args.script);
  const text = readFileSync(found.path, 'utf8');
  const header = parseScriptHeaderText(text);
  if (accessPolicy === 'scripts' && header.safe !== true) {
    throw new Error('The scripts policy only runs CMM files that declare "safe": true.');
  }
  const renderedArguments = validateScriptArguments(header, args.arguments || {});
  return bridgeCall('run_script', {
    path: found.path,
    argumentsText: renderedArguments.join(' '),
    settleMs: Math.max(0, Math.min(Number(args.settleMs) || 250, 5000))
  }, Math.max(20000, (Number(args.timeout) || 10) * 1000));
}

async function runGuiMenu(entry) {
  const executable = process.env.CVD_POWERSHELL ||
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(here, 'cvd-gui.ps1'),
    '-MenuId', entry.id, '-MenuName', entry.name, '-Hotkey', entry.hotkey
  ];
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectCall(new Error('CVD GUI helper timed out.'));
    }, 10000);
    timer.unref();
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return rejectCall(new Error(stderr.trim() || `CVD GUI helper failed: ${code}`));
      try { resolveCall(JSON.parse(stdout.trim())); }
      catch { rejectCall(new Error(`CVD GUI helper returned invalid JSON: ${stdout}`)); }
    });
  });
}

const objectOutput = { type: 'object', additionalProperties: true };
const statusOutput = {
  type: 'object',
  properties: {
    policy: { type: 'string', enum: ACCESS_POLICIES },
    api: { type: 'object' },
    target: { type: 'object' }
  },
  required: ['policy', 'api', 'target'],
  additionalProperties: true
};

const toolDefinitions = [
  { name: 'cvd_get_status', policies: ACCESS_POLICIES, outputSchema: statusOutput,
    description: 'Use this first for any CodeViser, CVD, debugger, target, board, connection, state, or PC request. Returns API health, CVD state, debug state, and PC in one structured result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_health', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Check only the local CodeViser CVD API bridge and session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_reconnect', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Reconnect the persistent bridge to CVD-Multi-Server and CVD Master.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_get_state', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Read the CVD state value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_get_debug_state', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Read the target debug-state value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_get_pc', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Read the target program counter.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_read_register', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Read one target register. Cortex-M general registers normally use GE index 0 through 15.',
    inputSchema: { type: 'object', properties: {
      type: { type: 'string', enum: Object.keys(registerTypes), default: 'GE' },
      index: { type: 'integer', minimum: 0 }
    }, required: ['index'], additionalProperties: false } },
  { name: 'cvd_read_memory', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Read up to 1024 bytes from target memory.',
    inputSchema: { type: 'object', properties: {
      space: { type: 'string', enum: Object.keys(memoryTypes), default: 'VM' },
      address: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]+$' },
      size: { type: 'integer', minimum: 1, maximum: 1024 }
    }, required: ['address', 'size'], additionalProperties: false } },
  { name: 'cvd_get_symbol', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Resolve a loaded debug symbol to its address and size.',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_:.$]*$' }
    }, required: ['symbol'], additionalProperties: false } },
  { name: 'cvd_search_source', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Search a configured C/C++ source tree for variables, declarations, assignments, and references. Read-only.',
    inputSchema: { type: 'object', properties: {
      root: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
    }, required: ['root', 'query'], additionalProperties: false } },
  { name: 'cvd_read_source', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Read a source excerpt around a source-search result. Read-only.',
    inputSchema: { type: 'object', properties: {
      root: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
      line: { type: 'integer', minimum: 1 },
      context: { type: 'integer', minimum: 0, maximum: 100, default: 20 }
    }, required: ['root', 'path', 'line'], additionalProperties: false } },
  { name: 'cvd_search_menu', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'Search and explain installed CVD menus. This does not interact with the GUI.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 }
    }, required: ['query'], additionalProperties: false } },
  { name: 'cvd_list_menus', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'List installed CVD menu catalog entries without executing them.',
    inputSchema: { type: 'object', properties: {
      category: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
    }, additionalProperties: false } },
  { name: 'cvd_list_scripts', policies: ACCESS_POLICIES, outputSchema: objectOutput,
    description: 'List approved CodeViser CMM skills, script names, safety declarations, and argument schemas without executing anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_run', policies: ['scripts', 'unrestricted'], outputSchema: objectOutput,
    description: 'Resume target execution. Use only when the user explicitly asks to run or continue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_stop', policies: ['scripts', 'unrestricted'], outputSchema: objectOutput,
    description: 'Stop target execution. Use only when the user explicitly asks to halt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_reset', policies: ['scripts', 'unrestricted'], outputSchema: objectOutput,
    description: 'Reset the target. Use only when the user explicitly asks for reset.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'cvd_run_script', policies: ['scripts', 'unrestricted'], outputSchema: objectOutput,
    description: 'Run an approved CMM file packaged inside a registered agent skill. Under scripts policy the CMM header must declare safe=true and every argument is schema-validated.',
    inputSchema: { type: 'object', properties: {
      skill: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' },
      script: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' },
      arguments: { type: 'object', default: {}, additionalProperties: true },
      timeout: { type: 'integer', minimum: 1, maximum: 120, default: 10 },
      settleMs: { type: 'integer', minimum: 0, maximum: 5000, default: 250 }
    }, required: ['skill', 'script'], additionalProperties: false } },
  { name: 'cvd_command', policies: ['unrestricted'], outputSchema: objectOutput,
    description: 'Execute one exact CVD command only in unrestricted policy. Never invent Flash, Erase, write, load, host-OS, or configuration commands.',
    inputSchema: { type: 'object', properties: {
      command: { type: 'string', minLength: 1, maxLength: 1024 },
      confirmed: { type: 'boolean' },
      settleMs: { type: 'integer', minimum: 0, maximum: 5000, default: 250 }
    }, required: ['command', 'confirmed'], additionalProperties: false } },
  { name: 'cvd_execute_menu', policies: ['unrestricted'], requiresGui: true, outputSchema: objectOutput,
    description: 'Opt-in GUI automation for one safe exact menu ID. Disabled unless unrestricted policy and CVD_ENABLE_GUI_AUTOMATION=true.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', minLength: 1 }, confirmed: { type: 'boolean' }
    }, required: ['id', 'confirmed'], additionalProperties: false } }
];

export function getAvailableTools(policy = accessPolicy, enableGui = guiAutomationEnabled) {
  const normalized = normalizePolicy(policy);
  return toolDefinitions
    .filter(tool => tool.policies.includes(normalized) && (!tool.requiresGui || enableGui))
    .map(({ policies, requiresGui, ...tool }) => tool);
}

const availableTools = getAvailableTools();
const availableToolNames = new Set(availableTools.map(tool => tool.name));

function serverInstructions() {
  return [
    'This is the local CodeViser CVD debugger MCP server.',
    'Use cvd_get_status first whenever the user refers to CVD, CodeViser, a debugger, target, board, core, PC, register, memory, symbol, breakpoint, CMM, or embedded debugging, even if the user does not name this MCP server.',
    `The active access policy is '${accessPolicy}'. It cannot be elevated through an MCP tool.`,
    accessPolicy === 'readonly'
      ? 'Only read-only diagnostics, source inspection, and menu discovery are available.'
      : 'Run, stop, reset, and approved CMM scripts require an explicit user request.',
    accessPolicy === 'unrestricted'
      ? 'Exact raw commands are available, but never invent Flash, Erase, memory/register writes, image loading, host-OS commands, or configuration-changing commands.'
      : 'Arbitrary CVD commands are disabled by policy.',
    'Use cvd_list_scripts to discover approved CMM procedures and cvd_run_script to execute one. Do not construct CD.DO command strings yourself.',
    'CVDAPI.dll reports command acceptance but does not expose CVD console text. Command and CMM results therefore include structured before/after target observations when available.',
    'Menu search is read-only. GUI hotkey execution is isolated and normally disabled.'
  ].join('\n');
}

async function callTool(name, args = {}) {
  if (!availableToolNames.has(name)) {
    throw new Error(`Tool '${name}' is not available under the '${accessPolicy}' policy.`);
  }
  switch (name) {
    case 'cvd_get_status':
      return { policy: accessPolicy, ...(await bridgeCall('get_status')) };
    case 'cvd_health': return { policy: accessPolicy, ...(await bridgeCall('health')) };
    case 'cvd_reconnect': return bridgeCall('reconnect');
    case 'cvd_get_state': return bridgeCall('get_state');
    case 'cvd_get_debug_state': return bridgeCall('get_debug_state');
    case 'cvd_get_pc': return bridgeCall('get_pc');
    case 'cvd_run': return bridgeCall('run');
    case 'cvd_stop': return bridgeCall('stop');
    case 'cvd_reset': return bridgeCall('reset');
    case 'cvd_read_register':
      return bridgeCall('read_register', {
        type: registerTypes[args.type || 'GE'], index: args.index
      });
    case 'cvd_read_memory':
      return bridgeCall('read_memory', {
        type: memoryTypes[args.space || 'VM'], address: args.address, size: args.size
      });
    case 'cvd_get_symbol':
      return bridgeCall('get_symbol', { symbol: args.symbol });
    case 'cvd_search_source':
      return searchSource(args.query, args.limit, args.root);
    case 'cvd_read_source':
      return readSource(args.path, args.line, args.context, args.root);
    case 'cvd_search_menu':
      return { query: args.query, source: hotkeyFile, matches: searchMenus(args.query, args.limit) };
    case 'cvd_list_menus': {
      const category = String(args.category || '').toLowerCase();
      const limit = Math.max(1, Math.min(Number(args.limit) || 50, 100));
      const menus = loadMenuCatalog().filter(entry => !category || entry.category === category).slice(0, limit);
      return { source: hotkeyFile, category: category || null, count: menus.length, menus };
    }
    case 'cvd_list_scripts': return listApprovedScripts();
    case 'cvd_run_script': return runApprovedScript(args);
    case 'cvd_command':
      if (args.confirmed !== true) {
        throw new Error('cvd_command requires confirmed=true after an explicit user request.');
      }
      if (/[\r\n\0]/.test(args.command)) throw new Error('cvd_command accepts one line only.');
      return bridgeCall('command', {
        text: args.command,
        settleMs: Math.max(0, Math.min(Number(args.settleMs) || 250, 5000))
      });
    case 'cvd_execute_menu': {
      if (args.confirmed !== true) {
        throw new Error('cvd_execute_menu requires confirmed=true after selecting an exact menu.');
      }
      const entry = loadMenuCatalog().find(item => item.id === args.id);
      if (!entry) throw new Error(`Unknown CVD menu ID: ${args.id}`);
      if (!entry.safeToExecute || !entry.hotkey) {
        throw new Error(`Blocked or unavailable menu: ${entry.name}`);
      }
      return runGuiMenu(entry);
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function toolSuccess(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false
  };
}

function toolFailure(error) {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { error: error.message },
    isError: true
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function processRpcMessage(message, toolCaller = callTool) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id ?? null, -32600, 'Invalid Request');
  }
  const isNotification = !Object.hasOwn(message, 'id');
  if (isNotification) return null;

  try {
    let result;
    switch (message.method) {
      case 'initialize': {
        if (typeof message.params?.protocolVersion !== 'string') {
          return rpcError(message.id, -32602, 'initialize requires protocolVersion');
        }
        result = {
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'codeviser',
            title: 'CodeViser CVD Debugger',
            version: SERVER_VERSION
          },
          instructions: serverInstructions()
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: availableTools }; break;
      case 'resources/list': result = { resources: [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      case 'tools/call': {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
          return rpcError(message.id, -32602, 'tools/call requires a tool name and object arguments');
        }
        try {
          const value = await toolCaller(name, args);
          logStatus('info', 'tool_ok', { tool: name });
          result = toolSuccess(value);
        } catch (error) {
          logStatus('error', 'tool_failed', { tool: name, error: error.message });
          result = toolFailure(error);
        }
        break;
      }
      default: return rpcError(message.id, -32601, `Method not found: ${message.method}`);
    }
    return { jsonrpc: '2.0', id: message.id, result };
  } catch (error) {
    return rpcError(message.id, -32603, error.message);
  }
}

function send(message) {
  if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch {
      send(rpcError(null, -32700, 'Parse error'));
      return;
    }
    void processRpcMessage(message).then(send);
  });

  const shutdown = async () => {
    try { await bridgeQueue; } catch {}
    await persistentBridge.shutdown();
  };
  process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
  input.on('close', async () => { await shutdown(); process.exit(0); });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
