import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Agent = 'claude' | 'codex' | 'grok' | 'gemini';

function versionOf(binary: string): string | null {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
  const line = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/, 1)[0];
  return result.status === 0 && line && /^[\w .+()-]{1,100}$/.test(line) ? line : null;
}

// Plugin and marketplace keys are `name@marketplace`; check each part instead of redacting every scoped name.
function safePluginName(name: string): string {
  const parts = name.split('@');
  return parts.length <= 2 && parts.every(part => part !== '' && safeIdentifier(part) === part) ? name : '<redacted>';
}

function safeNames(path: string): string[] | '«없음»' {
  return !existsSync(path) ? '«없음»' : readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => safeIdentifier(entry.name) ?? '<redacted>').sort();
}
type Presence = 'present' | '«없음»';

function present(path: string): Presence {
  return existsSync(path) ? 'present' : '«없음»';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function json(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return record(JSON.parse(readFileSync(path, 'utf8')));
}

// Command strings can contain tokens even without a shell; export only known executable names.
function safeCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^(?:npx|npm|node|bun|uv|uvx|python|python3|docker|deno|pnpm|yarn|bash|sh|claude|codex|grok|cct)$/.test(value)
    ? value : '<redacted>';
}

// Key-shaped values (sk-…, ghp_…, AKIA…) pass the character check, so shape alone cannot prove a value is not a secret (10-05 post-review).
const SECRET_PREFIX = /^(?:sk-|sk_|pk_|rk_|xai-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|AKIA|ASIA|AIza|ya29\.|xox[abprs]-|eyJ)/;

export function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = (value.match(/[0-9]/g) ?? []).length;
  const keyShaped = SECRET_PREFIX.test(value) || value.length > 40 || (value.length >= 20 && digits >= 8);
  return /^[a-zA-Z0-9_.:-]{1,90}$/.test(value) && !keyShaped && !/(?:token|secret|password|api.?key|credential)/i.test(value)
    ? value : '<redacted>';
}

type McpSource = 'settings' | 'user' | 'project';

function mcpEntry(server: unknown, source: McpSource): Record<string, unknown> {
  const body = record(server);
  return {
    source,
    command: safeCommand(body.command) ?? null,
    env: Object.fromEntries(Object.keys(record(body.env)).map(key => [key, '<redacted>'])),
    headers: Object.fromEntries(Object.keys(record(body.headers)).map(key => [key, '<redacted>'])),
  };
}

function collectMcp(
  into: Record<string, unknown>,
  servers: unknown,
  source: McpSource,
): void {
  for (const [name, server] of Object.entries(record(servers))) into[safeIdentifier(name) ?? '<redacted>'] = mcpEntry(server, source);
}

function hookGroups(hooks: Record<string, unknown>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event,
    Array.isArray(groups) ? groups.map(group => {
      const body = record(group);
      const entries = body.hooks;
      return {
        matcher: safeIdentifier(body.matcher),
        hooks: Array.isArray(entries)
          ? entries.map(entry => ({ command: safeCommand(record(entry).command) ?? null }))
          : [],
      };
    }) : [],
  ]));
}

function claude(home: string): Record<string, unknown> {
  const dir = join(home, '.claude');
  const settingsPath = join(dir, 'settings.json');
  const userPath = join(home, '.claude.json');
  const settings = json(settingsPath);
  const user = json(userPath);
  const data = record(settings);
  const userData = record(user);
  const plugins = record(data.enabledPlugins);
  const hooks = record(data.hooks);
  const statusLine = record(data.statusLine);
  const skillsDir = join(dir, 'skills');
  const team = join(home, '.teamclaude');
  const teamManifest = json(join(team, 'package.json'));
  const marketplaces = record(data.extraKnownMarketplaces);
  const teamVersion = typeof teamManifest?.version === 'string' && /^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(teamManifest.version)
    ? teamManifest.version : undefined;
  const mcp: Record<string, unknown> = {};
  if (settings !== null) collectMcp(mcp, data.mcpServers, 'settings');
  if (user !== null) {
    collectMcp(mcp, userData.mcpServers, 'user');
    for (const project of Object.values(record(userData.projects))) {
      collectMcp(mcp, record(project).mcpServers, 'project');
    }
  }
  const mcpFilesMissing = settings === null && user === null;
  return {
    version: versionOf('claude'),
    settings: settings === null ? '«없음»' : 'present',
    userConfig: user === null ? '«없음»' : 'present',
    permissionMode: safeIdentifier(record(data.permissions).defaultMode),
    statusLine: settings === null ? '«없음»' : data.statusLine === undefined ? '«없음»' : {
      type: safeIdentifier(statusLine.type),
      command: safeCommand(statusLine.command) ?? null,
    },
    hooks: settings === null ? '«없음»' : hookGroups(hooks),
    enabledPlugins: settings === null ? '«없음»' : Object.fromEntries(Object.entries(plugins).map(([name, enabled]) => [safePluginName(name), enabled === true])),
    marketplaces: settings === null ? '«없음»' : Object.keys(marketplaces).map(name => safeIdentifier(name) ?? '<redacted>').sort(),
    mcpServers: mcpFilesMissing ? '«없음»' : mcp,
    skills: safeNames(skillsDir),
    teamclaude: { installed: present(team), version: teamVersion ?? null },
    auth: present(join(dir, 'auth.json')),
    credentials: present(join(dir, '.credentials.json')),
  };
}

function codex(home: string): Record<string, unknown> {
  const dir = join(home, '.codex');
  const file = join(dir, 'config.toml');
  if (!existsSync(file)) return { config: '«없음»', model: null, profile: null, mcpServers: '«없음»', auth: present(join(dir, 'auth.json')) };
  const data = record(Bun.TOML.parse(readFileSync(file, 'utf8')));
  const mcp = record(data.mcp_servers);
  return {
    config: 'present',
    model: safeIdentifier(data.model),
    profile: safeIdentifier(data.profile),
    mcpServers: Object.keys(mcp).sort(),
    auth: present(join(dir, 'auth.json')),
  };
}

function grok(home: string): Record<string, unknown> {
  const dir = join(home, '.grok');
  const jsonPath = join(dir, 'config.json');
  const tomlPath = join(dir, 'config.toml');
  const file = existsSync(jsonPath) ? jsonPath : tomlPath;
  const data = !existsSync(file) ? null : file === jsonPath ? json(file) : record(Bun.TOML.parse(readFileSync(file, 'utf8')));
  return {
    config: data === null ? '«없음»' : 'present',
    keys: data === null ? '«없음»' : Object.keys(data).sort(),
    auth: present(join(dir, 'auth.json')),
    credentials: present(join(dir, 'credentials.json')),
  };
}

export function captureAgentEnv(options: { agent?: Agent; home?: string; now?: Date } = {}): {
  version: number; capturedAt: string; agents: Record<string, Record<string, unknown>>;
} {
  const home = options.home ?? homedir();
  const selected = options.agent ? [options.agent] : ['claude', 'codex', 'grok'] as const;
  const agents: Record<string, Record<string, unknown>> = {};
  for (const agent of selected) {
    if (agent === 'claude') agents.claude = claude(home);
    else if (agent === 'codex') agents.codex = codex(home);
    else if (agent === 'grok') agents.grok = grok(home);
    else throw new Error('Unknown agent');
  }
  return { version: 1, capturedAt: (options.now ?? new Date()).toISOString(), agents };
}
