import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { SERVICE_KEY_CATALOG } from './llm-env-detect.js';

const SERVICE_KEY_ENV_NAMES = new Set(SERVICE_KEY_CATALOG
  .filter(item => item.kind === 'api-key')
  .flatMap(item => item.envNames));

/** Read a multi-line dotenv paste in raw mode. No pasted character is echoed; Ctrl-D finishes. */
export async function readMaskedServiceEnvPaste(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('secret input requires a terminal');
  stdout.write('Paste .env assignments; input stays hidden. Press Ctrl-D when finished.\n');
  const priorRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(priorRaw);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        const code = char.charCodeAt(0);
        if (code === 4) {
          stdout.write('\n');
          cleanup();
          resolve(value);
          return;
        }
        if (code === 3) {
          stdout.write('\n');
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\r') continue;
        if (char === '\n') {
          value += '\n';
          stdout.write('\n');
          continue;
        }
        if (char === '\b' || code === 127) {
          const characters = Array.from(value);
          if (characters.length > 0) {
            const removedNewline = characters.at(-1) === '\n';
            characters.pop();
            value = characters.join('');
            stdout.write(removedNewline ? '\u001b[1A\r\u001b[K' : '\b \b');
          }
          continue;
        }
        if (code < 32) continue;
        value += char;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export type ParsedServiceKeyEnv = ReadonlyMap<string, string>;

/** Parse dotenv assignments without expansion and never include values in errors. */
export function parseServiceKeyEnv(text: string): ParsedServiceKeyEnv {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error('invalid env assignment');
    const name = match[1]!;
    if (!SERVICE_KEY_ENV_NAMES.has(name)) throw new Error(`unsupported env name: ${name}`);
    if (values.has(name)) throw new Error(`duplicate env name: ${name}`);
    let value = match[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      if (value.length < 2 || value.at(-1) !== quote) throw new Error(`invalid quoted value for ${name}`);
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (!value || value.includes('\0')) throw new Error(`empty or invalid value for ${name}`);
    values.set(name, value);
  }
  return values;
}

export interface ServiceKeyStatus {
  id: string;
  label: string;
  envNames: string[];
  configured: boolean;
  kind: string;
}

function cachePath(name: string, cacheDir: string): string {
  if (!SERVICE_KEY_ENV_NAMES.has(name)) throw new Error(`unsupported env name: ${name}`);
  return join(cacheDir, name.toLowerCase());
}

function cachedValue(name: string, cacheDir: string): string | undefined {
  const path = cachePath(name, cacheDir);
  if (!existsSync(path)) return undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch { return undefined; }
}

export function serviceKeyStatus(options: {
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
} = {}): ServiceKeyStatus[] {
  const env = options.env ?? process.env;
  const cacheDir = options.cacheDir ?? (process.env.ELANOUS_KEY_CACHE_DIR?.trim() || join(homedir(), '.cache'));
  return SERVICE_KEY_CATALOG.map(item => ({
    id: item.id,
    label: item.label,
    envNames: [...item.envNames],
    kind: item.kind,
    configured: item.kind === 'api-key'
      ? item.envNames.some(name => Boolean(env[name]?.trim() || cachedValue(name, cacheDir)))
      : false,
  }));
}

/** Persist accepted service keys into the established ~/.cache/<env lowercase> store. */
export function storeServiceKeys(values: ParsedServiceKeyEnv, options: {
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): { stored: string[] } {
  const cacheDir = options.cacheDir ?? (process.env.ELANOUS_KEY_CACHE_DIR?.trim() || join(homedir(), '.cache'));
  const env = options.env ?? process.env;
  for (const [name, value] of values) {
    cachePath(name, cacheDir);
    if (!value.trim() || value.includes('\0')) throw new Error(`invalid value for ${name}`);
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(cacheDir);
  if (!dirStat.isDirectory()) throw new Error('invalid key cache directory');
  for (const [name, value] of values) {
    const path = cachePath(name, cacheDir);
    const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, `${value.trim()}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, path);
      env[name] = value.trim();
    } finally { rmSync(temp, { force: true }); }
  }
  return { stored: [...values.keys()].sort() };
}

export type ServiceKeyVerification = 'verified' | 'invalid' | 'rate-limited' | 'unavailable' | 'unsupported';

export interface VerifyServiceKeyOptions {
  /** Existing per-provider endpoint, such as llm.rotation[].baseUrl. */
  baseUrl?: string;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function modelsUrl(baseUrl: string | undefined, defaultRoot: string): string {
  const root = (baseUrl || defaultRoot).replace(/\/+$/, '');
  return `${root}/models`;
}

/** One bounded minimal request. Results contain only a category and status code; errors and URLs are discarded. */
export async function verifyServiceKey(id: string, key: string, options: VerifyServiceKeyOptions = {}): Promise<{ result: ServiceKeyVerification; httpStatus?: number }> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  let url: string;
  let init: RequestInit;
  const bearer = (endpoint: string): void => {
    url = endpoint;
    init = { method: 'GET', headers: { authorization: `Bearer ${key}` } };
  };
  switch (id) {
    case 'exa':
      url = 'https://api.exa.ai/search';
      init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ query: 'credential check', numResults: 1 }) };
      break;
    case 'firecrawl':
      url = 'https://api.firecrawl.dev/v2/scrape';
      init = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }) };
      break;
    case 'xai': bearer(modelsUrl(options.baseUrl, 'https://api.x.ai/v1')); break;
    case 'tavily':
      url = 'https://api.tavily.com/search';
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key, query: 'credential check', max_results: 1 }) };
      break;
    case 'openrouter': bearer('https://openrouter.ai/api/v1/key'); break;
    case 'linear':
      url = 'https://api.linear.app/graphql';
      init = { method: 'POST', headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query: 'query { viewer { id } }' }) };
      break;
    case 'telegram': bearer(`https://api.telegram.org/bot${key}/getMe`); break;
    case 'openai-api': bearer(modelsUrl(options.baseUrl || process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1')); break;
    case 'anthropic-api':
      url = 'https://api.anthropic.com/v1/models';
      init = { method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
      break;
    case 'gemini-api':
      url = 'https://generativelanguage.googleapis.com/v1beta/models';
      init = { method: 'GET', headers: { 'x-goog-api-key': key } };
      break;
    case 'opengateway': bearer('https://apis.opengateway.ai/v1/models'); break;
    case 'telegram-chat': {
      const bot = env.ELANOUS_TELEGRAM_BOT_TOKEN?.trim() || cachedValue('ELANOUS_TELEGRAM_BOT_TOKEN', options.cacheDir ?? (process.env.ELANOUS_KEY_CACHE_DIR?.trim() || join(homedir(), '.cache')));
      if (!bot) return { result: 'unsupported' };
      url = `https://api.telegram.org/bot${bot}/getChat?chat_id=${encodeURIComponent(key)}`;
      init = { method: 'GET' };
      break;
    }
    default: return { result: 'unsupported' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url!, { ...init!, signal: controller.signal });
    if (response.status >= 200 && response.status < 300) return { result: 'verified', httpStatus: response.status };
    if (response.status === 401 || response.status === 403) return { result: 'invalid', httpStatus: response.status };
    if (response.status === 429) return { result: 'rate-limited', httpStatus: response.status };
    return { result: 'unavailable', httpStatus: response.status };
  } catch {
    return { result: 'unavailable' };
  } finally { clearTimeout(timer); }
}
