import type { Command } from 'commander';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import YAML from 'yaml';

export const RFC_STATUSES = ['unknown', 'proposed', 'adopted', 'completed', 'superseded', 'rejected'] as const;
export type RfcStatus = typeof RFC_STATUSES[number];
export interface RfcRow {
  path: string;
  status: RfcStatus;
  owner: string | null;
  card: string | null;
  supersededBy: string | null;
  handbook: string | null;
  issue: string | null;
  /** Legacy top-level `status:` / `owner:` values, verbatim: evidence for a human migration, never the lifecycle status. */
  legacyStatus: string | null;
  legacyOwner: string | null;
}

function rfcPaths(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rfcPaths(path);
    return entry.isFile() && /^RFC-.*\.md$/.test(entry.name) ? [path] : [];
  });
}

function field(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown' ? value.trim() : null;
}

/** Explicit lifecycle fields only: prose, old `status: rfc`, and file location do not establish adoption. */
export function readRfcRow(text: string, path: string): RfcRow {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  let meta: Record<string, unknown> = {};
  let issue: string | null = null;
  let legacyStatus: string | null = null;
  let legacyOwner: string | null = null;
  if (!match) issue = 'lifecycle frontmatter missing';
  else {
    // Legacy RFC frontmatter can contain non-YAML prose. Parse only the new, top-level rfc_* declarations.
    legacyStatus = /^status:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
    legacyOwner = /^owner:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
    const declarations = [...match[1]!.matchAll(/^(rfc_status|rfc_owner|rfc_card|rfc_superseded_by|rfc_handbook):\s*(.*)$/gm)];
    for (const [, key, raw] of declarations) {
      try { meta[key!] = YAML.parse(raw!); }
      catch { issue = 'invalid lifecycle frontmatter'; }
    }
  }
  const rawStatus = meta.rfc_status;
  const status: RfcStatus = typeof rawStatus === 'string' && RFC_STATUSES.includes(rawStatus as RfcStatus)
    ? rawStatus as RfcStatus : 'unknown';
  if (rawStatus !== undefined && status === 'unknown' && rawStatus !== 'unknown') issue = 'invalid rfc_status';
  return {
    path, status, owner: field(meta.rfc_owner), card: field(meta.rfc_card),
    supersededBy: field(meta.rfc_superseded_by), handbook: field(meta.rfc_handbook), issue, legacyStatus, legacyOwner,
  };
}

export function scanRfcs(repoRoot: string): RfcRow[] {
  const root = resolve(repoRoot);
  return rfcPaths(join(root, 'docs')).map((file) => readRfcRow(readFileSync(file, 'utf8'), relative(root, file).replaceAll('\\', '/')))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/** A missing declaration is not proof that a card does not exist; an adopted RFC with an explicit null is. */
export function adoptedWithoutCard(rows: readonly RfcRow[]): RfcRow[] {
  return rows.filter((row) => row.status === 'adopted' && row.card === null);
}

const RFC_HUB_FILE = 'INDEX-loop-agents-and-harness-rfcs.md';

function markdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]!);
}

function hasHubConnectionReference(text: string, documentPath: string, root: string): boolean {
  const firstSection = text.search(/^##\s/m);
  const header = firstSection < 0 ? text : text.slice(0, firstSection);
  const hubPath = resolve(root, 'docs', RFC_HUB_FILE);
  return header.split(/\r?\n/).some((line) => {
    if (!line.includes('🔗') || !line.includes('연결 참조')) return false;
    return markdownLinks(line).some((target) =>
      resolve(dirname(resolve(root, documentPath)), target) === hubPath);
  });
}

/** 허브를 못 읽으면 null — «0» 과 «못 셌음» 은 다른 값이다. */
function hubConnectionCounts(root: string, rows: readonly RfcRow[]): { unconnected: number; unlisted: number } | null {
  const hubPath = resolve(root, 'docs', RFC_HUB_FILE);
  let hub: string;
  try { hub = readFileSync(hubPath, 'utf8'); }
  catch { return null; }

  const hubDirectory = dirname(hubPath);
  const listedPaths = new Set(markdownLinks(hub)
    .filter((target) => /^RFC-.*\.md$/.test(target.split(/[?#]/, 1)[0]!))
    .map((target) => relative(root, resolve(hubDirectory, target)).replaceAll('\\', '/')));
  const rowsByPath = new Map(rows.map((row) => [row.path, row]));
  const unconnected = [...listedPaths].filter((path) => {
    const row = rowsByPath.get(path);
    if (!row) return false;
    return !hasHubConnectionReference(readFileSync(resolve(root, row.path), 'utf8'), row.path, root);
  }).length;
  const unlisted = rows.filter((row) => {
    if (listedPaths.has(row.path)) return false;
    const text = readFileSync(resolve(root, row.path), 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? '';
    return /루프|하니스|그래프/.test(title);
  }).length;
  return { unconnected, unlisted };
}

export function runRfcStatus(options: { json?: boolean; missingCards?: boolean }, root = process.cwd(),
  write: (text: string) => void = (text) => process.stdout.write(text)): void {
  const all = scanRfcs(root);
  const rows = options.missingCards ? adoptedWithoutCard(all) : all;
  if (options.json) {
    write(`${JSON.stringify({ total: all.length, adoptedWithoutCard: adoptedWithoutCard(all).length, rows }, null, 2)}\n`);
    return;
  }
  const hubCounts = hubConnectionCounts(root, all);
  write(`RFC ${all.length} · 채택·칸 없음 ${adoptedWithoutCard(all).length} · 표시 ${rows.length}\n`);
  write('상태\t담당\t칸\t대체 문서\t핸드북\t옛 상태\t옛 담당\t경로\t메타 오류\n');
  for (const row of rows) write(`${row.status}\t${row.owner ?? '모름'}\t${row.card ?? '모름'}\t${row.supersededBy ?? '모름'}\t${row.handbook ?? '모름'}\t${row.legacyStatus ?? '-'}\t${row.legacyOwner ?? '-'}\t${row.path}\t${row.issue ?? '-'}\n`);
  write(hubCounts
    ? `허브 연결: 되돌림 없음 ${hubCounts.unconnected} · 미등재 ${hubCounts.unlisted}\n`
    : `허브 연결: 못 셈 — docs/${RFC_HUB_FILE} 를 못 읽었다\n`);
}

export function registerRfcStatusCommand(docs: Command): void {
  docs.command('rfc-status')
    .description('전체 RFC 생애주기 표 (RFC frontmatter만 읽음)')
    .option('--json', '기계가 읽을 JSON')
    .option('--missing-cards', '채택됐으나 칸이 기록되지 않은 RFC만')
    .action((options: { json?: boolean; missingCards?: boolean }): void => {
      // registerDocsCommands in docs-cli.ts calls registerRfcStatusCommand; this action calls runRfcStatus and its hub check.
      runRfcStatus(options);
    });
}
