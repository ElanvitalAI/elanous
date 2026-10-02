// EN4 — `elanous import`: detect → plan on one screen, writes nothing (RESEARCH-entrances-for-codex-claude-openclaw-hermes-users §5a·§5b).
// Each item names the existing sub-command that applies it (connect · nexus channel-bot import); `--apply` is EN7 (apply.ts).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSkillFolders } from '../skills/connect.js';
import { detectChannelImports, SOURCE_LABEL } from '../channel-import/detect.js';

export type ImportSourceId = 'agents' | 'claude' | 'codex' | 'openclaw' | 'hermes';
export type ImportItemKind = 'skill' | 'instructions' | 'mcp' | 'hooks' | 'credentials' | 'channel-bot';
/** `same` already reachable/identical · `conflict` same name, different content · `archived-only` kept, never run · `secret` moved only on an explicit ask. */
export type ImportItemStatus = 'new' | 'same' | 'conflict' | 'unsupported' | 'archived-only' | 'secret';

export interface ImportSourceInfo { id: ImportSourceId; root: string; detected: boolean }
export interface ImportItem {
  /** `<source>:<kind>:<name>` — what `import --apply --pick` takes. */
  id: string;
  source: ImportSourceId;
  kind: ImportItemKind;
  name: string;
  /** `~`-relative path the item was found in. */
  path: string;
  status: ImportItemStatus;
  /** The existing command that applies this item; absent when nothing applies it yet. */
  next?: string;
  note?: string;
}
export interface ImportPlan { sources: ImportSourceInfo[]; items: ImportItem[] }

export interface ImportPlanInput {
  home: string;
  /** `$CODEX_HOME` when set. */
  codexHome?: string;
  /** Skill directories elanous reads today (defaultSkillDirs). */
  activeSkillDirs: readonly string[];
  /** Ids of MCP servers already in elanous config. */
  mcpServerIds: readonly string[];
}

export const IMPORT_STATUSES: readonly ImportItemStatus[] = ['new', 'same', 'conflict', 'unsupported', 'archived-only', 'secret'];

function sourceRoots(input: ImportPlanInput): Record<ImportSourceId, string> {
  const { home } = input;
  const openclaw = [join(home, '.openclaw'), join(home, '.clawdbot'), join(home, '.moltbot')].find((p) => existsSync(p)) ?? join(home, '.openclaw');
  return {
    agents: join(home, '.agents'),
    claude: join(home, '.claude'),
    codex: input.codexHome || join(home, '.codex'),
    openclaw,
    hermes: join(home, '.hermes'),
  };
}

const tilde = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);
const hash = (path: string) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
const readText = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path: string): Record<string, unknown> | null => {
  const raw = readText(path);
  if (raw === null) return null;
  try { const v = JSON.parse(raw) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};
const keysOf = (value: unknown): string[] => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as object) : []);
const hasSecretFields = (spec: unknown): boolean => {
  if (!spec || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  return keysOf(s.env).length > 0 || keysOf(s.headers).length > 0 || keysOf(s.http_headers).length > 0;
};

/** Skill folders of one root, each judged against what elanous already reads. */
function skillItems(source: ImportSourceId, root: string, input: ImportPlanInput, next?: string): Array<Omit<ImportItem, 'id'>> {
  const names = findSkillFolders(root);
  const rootActive = input.activeSkillDirs.includes(root);
  return names.map((name): Omit<ImportItem, 'id'> => {
    const path = tilde(join(root, name), input.home);
    if (rootActive) return { source, kind: 'skill', name, path, status: 'same', note: '이미 읽는 폴더' };
    const mine = hash(join(root, name, 'SKILL.md'));
    const twin = input.activeSkillDirs.map((dir) => join(dir, name, 'SKILL.md')).find((p) => existsSync(p));
    if (twin) {
      return hash(twin) === mine
        ? { source, kind: 'skill', name, path, status: 'same', note: `같은 내용이 이미 있다: ${tilde(twin, input.home)}` }
        : { source, kind: 'skill', name, path, status: 'conflict', note: `같은 이름 · 다른 내용: ${tilde(twin, input.home)}` };
    }
    return { source, kind: 'skill', name, path, status: 'new', ...(next ? { next } : { note: '적용 명령은 0.2.9 `import --apply`' }) };
  });
}

function mcpItem(source: ImportSourceId, name: string, path: string, secret: boolean, input: ImportPlanInput): Omit<ImportItem, 'id'> {
  if (secret) return { source, kind: 'mcp', name, path, status: 'secret', note: 'env·헤더 값이 있다 — 묻기 전까지 옮기지 않는다' };
  if (input.mcpServerIds.includes(name)) return { source, kind: 'mcp', name, path, status: 'same', note: '같은 id 가 이미 있다' };
  return { source, kind: 'mcp', name, path, status: 'new', note: '0.2.9 `import --apply` 가 꺼진 채로 넣는다' };
}

/** `[mcp_servers.<name>]` tables of a Codex config.toml; `env`/`headers` keys or sub-tables count as secret. */
function codexMcp(raw: string): Array<{ name: string; secret: boolean }> {
  const out = new Map<string, boolean>();
  let current: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const table = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
    if (table !== undefined) {
      const m = /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.([A-Za-z_]+))?$/.exec(table);
      current = m ? (m[1] ?? m[2]!) : null;
      if (current) out.set(current, (out.get(current) ?? false) || ['env', 'headers', 'http_headers'].includes(m![3] ?? ''));
      continue;
    }
    if (current && /^\s*(env|headers|http_headers)\s*=/.test(line)) out.set(current, true);
  }
  return [...out].map(([name, secret]) => ({ name, secret }));
}

/** Top-level keys under `mcp_servers:` in a Hermes config.yaml (two-space indent). */
function hermesMcp(raw: string): string[] {
  const block = /^mcp_servers:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(raw)?.[1] ?? '';
  return [...block.matchAll(/^ {2}([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]!);
}

export function planImport(input: ImportPlanInput): ImportPlan {
  const roots = sourceRoots(input);
  const sources = (Object.keys(roots) as ImportSourceId[]).map((id) => ({ id, root: tilde(roots[id], input.home), detected: existsSync(roots[id]) }));
  const items: Array<Omit<ImportItem, 'id'>> = [];
  const home = input.home;
  const at = (p: string) => tilde(p, home);

  if (existsSync(roots.agents)) {
    items.push(...skillItems('agents', join(roots.agents, 'skills'), input));
    if (existsSync(join(roots.agents, 'AGENTS.md'))) items.push({ source: 'agents', kind: 'instructions', name: 'AGENTS.md', path: at(join(roots.agents, 'AGENTS.md')), status: 'unsupported', note: '전역 지시 파일은 아직 싣지 않는다' });
  }

  if (existsSync(roots.claude)) {
    items.push(...skillItems('claude', join(roots.claude, 'skills'), input, 'elanous connect claude'));
    if (existsSync(join(roots.claude, 'CLAUDE.md'))) items.push({ source: 'claude', kind: 'instructions', name: 'CLAUDE.md', path: at(join(roots.claude, 'CLAUDE.md')), status: 'unsupported', note: '전역 지시 파일은 아직 싣지 않는다' });
    const claudeJson = join(home, '.claude.json');
    for (const [name, spec] of Object.entries((readJson(claudeJson)?.mcpServers ?? {}) as Record<string, unknown>)) items.push(mcpItem('claude', name, at(claudeJson), hasSecretFields(spec), input));
    const settings = join(roots.claude, 'settings.json');
    for (const event of keysOf(readJson(settings)?.hooks)) items.push({ source: 'claude', kind: 'hooks', name: event, path: at(settings), status: 'archived-only', note: '훅은 보관만 · 켜지 않는다' });
    if (existsSync(join(roots.claude, '.credentials.json'))) items.push({ source: 'claude', kind: 'credentials', name: 'login', path: at(join(roots.claude, '.credentials.json')), status: 'secret', note: '로그인은 옮기지 않는다 · 엘라누스에서 따로 한 번' });
  }

  if (existsSync(roots.codex)) {
    items.push(...skillItems('codex', join(roots.codex, 'skills'), input, 'elanous connect codex'));
    if (existsSync(join(roots.codex, 'AGENTS.md'))) items.push({ source: 'codex', kind: 'instructions', name: 'AGENTS.md', path: at(join(roots.codex, 'AGENTS.md')), status: 'unsupported', note: '전역 지시 파일은 아직 싣지 않는다' });
    const toml = join(roots.codex, 'config.toml');
    const raw = readText(toml);
    for (const server of raw ? codexMcp(raw) : []) items.push(mcpItem('codex', server.name, at(toml), server.secret, input));
    if (existsSync(join(roots.codex, 'auth.json'))) items.push({ source: 'codex', kind: 'credentials', name: 'login', path: at(join(roots.codex, 'auth.json')), status: 'secret', note: '로그인은 옮기지 않는다 · 엘라누스에서 따로 한 번' });
  }

  if (existsSync(roots.openclaw)) {
    items.push(...skillItems('openclaw', join(roots.openclaw, 'skills'), input));
    const cfg = join(roots.openclaw, 'openclaw.json');
    const servers = (readJson(cfg)?.mcp as Record<string, unknown> | undefined)?.servers;
    for (const [name, spec] of Object.entries((servers && typeof servers === 'object' ? servers : {}) as Record<string, unknown>)) items.push(mcpItem('openclaw', name, at(cfg), hasSecretFields(spec), input));
  }

  if (existsSync(roots.hermes)) {
    items.push(...skillItems('hermes', join(roots.hermes, 'skills'), input));
    const yaml = join(roots.hermes, 'config.yaml');
    const raw = readText(yaml);
    for (const name of raw ? hermesMcp(raw) : []) items.push({ source: 'hermes', kind: 'mcp', name, path: at(yaml), status: 'unsupported', note: 'YAML 형식은 아직 변환하지 않는다' });
  }

  // EN13 — chat bots: token values stay masked; the existing import command stores them after the user agrees.
  const bots = detectChannelImports(home);
  for (const c of bots.candidates) {
    const source: ImportSourceId | null = c.source === 'openclaw' ? 'openclaw' : c.source === 'hermes' ? 'hermes' : null;
    if (!source) continue;
    items.push({ source, kind: 'channel-bot', name: c.platform, path: c.file, status: 'secret', next: 'elanous nexus channel-bot import', note: `${SOURCE_LABEL[c.source]} 봇 토큰(가림)` });
  }
  for (const u of bots.unreadable) {
    const source: ImportSourceId | null = u.file.includes('.hermes') ? 'hermes' : u.file.includes('.openclaw') || u.file.includes('.clawdbot') || u.file.includes('.moltbot') ? 'openclaw' : null;
    if (source) items.push({ source, kind: 'channel-bot', name: 'bot', path: u.file, status: 'unsupported', note: u.reason });
  }
  return { sources, items: items.map((item) => ({ ...item, id: `${item.source}:${item.kind}:${item.name}` })) };
}

const KIND_LABEL: Record<ImportItemKind, string> = { skill: '스킬', instructions: '지시 파일', mcp: 'MCP', hooks: '훅', credentials: '로그인', 'channel-bot': '채팅 봇' };

/** One screen: per source, counts by status, then the items that need a decision. */
export function formatImportPlan(plan: ImportPlan): string {
  const lines: string[] = ['가져오기 계획 — 아무것도 쓰지 않았습니다.', ''];
  const detected = plan.sources.filter((s) => s.detected);
  if (!detected.length) return [...lines, '쓰던 에이전트를 찾지 못했습니다(~/.agents · ~/.claude · ~/.codex · ~/.openclaw · ~/.hermes).'].join('\n');
  for (const source of detected) {
    const mine = plan.items.filter((i) => i.source === source.id);
    const counts = IMPORT_STATUSES.map((s) => [s, mine.filter((i) => i.status === s).length] as const).filter(([, n]) => n > 0);
    lines.push(`■ ${source.id} (${source.root}) — ${mine.length ? counts.map(([s, n]) => `${s} ${n}`).join(' · ') : '항목 없음'}`);
    for (const kind of Object.keys(KIND_LABEL) as ImportItemKind[]) {
      const group = mine.filter((i) => i.kind === kind && i.status !== 'same');
      if (!group.length) continue;
      const shown = group.slice(0, 6).map((i) => `${i.name}[${i.status}]`).join(', ');
      lines.push(`  ${KIND_LABEL[kind]}: ${shown}${group.length > 6 ? ` 외 ${group.length - 6}개` : ''}`);
    }
  }
  const nexts = [...new Set(plan.items.filter((i) => i.next && i.status !== 'same').map((i) => i.next!))];
  lines.push('', '한 번에: `elanous import --apply` (스킬은 그 자리 등록 · MCP 는 꺼진 채로 · 비밀·훅은 보관만 · 되돌리기 `--undo`)');
  lines.push(nexts.length ? `따로: ${nexts.map((n) => `\`${n}\``).join(' · ')}` : '따로 적용할 명령이 있는 항목은 없습니다.', '상태: new · same · conflict · unsupported · archived-only · secret — 자세히는 `elanous import --json`');
  return lines.join('\n');
}
