import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURE_MATURITY, type Maturity } from '../../src/maturity/feature-maturity.js';
import type { ChecklistItem } from '../../src/release-loop/checklist.js';

const DEFAULT_MAP = resolve(import.meta.dir, '../../docs/marketing/MAP-value-props-to-features.md');
const HELD = /특허\s*(?:보류|후보)|GOAL-CASCADE/i;
const PR = /(?:^|[^\w])#(\d+)\b|\/pull\/(\d+)\b/g;
type Grade = '된다' | '베타' | '로드맵';
type Row = { feature: string; grade: Grade; id: string; pr: string };
type Registry = typeof FEATURE_MATURITY;

function cells(line: string): string[] {
  return line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function clean(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function gradeFor(feature: string, hint: string, registry: Registry): Maturity | undefined {
  // A surface alone ("cli", "telegram") does not identify a feature in the registry.
  const key = /\/(?:[\w-]+)(?:\/[\w-]+)*/.exec(hint)?.[0];
  if (key && Object.prototype.hasOwnProperty.call(registry.pwaRoute, key))
    return registry.pwaRoute[key as keyof Registry['pwaRoute']].pwa;
  const named = /\b(cliRoot|tuiSlash|telegramCommand|discordCommand):([\w:-]+)/.exec(hint);
  if (named) {
    const group = registry[named[1] as Exclude<keyof Registry, 'pwaRoute'>] as Record<string, Maturity>;
    return Object.prototype.hasOwnProperty.call(group, named[2]!) ? group[named[2]!] : undefined;
  }
  // Explicit command spelling in a feature name is unambiguous; a prose word is not.
  const command = /`(?:elanous )?([\w:-]+)`/.exec(feature)?.[1];
  if (command && Object.prototype.hasOwnProperty.call(registry.cliRoot, command))
    return registry.cliRoot[command as keyof Registry['cliRoot']];
  return undefined;
}

function prs(text: string): string[] {
  return [...new Set([...text.matchAll(PR)].map((m) => `#${m[1] ?? m[2]}`))];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Checklist cells require green status; rows without checklist cells use the map's maturity and public marker. */
export function generateFeatureMap(input: { map: string; items: readonly ChecklistItem[]; registry: Registry; version: string }): string {
  const checklist = new Map(input.items.map((item) => [item.id, item]));
  const green = new Map(input.items.filter((item) => item.status === 'green').map((item) => [item.id, item]));
  const rows: Row[] = [];
  let section = '';
  for (const line of input.map.split(/\r?\n/)) {
    if (/^#{2,3} /.test(line)) section = line;
    if (!section.startsWith('## 2. 기능 배치표 ') || !line.startsWith('|')) continue;
    const columns = cells(line);
    if (columns.length !== 8 || !/^P\d+(?:[·⊕]P\d+)*$/.test(clean(columns[0]!))) continue;
    const [_, rawFeature, rawId, , hint, publication, evidence] = columns;
    const feature = clean(rawFeature!);
    if (!feature || feature === '—') continue;
    const id = clean(rawId!);
    const ids = id.split(/[·⊕]/).map((part) => part.trim()).filter(Boolean);
    const hasChecklistCell = ids.some((part) => checklist.has(part));
    const matched = ids.map((part) => green.get(part)).filter((item): item is ChecklistItem => !!item);
    const complete = ids.length > 0 && ids.every((part) => green.has(part));
    const maturity = hasChecklistCell ? gradeFor(feature, hint!, input.registry) : undefined;
    const mapMaturity = /^(?:\/\S+\s+)?(stable|beta)\b/i.exec(clean(hint!))?.[1]?.toLowerCase();
    const grade: Grade = hasChecklistCell
      ? complete && maturity === 'stable' ? '된다' : complete && maturity === 'beta' ? '베타' : '로드맵'
      : !clean(publication!).startsWith('✅') ? '로드맵'
        : mapMaturity === 'stable' ? '된다' : mapMaturity === 'beta' ? '베타' : '로드맵';
    const evidencePrs = hasChecklistCell
      ? [...new Set(matched.flatMap((item) => prs(item.evidence ?? '')))] : prs(evidence!);
    const held = HELD.test([...columns, ...ids.map((part) => {
      const item = checklist.get(part);
      return item ? `${item.title} ${item.evidence ?? ''}` : '';
    })].join(' '));
    rows.push({ feature: held ? '개념' : feature, grade: held ? '로드맵' : grade,
      id: held ? '—' : hasChecklistCell ? id : '지도 판정', pr: held || !evidencePrs.length ? '근거 없음'
        : !hasChecklistCell || complete ? evidencePrs.join(', ') : `부분: ${evidencePrs.join(', ')} · 나머지 칸 미완` });
  }
  const lines = [
    '# FEATURE-MAP — 엘라누스가 할 수 있는 것',
    '',
    `판: ${escapeCell(input.version)} · 원천: src/maturity/feature-maturity.ts + 릴리스 체크리스트 green + docs/marketing/MAP-value-props-to-features.md §2`,
    `재생성: \`bun scripts/marketing/generate-feature-map.ts --version ${escapeCell(input.version)} --out docs/marketing/FEATURE-MAP.md\``,
    '내부 배치용: 로드맵은 현재 기능이 아니며, 된다/베타도 공개 판정·컷의 조상 PR 확인을 대신하지 않는다.',
    '',
    '| 기능 | 성숙도 | 칸 id | 근거 PR |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${escapeCell(row.feature)} | ${row.grade} | ${escapeCell(row.id)} | ${escapeCell(row.pr)} |`),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 값이 필요하다`);
    args.splice(index, 2);
    return value;
  };
  const version = option('--version');
  const mapFile = option('--map') ?? DEFAULT_MAP;
  const checklistFile = option('--checklist');
  const out = option('--out');
  if (!version || args.length) throw new Error('Usage: bun scripts/marketing/generate-feature-map.ts --version <v> [--map <file>] [--checklist <snapshot.json>] [--out <file>]');
  const items = checklistFile
    ? (JSON.parse(readFileSync(checklistFile, 'utf8')) as { items: ChecklistItem[] }).items
    : (await import('../../src/release-loop/checklist.js')).listChecklist(version).items;
  if (!Array.isArray(items)) throw new Error('체크리스트 items 배열이 없다');
  const body = generateFeatureMap({ map: readFileSync(mapFile, 'utf8'), items, registry: FEATURE_MATURITY, version });
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
}
