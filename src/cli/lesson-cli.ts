import type { Command } from 'commander';
import { resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { importLessons, scanLessonDocs } from '../lessons/lesson-import.js';
import { LessonInputError, LessonLedger, type LessonLedgerOptions, type LessonRow, type LessonDetail } from '../lessons/lesson-ledger.js';

function actor(explicit?: string): string {
  const by = explicit?.trim() || process.env.AI_AGENT?.trim();
  if (!by) throw new LessonInputError('--by or AI_AGENT is required');
  return by;
}

function reportError(command: string, message: string): void {
  const escaped = message.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  process.stderr.write(`lesson ${command}: ${escaped}\n`);
  process.exitCode = 1;
}

function handle<Args extends unknown[]>(command: string, action: (...args: Args) => void): (...args: Args) => void {
  return (...args) => {
    try { action(...args); }
    catch (error) {
      if (!(error instanceof LessonInputError)) throw error;
      reportError(command, error.message);
    }
  };
}

function format(row: LessonRow): string {
  return `${row.id} · ${row.status} · ${row.occurrence_count}회 · ${row.incident} · ${row.owner}`;
}

function detail(row: LessonDetail): string {
  return [format(row), `원인: ${row.cause}`, `처방: ${row.remedy}`, `강제: ${row.enforced_by || '없음'}`,
    ...(row.disproof ? [`반증: ${row.disproof}`] : []),
    '발생:', ...row.occurrences.map(o => `  ${o.at} · ${o.source}${o.note ? ` · ${o.note}` : ''}`),
    '이력:', ...row.history.map(h => `  ${h.at} · ${h.event} · ${h.by} · ${h.detail}`)].join('\n');
}

export function registerLessonCommands(program: Command, options: LessonLedgerOptions = {}, out: Pick<Console, 'log'> = console): void {
  const root = program.command('lesson').description('사고 · 원인 · 처방 · 재발 교훈 원장');
  const ledger = () => new LessonLedger(options);
  const emit = (value: unknown, json: boolean | undefined, text: string) => out.log(json ? JSON.stringify(value) : text);
  root.command('import').description('INCIDENT·FINDING 문서 교훈 미리 보기 (기본값); --apply 로 적재')
    .option('--apply', '원장에 적재').option('--json', 'JSON 출력').option('--by <name>', '기록자 (기본 AI_AGENT)')
    .action(handle('import', (o: { apply?: boolean; json?: boolean; by?: string }) => {
      const by = actor(o.by);
      const scan = scanLessonDocs(resolve(process.cwd()));
      const imported = importLessons(ledger(), scan.items, { apply: !!o.apply, by });
      const result = { files: scan.files, items: imported.items, skipped: [...scan.skipped, ...imported.skipped],
        emptyCause: imported.items.filter(item => !item.cause).length,
        emptyRemedy: imported.items.filter(item => !item.remedy).length, written: imported.written };
      if (o.apply) debug.log('lessons.import', 'applied', { files: result.files, items: result.items.length,
        skipped: result.skipped.length, written: result.written });
      emit(result, o.json, `파일 ${result.files} · 넣을 교훈 ${result.items.length} · 건너뜀 ${result.skipped.length} · 빈 원인 ${result.emptyCause} · 빈 처방 ${result.emptyRemedy} · 기록 ${result.written}`);
    }));
  root.command('page').description('교훈 원장에서 핸드북 페이지 생성')
    .option('--out <file>', '출력 파일').option('--json', 'JSON 출력')
    .action(async (o: { out?: string; json?: boolean }) => {
      try {
        const { generateHandbookPage } = await import('../../scripts/lessons/handbook-page.js');
        const result = generateHandbookPage({ stateDir: options.stateDir, out: o.out });
        emit(result, o.json, 'skipped' in result
          ? '교훈 페이지: 건너뜀(원장 비어 있음)'
          : `교훈 페이지: ${result.out} · 총 ${result.total} · 강제 자리 없음 ${result.unenforced}`);
      } catch (error) {
        reportError('page', error instanceof Error ? error.message : String(error));
      }
    });
  root.command('add <id>').requiredOption('--incident <text>').requiredOption('--cause <text>')
    .requiredOption('--remedy <text>').requiredOption('--owner <name>').requiredOption('--source <path>')
    .option('--enforced-by <paths>').option('--disproof <command>').option('--by <name>')
    .action(handle('add', (id: string, o: { incident: string; cause: string; remedy: string; owner: string; source: string; enforcedBy?: string; disproof?: string; by?: string }) => {
      const by = actor(o.by);
      const row = ledger().add({ id, incident: o.incident, cause: o.cause, remedy: o.remedy, owner: o.owner,
        source: o.source, by, ...(o.enforcedBy !== undefined ? { enforcedBy: o.enforcedBy } : {}),
        ...(o.disproof !== undefined ? { disproof: o.disproof } : {}) });
      emit(row, false, format(row));
    }));
  root.command('recur <id>').requiredOption('--source <path>').option('--note <text>').option('--by <name>')
    .action(handle('recur', (id: string, o: { source: string; note?: string; by?: string }) => {
      const row = ledger().recur(id, { source: o.source, note: o.note ?? '', by: actor(o.by) });
      emit(row, false, format(row));
    }));
  root.command('enforce <id>').requiredOption('--enforced-by <paths>').option('--by <name>')
    .action(handle('enforce', (id: string, o: { enforcedBy: string; by?: string }) => {
      const row = ledger().enforce(id, { enforcedBy: o.enforcedBy, by: actor(o.by) });
      emit(row, false, format(row));
    }));
  root.command('promote <id>').requiredOption('--rule <path>').option('--by <name>')
    .action(handle('promote', (id: string, o: { rule: string; by?: string }) => {
      const row = ledger().promote(id, { rulePath: o.rule, by: actor(o.by) });
      emit(row, false, format(row));
    }));
  root.command('find <query>').option('--json').action(handle('find', (query: string, o: { json?: boolean }) => {
    const rows = ledger().find(query);
    emit(rows, o.json, rows.length ? rows.map(format).join('\n') : '교훈 0건');
  }));
  root.command('show <id>').option('--json').action(handle('show', (id: string, o: { json?: boolean }) => {
    const row = ledger().get(id);
    emit(row, o.json, detail(row));
  }));
  root.command('candidates').option('--json').action(handle('candidates', (o: { json?: boolean }) => {
    const rows = ledger().candidates();
    emit(rows, o.json, rows.length ? rows.map(format).join('\n') : '승격 후보 0건');
  }));
}
