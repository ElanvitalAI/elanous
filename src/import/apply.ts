// EN7 — `elanous import --apply` / `--undo`: run the EN4 plan. Skills register in place (EN9 `withConnectedSource`, `ref` default)
// or as link/copy under the import folder; MCP joins `mcp.servers[]` switched off (EN8 `convertMcpEntry`); hooks, logins,
// secrets and chat-bot tokens are only listed — never copied, never printed. Undo restores the config bytes and removes what apply made.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMcpEntry } from '../skills/connect-claude-plugin.js';
import { withConnectedSource } from '../skills/connect.js';
import type { SkillSource } from '../user-config.js';
import type { ImportItem, ImportPlan } from './plan.js';

export type ImportMode = 'ref' | 'link' | 'copy';
export const IMPORT_MODES: readonly ImportMode[] = ['ref', 'link', 'copy'];

export interface ImportManifest {
  at: string;
  mode: ImportMode;
  configPath: string;
  /** Config bytes before apply; null when there was no config file. */
  backup: string | null;
  /** Files and links apply created, removed on undo. */
  created: string[];
  applied: Array<{ id: string; how: string }>;
  kept: Array<{ id: string; status: string; why: string }>;
}

export interface ApplyDeps {
  home: string;
  configPath: string;
  /** Where links/copies, the manifest and the config backup live. */
  importRoot: string;
  sources: readonly SkillSource[];
  rawMcpServers: ReadonlyArray<Record<string, unknown>>;
  /** Persist the new skills sources and raw MCP server rows (the config writer). */
  save: (sources: SkillSource[], rawServers: Array<Record<string, unknown>>) => void;
  now?: () => Date;
}

const manifestPath = (importRoot: string) => join(importRoot, 'last-apply.json');
const expand = (path: string, home: string) => (path.startsWith('~') ? join(home, path.slice(1)) : path);

function readMcpSpec(item: ImportItem, home: string): unknown {
  try {
    const json = JSON.parse(readFileSync(expand(item.path, home), 'utf8')) as Record<string, unknown>;
    const table = item.source === 'claude' ? json.mcpServers : (json.mcp as Record<string, unknown> | undefined)?.servers;
    return (table as Record<string, unknown> | undefined)?.[item.name];
  } catch { return undefined; }
}

export function readImportManifest(importRoot: string): ImportManifest | null {
  try { return JSON.parse(readFileSync(manifestPath(importRoot), 'utf8')) as ImportManifest; } catch { return null; }
}

export function applyImport(plan: ImportPlan, opts: { mode?: ImportMode; pick?: readonly string[] }, deps: ApplyDeps): ImportManifest {
  if (readImportManifest(deps.importRoot)) throw new Error('이미 적용한 가져오기가 있습니다 — 먼저 `elanous import --undo`');
  const mode = opts.mode ?? 'ref';
  const picked = opts.pick?.length ? new Set(opts.pick) : null;
  const manifest: ImportManifest = {
    at: (deps.now ?? (() => new Date()))().toISOString(), mode, configPath: deps.configPath,
    backup: existsSync(deps.configPath) ? readFileSync(deps.configPath, 'utf8') : null, created: [], applied: [], kept: [],
  };
  let sources = [...deps.sources];
  const rawServers = [...deps.rawMcpServers];
  const keep = (item: ImportItem, why: string) => manifest.kept.push({ id: item.id, status: item.status, why });
  mkdirSync(deps.importRoot, { recursive: true });

  for (const item of plan.items) {
    if (picked && !picked.has(item.id)) continue;
    if (item.status === 'same') continue;
    if (item.status !== 'new') {
      keep(item, item.status === 'secret' || item.status === 'archived-only'
        ? `보관만 — 옮기지도 켜지도 않는다${item.next ? ` · 따로: \`${item.next}\`` : ''}`
        : item.status === 'conflict' ? '같은 이름 · 다른 내용 — 그대로 둔다' : '형식을 아직 옮기지 않는다');
      continue;
    }
    if (item.kind === 'skill') {
      const skillDir = expand(item.path, deps.home);
      if (mode === 'ref') {
        const root = join(skillDir, '..');
        sources = withConnectedSource(sources, root, item.source);
        manifest.applied.push({ id: item.id, how: `ref ${item.path}` });
        continue;
      }
      const target = join(deps.importRoot, 'skills', item.source, item.name);
      if (existsSync(target)) { keep(item, `이미 있다: ${target}`); continue; }
      mkdirSync(join(target, '..'), { recursive: true });
      if (mode === 'link') symlinkSync(skillDir, target, 'dir');
      else cpSync(skillDir, target, { recursive: true, dereference: true });
      manifest.created.push(target);
      sources = withConnectedSource(sources, join(deps.importRoot, 'skills', item.source), `import:${item.source}`);
      manifest.applied.push({ id: item.id, how: `${mode} ${item.path}` });
      continue;
    }
    if (item.kind === 'mcp' && (item.source === 'claude' || item.source === 'openclaw')) {
      const converted = convertMcpEntry(item.source, item.name, readMcpSpec(item, deps.home), '');
      if ('skipped' in converted) { keep(item, converted.skipped); continue; }
      if (rawServers.some((row) => row.id === item.name)) { keep(item, '같은 id 가 이미 있다'); continue; }
      rawServers.push({ ...converted, id: item.name });
      manifest.applied.push({ id: item.id, how: 'mcp 꺼진 채로' });
      continue;
    }
    keep(item, '이 판에서는 옮기지 않는다');
  }

  if (manifest.applied.length) deps.save(sources, rawServers);
  writeFileSync(manifestPath(deps.importRoot), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Restore the config bytes and remove what apply created. Returns null when nothing was applied. */
export function undoImport(importRoot: string): ImportManifest | null {
  const manifest = readImportManifest(importRoot);
  if (!manifest) return null;
  if (manifest.backup === null) rmSync(manifest.configPath, { force: true });
  else writeFileSync(manifest.configPath, manifest.backup);
  for (const path of manifest.created) rmSync(path, { recursive: true, force: true });
  rmSync(manifestPath(importRoot), { force: true });
  return manifest;
}

export function formatApplied(m: ImportManifest): string {
  const lines = [`가져왔습니다(${m.mode}) — ${m.applied.length}개 · 그대로 둔 것 ${m.kept.length}개. 되돌리려면: elanous import --undo`];
  for (const a of m.applied.slice(0, 12)) lines.push(`  + ${a.id} — ${a.how}`);
  if (m.applied.length > 12) lines.push(`  … 외 ${m.applied.length - 12}개`);
  for (const k of m.kept.slice(0, 12)) lines.push(`  · ${k.id} [${k.status}] — ${k.why}`);
  if (m.kept.length > 12) lines.push(`  … 외 ${m.kept.length - 12}개`);
  if (m.applied.some((a) => a.how.startsWith('mcp'))) lines.push('MCP 서버는 꺼진 채로 넣었습니다. 믿을 수 있는 것만 켜 주세요(켠 뒤 데몬 재시작).');
  return lines.join('\n');
}
