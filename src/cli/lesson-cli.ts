import type { Command } from 'commander';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

function validAuthoringLessonClass(value: string): boolean {
  return new Set(['a-missing-predecessor', 'b-stale-path', 'c-unbounded-goal', 'd-rigid-acceptance',
    'e-format-trap', 'f-unaware-of-code', 'g-umbrella-scope']).has(value) || /^env-[a-z0-9][a-z0-9-]*$/u.test(value);
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
  root.command('add [id]').option('--incident <text>').option('--cause <text>').option('--remedy <text>')
    .option('--owner <name>').option('--source <path>').option('--enforced-by <paths>').option('--disproof <command>').option('--by <name>')
    .option('--authoring', '05-authoring-lessons.jsonl에 저작 교훈 한 행 추가')
    .option('--cell <name>').option('--class <class>').option('--diag <text>').option('--action <text>').option('--lesson <text>')
    .option('--run <id>').option('--card <id>').option('--launch <id>').option('--goal-sha <sha>')
    .option('--paths <paths>').option('--model <model>').option('--host <host>').option('--evidence <text>')
    .option('--rule <text>').option('--ms <milliseconds>').option('--outcome <state>', 'pending, fixed 또는 repeated')
    .option('--resolve-pending <state>', '같은 cell/class의 pending을 fixed 또는 repeated로 전이')
    .action(handle('add', (id: string | undefined, o: Record<string, string | boolean | undefined>) => {
      if (o.authoring) {
        const required = ['source', 'cell', 'class', 'diag', 'action', 'lesson'] as const;
        const missing = required.filter((key) => typeof o[key] !== 'string' || !(o[key] as string).trim());
        if (missing.length) throw new LessonInputError(`authoring fields required: ${missing.map(key => `--${key}`).join(', ')}`);
        if (!validAuthoringLessonClass(o.class as string)) throw new LessonInputError('--class is not in the authoring lesson class set');
        const outcome = typeof o.outcome === 'string' ? o.outcome : 'pending';
        if (!['pending', 'fixed', 'repeated'].includes(outcome)) throw new LessonInputError('--outcome must be pending, fixed, or repeated');
        if (o.resolvePending !== undefined && !['fixed', 'repeated'].includes(o.resolvePending as string)) {
          throw new LessonInputError('--resolve-pending must be fixed or repeated');
        }
        const row: Record<string, string> = {
          ts: new Date().toISOString(), by: actor(typeof o.by === 'string' ? o.by : undefined),
          source: o.source as string, cell: o.cell as string, class: o.class as string, diag: o.diag as string,
          action: o.action as string, lesson: o.lesson as string, run: String(o.run ?? ''), card: String(o.card ?? ''),
          launch: String(o.launch ?? ''), goalSha: String(o.goalSha ?? ''), paths: String(o.paths ?? ''),
          model: String(o.model ?? ''), host: String(o.host ?? ''), evidence: String(o.evidence ?? ''),
          rule: String(o.rule ?? ''), ms: String(o.ms ?? ''), outcome,
        };
        const path = resolve(process.cwd(), 'docs/goal-context/05-authoring-lessons.jsonl');
        let lines: string[] = [];
        try {
          lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean);
          for (const line of lines) {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LessonInputError('authoring lessons ledger is unreadable or malformed');
        }
        if (typeof o.resolvePending === 'string') {
          lines = lines.map((line) => {
            const prior = JSON.parse(line) as Record<string, unknown>;
            return prior.cell === row.cell && prior.class === row.class && prior.outcome === 'pending'
              ? JSON.stringify({ ...prior, outcome: o.resolvePending }) : line;
          });
        }
        mkdirSync(dirname(path), { recursive: true });
        const next = [...lines, JSON.stringify(row)].join('\n') + '\n';
        const temp = `${path}.tmp-${process.pid}`;
        writeFileSync(temp, next, { encoding: 'utf8', flag: 'w' });
        renameSync(temp, path);
        emit({ written: true, row }, false, `저작 교훈 추가 · ${row.cell} · ${row.class} · ${row.outcome}`);
        return;
      }
      const required = ['incident', 'cause', 'remedy', 'owner', 'source'] as const;
      const missing: string[] = required.filter((key) => typeof o[key] !== 'string' || !(o[key] as string).trim());
      if (!id?.trim()) missing.unshift('id');
      if (missing.length) throw new LessonInputError(`required: ${missing.map(key => key === 'id' ? 'id' : `--${key}`).join(', ')}`);
      const by = actor(typeof o.by === 'string' ? o.by : undefined);
      const row = ledger().add({ id, incident: o.incident as string, cause: o.cause as string, remedy: o.remedy as string,
        owner: o.owner as string, source: o.source as string, by,
        ...(o.enforcedBy !== undefined ? { enforcedBy: o.enforcedBy as string } : {}),
        ...(o.disproof !== undefined ? { disproof: o.disproof as string } : {}) });
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
