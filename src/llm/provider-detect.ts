import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { authStorePath } from '../oauth/store.js';
import { envLiteral } from '../platform/env-literal.js';

/** Discovery is read-only; agent-cli entries are not direct-call LLM providers. */
export interface DetectedProvider {
  provider: string;
  auth: 'oauth' | 'apikey' | 'local' | 'agent-cli';
  source: string;
  available: boolean;
  rank: number;
  agent?: { cli: 'claude' | 'agy'; loggedIn: boolean | null; storedLoggedIn?: boolean | null; method?: string; via: string };
}

export interface ProviderDetectDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** elanous auth store path; default = the shared `authStorePath()` (no home-relative literal here — isolation gate). */
  authStore?: string;
  readFile?: (path: string) => Promise<string>;
  access?: (path: string) => Promise<boolean>;
  isFile?: (path: string) => Promise<boolean>;
  isDirectory?: (path: string) => Promise<boolean>;
  runCli?: (args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<string>;
  now?: () => number;
}

const LIMIT_MS = 3_000;
const CLAUDE_LIMIT_MS = 5_000;
const ORDER = ['openai-codex', 'anthropic', 'grok', 'gemini', 'openrouter', 'openai', 'ollama', 'local'] as const;
const AGENT_RANK = { 'claude-code': -2, antigravity: -1 } as const;
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  'elanous-auth': 0,
  'codex-auth': 1,
  'gemini-auth': 1,
  'grok-auth': 1,
};
const ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function populated(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function oauthUsable(value: unknown, now: number): boolean {
  const state = record(value);
  if (!state) return false;
  const tokens = record(state.tokens) ?? state;
  const accessToken = tokens.accessToken ?? tokens.access_token;
  const refreshToken = tokens.refreshToken ?? tokens.refresh_token;
  if (populated(refreshToken)) return true;
  if (!populated(accessToken)) return false;
  const rawExpiry = tokens.expiresAt ?? tokens.expires_at;
  if (rawExpiry === undefined || rawExpiry === null) return true;
  const expiry = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : rawExpiry;
  return typeof expiry === 'number' && Number.isFinite(expiry) && expiry > now;
}

/** Claude status is queried via the official CLI; no keychain call or credential-file read/write is performed. */
export async function detectProviders(deps: ProviderDetectDeps = {}): Promise<DetectedProvider[]> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? homedir();
  const clock = deps.now ?? Date.now;
  const started = clock();
  const file = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const executable = deps.access ?? (async (path: string) => {
    try { await access(path, constants.X_OK); return true; } catch { return false; }
  });
  const isFile = deps.isFile ?? (async (path: string) => {
    try { return (await stat(path)).isFile(); } catch { return false; }
  });
  const isDirectory = deps.isDirectory ?? (async (path: string) => {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
  });
  const runCli = deps.runCli ?? ((args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => new Promise<string>((resolve, reject) => {
    execFile('claude', args, { timeout: options.timeoutMs, maxBuffer: 64 * 1024, env: options.env }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  }));
  const claudeStatus = (statusEnv: NodeJS.ProcessEnv) => new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), CLAUDE_LIMIT_MS);
    void Promise.resolve().then(() => runCli(['auth', 'status', '--json'], { timeoutMs: CLAUDE_LIMIT_MS, env: statusEnv }))
      .then((value) => {
        clearTimeout(timer);
        try { resolve(record(JSON.parse(value) as unknown)); } catch { resolve(null); }
      }, () => { clearTimeout(timer); resolve(null); });
  });
  const storedEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
    name !== 'CLAUDE_CODE_OAUTH_TOKEN' && name !== 'CLAUDECODE' &&
    name !== 'CLAUDE_CODE_ENTRYPOINT' && name !== 'ANTHROPIC_AUTH_TOKEN' &&
    name !== 'ANTHROPIC_API_KEY' &&
    !name.startsWith('CLAUDE_CODE_SESSION_'),
  ));
  const found = new Map<string, DetectedProvider>();
  let accepting = true;
  const add = (provider: string, auth: DetectedProvider['auth'], source: string) => {
    if (!accepting || clock() - started >= LIMIT_MS) return;
    const rank = ORDER.indexOf(provider as typeof ORDER[number]);
    if (rank < 0) return;
    const candidate = { provider, auth, source, available: true, rank: rank * 2 + (auth === 'apikey' ? 1 : 0) };
    const previous = found.get(provider);
    if (!previous || candidate.rank < previous.rank ||
        (candidate.rank === previous.rank &&
          (SOURCE_PRIORITY[source] ?? 2) < (SOURCE_PRIORITY[previous.source] ?? 2))) {
      found.set(provider, candidate);
    }
  };
  const agentEvidence = { cli: false, statusValid: false, credentials: false, env: [] as string[], loggedIn: null as boolean | null, storedLoggedIn: null as boolean | null, method: undefined as string | undefined };
  const updateClaude = () => {
    if (!accepting || clock() - started >= LIMIT_MS) return;
    if (!agentEvidence.cli && !agentEvidence.credentials && agentEvidence.env.length === 0) return;
    const source = agentEvidence.statusValid ? 'claude-auth-status'
      : agentEvidence.credentials ? 'credentials-file'
      : agentEvidence.env.length > 0 ? `env:${agentEvidence.env[0]}` : 'path:claude';
    const via = [
      ...(agentEvidence.statusValid ? ['claude-auth-status'] : agentEvidence.cli ? ['path:claude'] : []),
      ...(agentEvidence.credentials ? ['credentials-file'] : []),
      ...agentEvidence.env.map((name) => `env:${name}`),
    ].join(', ');
    found.set('claude-code', {
      provider: 'claude-code', auth: 'agent-cli', source,
      available: agentEvidence.loggedIn === true, rank: AGENT_RANK['claude-code'],
      agent: { cli: 'claude', loggedIn: agentEvidence.loggedIn, storedLoggedIn: agentEvidence.storedLoggedIn,
        ...(agentEvidence.method ? { method: agentEvidence.method } : {}), via },
    });
  };
  const json = async (path: string): Promise<Record<string, unknown> | null> => {
    try { return record(JSON.parse(await file(path)) as unknown); } catch { return null; }
  };
  const inspect = async () => {
    // Read stores concurrently so a slow or unreadable store cannot hide the others.
    const storePath = env.XDG_CONFIG_HOME?.trim()
      ? join(env.XDG_CONFIG_HOME, 'elanous', 'auth.json')
      : deps.authStore ?? authStorePath();
    for (const [provider, keys] of Object.entries(ENV_KEYS)) {
      const key = keys.find((name) => populated(env[name]));
      if (key) add(provider, 'apikey', `env:${key}`);
    }
    if (populated(env.LOCAL_LLM_URL)) add('local', 'local', 'env:LOCAL_LLM_URL');
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
      if (populated(env[name])) agentEvidence.env.push(name);
    }
    updateClaude();
    const agyInstall = Promise.resolve().then(() => isDirectory(join(home, '.gemini', 'antigravity-cli'))).catch(() => false);
    const files = [
      json(storePath).then((store) => {
        const providers = record(store?.providers);
        if (!providers) return;
        for (const [name, state] of Object.entries(providers)) {
          const provider = name.startsWith('openai-codex:') ? 'openai-codex' : name;
          if (oauthUsable(state, clock())) add(provider, 'oauth', 'elanous-auth');
        }
      }),
      json(join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json')).then((codex) => {
        if (oauthUsable(codex?.tokens, clock())) add('openai-codex', 'oauth', 'codex-auth');
      }),
      Promise.resolve().then(() => isFile(join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), '.credentials.json'))).then((exists) => {
        if (exists) { agentEvidence.credentials = true; updateClaude(); }
      }).catch(() => {}),
      json(join(home, '.gemini', 'oauth_creds.json')).then((gemini) => {
        if (oauthUsable(gemini, clock())) add('gemini', 'oauth', 'gemini-auth');
      }),
      json(join(home, '.grok', 'auth.json')).then((grok) => {
        if (grok && Object.values(grok).some((entry) => {
          const scope = record(entry);
          if (!scope) return false;
          if (populated(scope.refresh_token)) return true;
          if (!populated(scope.key)) return false;
          if (scope.expires_at === undefined || scope.expires_at === null) return true;
          const expiry = typeof scope.expires_at === 'string' ? Date.parse(scope.expires_at) : scope.expires_at;
          return typeof expiry === 'number' && Number.isFinite(expiry) && expiry > clock();
        })) add('grok', 'oauth', 'grok-auth');
      }),
    ];
    const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
    const onPath = (name: string) => new Promise<boolean>((resolve) => {
      let pending = dirs.length;
      if (!pending) resolve(false);
      for (const dir of dirs) {
        const path = join(dir, name);
        void Promise.resolve().then(async () =>
          (await executable(path)) && (await isFile(path)),
        ).then(
          (available) => {
            if (available) resolve(true);
            else if (--pending === 0) resolve(false);
          },
          () => { if (--pending === 0) resolve(false); },
        );
      }
    });
    const pathChecks = [
      onPath('ollama').then((exists) => { if (exists) add('ollama', 'local', 'path:ollama'); }),
      onPath('claude').then(async (exists) => {
        if (!exists || !accepting) return;
        agentEvidence.cli = true;
        updateClaude();
        const [status, storedStatus] = await Promise.all([claudeStatus(env), claudeStatus(envLiteral(storedEnv))]);
        if (!accepting) return;
        if (typeof status?.loggedIn === 'boolean') {
          agentEvidence.statusValid = true;
          agentEvidence.loggedIn = status.loggedIn;
          if (status.authMethod === 'claude.ai' || status.authMethod === 'oauth_token' ||
              status.authMethod === 'api_key') agentEvidence.method = status.authMethod;
        }
        if (typeof storedStatus?.loggedIn === 'boolean') agentEvidence.storedLoggedIn = storedStatus.loggedIn;
        updateClaude();
      }),
      Promise.all([onPath('agy'), agyInstall]).then(([cli, installed]) => {
        if (cli && installed && accepting && clock() - started < LIMIT_MS) found.set('antigravity', {
          provider: 'antigravity', auth: 'agent-cli', source: 'agy-install', available: true,
          rank: AGENT_RANK.antigravity, agent: { cli: 'agy', loggedIn: null, via: 'install-dir' },
        });
      }),
    ];
    await Promise.all([...files, ...pathChecks]);
    return [...found.values()].sort((a, b) => a.rank - b.rank);
  };
  // A wall-clock timer bounds even a dependency that never settles. Late reads cannot change the returned snapshot.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      inspect(),
      new Promise<DetectedProvider[]>((resolve) => {
        timer = setTimeout(() => resolve([...found.values()].sort((a, b) => a.rank - b.rank)), LIMIT_MS);
      }),
    ]);
  } finally {
    accepting = false;
    if (timer) clearTimeout(timer);
  }
}
