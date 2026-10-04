import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { LessonLedger, type LessonRow, type LessonStatus } from '../../src/lessons/lesson-ledger.js';

const statuses: LessonStatus[] = ['candidate', 'open', 'enforced', 'promoted'];

function args(argv: string[]): { stateDir?: string; out?: string; json: boolean } {
  const options: { stateDir?: string; out?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--state-dir' || arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      if (arg === '--state-dir') options.stateDir = value;
      else options.out = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()~!|])/g, '\\$1')
    .replace(/([a-z][a-z\d+.-]*:)(\/\/)|\b(www\.)(?=\S)|(@)(?=\S)/gi,
      (_match, scheme: string | undefined, slashes: string | undefined, www: string | undefined, at: string | undefined) =>
        www ? 'w\u200bww.' : `${scheme ?? at}\u200b${slashes ?? ''}`);
}

function section(title: string, rows: LessonRow[], ledger: LessonLedger, kind: LessonStatus): string[] {
  const lines = [`## ${title}`, ''];
  if (!rows.length) return [...lines, '없음', ''];
  for (const row of rows) {
    const last = ledger.get(row.id).occurrences.at(-1);
    lines.push(`### ${inlineText(row.id)} — ${inlineText(row.incident)}`,
      `- 원인: ${inlineText(row.cause)}`,
      `- 처방: ${inlineText(row.remedy)}`,
      `- 재발: ${row.occurrence_count}회`,
      `- 마지막 발생: ${inlineText(last?.at ?? '없음')} · 출처: ${inlineText(last?.source ?? '없음')}`);
    if (kind === 'candidate') lines.push(`- 반증: ${row.disproof?.trim() ? inlineText(row.disproof) : '반증 없음 — 승격 불가'}`);
    if (kind === 'enforced' || kind === 'promoted') lines.push(`- 강제 자리: ${inlineText(row.enforced_by)}`);
    lines.push('');
  }
  return lines;
}

export function generateHandbookPage(options: { stateDir?: string; out?: string } = {}): {
  total: number; byStatus: Record<LessonStatus, number>; unenforced: number; out: string;
} | { skipped: 'empty-ledger' } {
  const ledger = new LessonLedger({ stateDir: options.stateDir });
  const rows = ledger.list();
  if (!rows.length) return { skipped: 'empty-ledger' };
  const out = options.out ?? join(dirname(ledger.path), 'handbook-lessons.md');
  const byStatus: Record<LessonStatus, number> = { candidate: 0, open: 0, enforced: 0, promoted: 0 };
  for (const row of rows) byStatus[row.status]++;
  const unenforcedRows = rows.filter(row => row.status === 'open' && !row.enforced_by.trim());
  const unenforced = unenforcedRows.length;
  const lines = [
    '# 교훈', '',
    `생성 시각: ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'long' }).format(new Date())} (KST)`,
    `총 ${rows.length} · ${statuses.map(status => `${status} ${byStatus[status]}`).join(' · ')} · 강제 자리 없음 ${unenforced}`,
    '',
    ...section('승격 후보', rows.filter(row => row.status === 'candidate'), ledger, 'candidate'),
    ...section('강제 자리 없음', unenforcedRows, ledger, 'open'),
    ...section('강제됨', rows.filter(row => row.status === 'enforced'), ledger, 'enforced'),
    ...section('규칙으로 승격됨', rows.filter(row => row.status === 'promoted'), ledger, 'promoted'),
  ];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  debug.log('lessons.handbook', 'rendered', { total: rows.length, byStatus, unenforced, out });
  return { total: rows.length, byStatus, unenforced, out };
}

if (import.meta.main) {
  try {
    const options = args(process.argv.slice(2));
    const result = generateHandbookPage(options);
    console.log(options.json ? JSON.stringify(result) : 'skipped' in result ? `skipped: ${result.skipped}` : `rendered: ${result.out}`);
  } catch (error) {
    console.error(`handbook-page: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
