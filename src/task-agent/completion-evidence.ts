import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { DecisionLedger } from '../decisions/decision-ledger.js';
import { getLastStatus } from '../domains/schedule-registry.js';

export type CompletionEvidenceKind = 'research-report' | 'artifact' | 'content' | 'ops-action' | 'watch-brief' | 'decision-support' | 'deliverable';
export interface CompletionEvidenceDeps {
  ledger?: Pick<DecisionLedger, 'list'>;
  schedulesDb?: Database;
}

/** A missing record is negative evidence; a failed read is explicitly unmeasured. No store is opened or mutated here. */
export function checkCompletionEvidence(
  kind: CompletionEvidenceKind,
  input: { dir: string; ref: string; receipt?: boolean },
  deps: CompletionEvidenceDeps = {},
): { ok: boolean; ref: string; missing: string[] } {
  const missing: string[] = [];
  const add = (item: string) => { if (!missing.includes(item)) missing.push(item); };
  const pathFor = (ref: string): string | null => {
    const root = resolve(input.dir);
    const path = resolve(root, ref);
    const rel = relative(root, path);
    return !isAbsolute(ref) && rel !== '..' && !rel.startsWith(`..${sep}`) ? path : null;
  };
  const read = (path: string): string | null => {
    try { return readFileSync(path, 'utf8'); }
    catch (error) {
      add((error as NodeJS.ErrnoException).code === 'ENOENT' ? '파일' : '못 쟀다: 파일 읽기');
      return null;
    }
  };
  const file = () => {
    const path = pathFor(input.ref);
    if (!path) add('못 쟀다: 경로');
    return path;
  };

  switch (kind) {
    case 'deliverable': {
      const ref = input.ref.trim();
      if (/^https?:\/\//i.test(ref)) {
        try {
          const url = new URL(ref);
          if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) add('산출물 링크');
        } catch { add('산출물 링크'); }
      } else if (!ref || /^[a-z][a-z\d+.-]*:/i.test(ref)) {
        add('산출물 경로 또는 링크');
      } else {
        const path = pathFor(ref);
        if (!path) add('못 쟀다: 경로');
        else {
          try {
            const root = realpathSync(input.dir);
            const actual = realpathSync(path);
            const rel = relative(root, actual);
            if (rel === '..' || rel.startsWith(`..${sep}`)) add('못 쟀다: 경로');
            else {
              const stat = statSync(actual);
              if (!stat.isFile() || stat.size === 0) add('산출물 파일');
            }
          } catch (error) { add((error as NodeJS.ErrnoException).code === 'ENOENT' ? '산출물 파일' : '못 쟀다: 산출물 파일 읽기'); }
        }
      }
      if (input.receipt !== true) add('수신 확인');
      break;
    }
    case 'research-report': {
      const path = file();
      if (!path) break;
      if (extname(path).toLowerCase() !== '.md') { add('md 파일'); break; }
      const text = read(path);
      if (text === null) break;
      const sources = new Set([...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((match) => match[0]!.replace(/[.,;]+$/, '')));
      if (sources.size < 2) add('출처');
      if (!/^#{1,6}\s*반대 근거\s*$/m.test(text)) add('반대 근거');
      break;
    }
    case 'artifact':
    case 'content': {
      const path = file();
      if (!path) break;
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size === 0) add('파일 크기');
      } catch (error) { add((error as NodeJS.ErrnoException).code === 'ENOENT' ? '파일' : '못 쟀다: 파일 크기'); }
      const stem = path.slice(0, path.length - extname(path).length);
      let preview = false;
      for (const ext of ['.png', '.pdf', '.html']) {
        const candidate = `${stem}${ext}`;
        if (candidate === path) continue;
        try {
          const stat = statSync(candidate);
          if (stat.isFile() && stat.size > 0) preview = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add('못 쟀다: 미리보기 읽기');
        }
      }
      if (extname(path).toLowerCase() === '.md' && !missing.includes('파일')) {
        const text = read(path);
        if (text !== null && /^#{1,6}\s+\S.*$/m.test(text)) preview = true;
      }
      if (!preview && !missing.some((item) => item.startsWith('못 쟀다: 미리보기') || item === '못 쟀다: 파일 읽기')) add('미리보기');
      break;
    }
    case 'ops-action': {
      const path = pathFor('execution.jsonl');
      if (!path) { add('못 쟀다: 경로'); break; }
      let text: string;
      try { text = readFileSync(path, 'utf8'); }
      catch (error) {
        add((error as NodeJS.ErrnoException).code === 'ENOENT' ? '실행 기록' : '못 쟀다: 실행 기록 읽기');
        break;
      }
      let execution = false;
      let readback = false;
      for (const line of text.split('\n').filter((line) => line.trim())) {
        let record: unknown;
        try { record = JSON.parse(line); }
        catch { add('못 쟀다: 실행 기록 해석'); continue; }
        if (!record || typeof record !== 'object') { add('못 쟀다: 실행 기록 해석'); continue; }
        const entry = record as { id?: unknown; type?: unknown };
        if (entry.id !== input.ref) continue;
        if (entry.type === 'execution') execution = true;
        if (entry.type === 'readback') readback = true;
      }
      if (!missing.includes('못 쟀다: 실행 기록 해석')) {
        if (!execution) add('실행 기록');
        if (!readback) add('되읽기');
      }
      break;
    }
    case 'watch-brief': {
      if (!deps.schedulesDb) { add('못 쟀다: 스케줄 DB'); break; }
      try {
        const row = deps.schedulesDb.query('SELECT id FROM schedule_registry WHERE id = ?').get(input.ref);
        if (!row) add('일정');
        else if (getLastStatus(deps.schedulesDb, input.ref) !== 'ok') add('도착');
      } catch { add('못 쟀다: 스케줄 DB 읽기'); }
      break;
    }
    case 'decision-support': {
      if (!deps.ledger) { add('못 쟀다: 결정 원장'); break; }
      try {
        if (!deps.ledger.list({ status: 'all' }).some((entry) => entry.id === input.ref)) add('결정 기록');
      } catch { add('못 쟀다: 결정 원장 읽기'); }
      break;
    }
    default:
      add('못 쟀다: 증거 종류');
  }
  return { ok: missing.length === 0, ref: input.ref, missing };
}
