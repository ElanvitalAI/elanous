// EN8 — `elanous connect <플러그인 폴더>`: Claude Code 플러그인(`.claude-plugin/plugin.json`)을 «그대로» 쓴다.
// 스킬 폴더는 EN9 와 같은 칸(`skills.sources[]` · kind connected · id `plugin:<이름>`)에 등록하고(복사 없음), `.mcp.json` 의 서버는 «꺼진 채»(`enabled:false`)
// `mcp.servers[]` 에 넣는다 — 켜기는 사람이 확인한 뒤에 한다. 환경변수가 필요한 서버는 등록하지 않고 이유를 말한다.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findSkillFolders } from './connect.js';

export const CLAUDE_PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json');

export function isClaudePluginDir(dir: string): boolean {
  return existsSync(join(dir, CLAUDE_PLUGIN_MANIFEST));
}

/** What we write into `mcp.servers[]` (raw config shape — parsed by parseMcpServerSpec). */
export type PluginMcpServer =
  | { id: string; command: string[]; enabled: false }
  | { id: string; transport: 'http'; url: string; enabled: false };

export interface ClaudePlugin {
  root: string;
  name: string;
  version: string;
  /** Skill folders that hold at least one SKILL.md folder. */
  skillRoots: string[];
  skills: string[];
  mcp: PluginMcpServer[];
  skipped: { name: string; reason: string }[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function serverId(plugin: string, name: string): string {
  return `${plugin}-${name}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function expandRoot(value: string, root: string): string {
  return value.split('${CLAUDE_PLUGIN_ROOT}').join(root);
}

/** One `.mcp.json` entry → a server spec, or the reason it is not registered. */
export function convertMcpEntry(plugin: string, name: string, raw: unknown, root: string): PluginMcpServer | { skipped: string } {
  const entry = asObject(raw);
  if (!entry) return { skipped: '형식을 읽지 못했습니다' };
  const env = asObject(entry.env);
  if (env && Object.keys(env).length) return { skipped: `환경변수가 필요합니다(${Object.keys(env).join(', ')}) — 직접 등록해 주세요` };
  const id = serverId(plugin, name);
  const type = typeof entry.type === 'string' ? entry.type : undefined;
  if (typeof entry.url === 'string' && entry.url) {
    if (type && type !== 'http') return { skipped: `${type} 방식은 아직 지원하지 않습니다` };
    if (entry.headers && Object.keys(asObject(entry.headers) ?? {}).length) return { skipped: '헤더(인증)가 필요합니다 — 직접 등록해 주세요' };
    return { id, transport: 'http', url: entry.url, enabled: false };
  }
  if (typeof entry.command === 'string' && entry.command) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
    return { id, command: [expandRoot(entry.command, root), ...args.map((a) => expandRoot(a, root))], enabled: false };
  }
  return { skipped: '실행 명령이나 주소가 없습니다' };
}

function mcpSource(root: string, manifest: Record<string, unknown>): Record<string, unknown> | null {
  const declared = manifest.mcpServers;
  let raw: unknown = null;
  if (typeof declared === 'string') {
    const path = resolve(root, declared);
    if (path.startsWith(`${root}/`) && existsSync(path)) raw = readJson(path);
  } else if (asObject(declared)) {
    raw = declared;
  } else if (existsSync(join(root, '.mcp.json'))) {
    raw = readJson(join(root, '.mcp.json'));
  }
  const object = asObject(raw);
  if (!object) return null;
  return asObject(object.mcpServers) ?? object;
}

function skillRootsOf(root: string, manifest: Record<string, unknown>): string[] {
  const declared = typeof manifest.skills === 'string' ? [manifest.skills]
    : Array.isArray(manifest.skills) ? manifest.skills.filter((s): s is string => typeof s === 'string') : [];
  const candidates = [join(root, 'skills'), ...declared.map((rel) => resolve(root, rel))]
    .filter((path) => path === root || path.startsWith(`${root}/`));
  return [...new Set(candidates)].filter((path) => findSkillFolders(path).length > 0);
}

/** Read a Claude Code plugin folder. Throws only when the manifest is not JSON. */
export function readClaudePlugin(dir: string): ClaudePlugin {
  const root = resolve(dir);
  const manifest = asObject(readJson(join(root, CLAUDE_PLUGIN_MANIFEST))) ?? {};
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : root.split('/').pop() ?? 'plugin';
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  const skillRoots = skillRootsOf(root, manifest);
  const skills = skillRoots.flatMap(findSkillFolders).sort();
  const mcp: PluginMcpServer[] = [];
  const skipped: ClaudePlugin['skipped'] = [];
  for (const [server, raw] of Object.entries(mcpSource(root, manifest) ?? {})) {
    const converted = convertMcpEntry(name, server, raw, root);
    if ('skipped' in converted) skipped.push({ name: server, reason: converted.skipped });
    else mcp.push(converted);
  }
  return { root, name, version, skillRoots, skills, mcp, skipped };
}

export interface ClaudePluginPlan {
  plugin: ClaudePlugin;
  newSkillRoots: string[];
  newMcp: PluginMcpServer[];
  state: 'new' | 'already' | 'empty';
}

export function planClaudePlugin(plugin: ClaudePlugin, activeDirs: readonly string[], mcpIds: readonly string[]): ClaudePluginPlan {
  const newSkillRoots = plugin.skillRoots.filter((dir) => !activeDirs.includes(dir));
  const newMcp = plugin.mcp.filter((server) => !mcpIds.includes(server.id));
  const state = !plugin.skills.length && !plugin.mcp.length ? 'empty' : newSkillRoots.length || newMcp.length ? 'new' : 'already';
  return { plugin, newSkillRoots, newMcp, state };
}

export function claudePluginPrompt(plan: ClaudePluginPlan): string {
  const { plugin } = plan;
  const head = `Claude 플러그인 «${plugin.name}» ${plugin.version}`;
  const skipped = plugin.skipped.map((s) => `\n  · MCP ${s.name}: ${s.reason}`).join('');
  if (plan.state === 'empty') return `${head}에서 쓸 스킬이나 MCP 서버를 찾지 못했습니다.${skipped}`;
  if (plan.state === 'already') return `${head}은 이미 연결돼 있습니다 — 스킬 ${plugin.skills.length}개 · MCP ${plugin.mcp.length}개.${skipped}`;
  const parts = [
    plugin.skills.length ? `스킬 ${plugin.skills.length}개(그 자리를 그대로 씁니다)` : '',
    plan.newMcp.length ? `MCP 서버 ${plan.newMcp.length}개(꺼진 채로 등록 — 켜기는 따로 확인합니다)` : '',
  ].filter(Boolean).join(' · ');
  return `${head}: ${parts}${skipped}\n가져올까요? [Y/n] `;
}

/** How to turn one registered server on — shown after connecting, never done for the person. */
export function mcpEnableHint(servers: readonly PluginMcpServer[], all: readonly { id?: unknown }[]): string[] {
  return servers.map((server) => {
    const index = all.findIndex((row) => row.id === server.id);
    const what = 'url' in server ? server.url : server.command.join(' ');
    return `  · ${server.id} — ${what}\n    켜려면: elanous config set mcp.servers.${index}.enabled true`;
  });
}
