import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySignal, judgeLandedCell, parseJudgeSignals } from './landed-to-green.js';

const version = '0.2.24';
const line = '판정 신호: 조건 = 테스트; 관측 = bun test src/release-loop/landed-to-green.test.ts; 기대 = 0 fail';

function entries(root: string) {
  return readFileSync(join(root, 'release', version, 'green-proposals.jsonl'), 'utf8').trim().split('\n').map((entry) => JSON.parse(entry));
}

describe('landed cell judgment', () => {
  test('parses every line, keeps missing fields null and rejects shell suffixes and natural language', () => {
    const signals = parseJudgeSignals([
      '앞 문면',
      '판정 신호: 조건 = 둘; 관측 = bun test a.test.ts b.test.ts; 기대 = 0 fail',
      '판정 신호: 조건 = 위험; 관측 = bun test a.test.ts; echo oops; 기대 = 0 fail',
      '판정 신호: 관측 = 하루 운영 p95',
    ].join('\n'));
    expect(signals).toEqual([
      { condition: '둘', observe: 'bun test a.test.ts b.test.ts', expect: '0 fail' },
      { condition: '위험', observe: 'bun test a.test.ts; echo oops', expect: '0 fail' },
      { condition: null, observe: '하루 운영 p95', expect: null },
    ]);
    expect(classifySignal(signals[0]!)).toEqual({ kind: 'measurable', argv: ['bun', 'test', 'a.test.ts', 'b.test.ts'] });
    expect(classifySignal(signals[1]!).kind).toBe('unmeasurable');
    expect(classifySignal(signals[2]!).kind).toBe('unmeasurable');
    for (const observe of ['bun test a.test.ts | cat', 'bun test a.test.ts && true', 'bun test a.test.ts $HOME', 'bun test a.test.ts `id`', 'bun test a.test.ts > out', 'bun test a.test.ts < in', 'bun test -t a.test.ts', 'bun test a.ts']) {
      expect(classifySignal({ condition: null, observe, expect: null }).kind).toBe('unmeasurable');
    }
  });

  test('records proposed, not-passed, unmeasurable in order; never runs when unmeasurable', () => {
    const root = mkdtempSync(join(tmpdir(), 'landed-green-'));
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    const events: string[] = [];
    let exit = 0;
    const deps = {
      ledgerRoot: root, cwd: root,
      run: (argv: string[], cwd: string) => { calls.push({ argv, cwd }); return exit; },
      log: (_category: string, event: string) => { events.push(event); },
    };
    try {
      expect(judgeLandedCell({ version, id: 'X', title: line, pr: 42 }, deps)).toBe('proposed');
      exit = 1;
      expect(judgeLandedCell({ version, id: 'Y', title: line, pr: 42 }, deps)).toBe('not-passed');
      expect(judgeLandedCell({ version, id: 'Z', title: 'no signals', pr: 42 }, deps)).toBe('unmeasurable');
      expect(judgeLandedCell({ version, id: 'W', title: '판정 신호: 관측 = bun test a.test.ts; rm -rf x', pr: 42 }, deps)).toBe('unmeasurable');
      expect(judgeLandedCell({ version, id: 'V', title: `${line}\n판정 신호: 관측 = 하루 운영 p95`, pr: 42 }, deps)).toBe('unmeasurable');
      expect(calls).toEqual([
        { argv: ['bun', 'test', 'src/release-loop/landed-to-green.test.ts'], cwd: root },
        { argv: ['bun', 'test', 'src/release-loop/landed-to-green.test.ts'], cwd: root },
      ]);
      expect(entries(root).map(({ verdict }) => verdict)).toEqual(['proposed', 'not-passed', 'unmeasurable', 'unmeasurable', 'unmeasurable']);
      expect(entries(root)[0]).toMatchObject({ version, id: 'X', pr: 42, signals: [{ condition: '테스트', observe: 'bun test src/release-loop/landed-to-green.test.ts', expect: '0 fail' }] });
      expect(entries(root)[0]!.at).toEqual(expect.any(String));
      expect(entries(root)[2]!.reason).toEqual(expect.any(String));
      expect(events).toEqual(['landed-green-proposed', 'landed-green-not-passed', 'landed-green-unmeasurable', 'landed-green-unmeasurable', 'landed-green-unmeasurable']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('checks every measurable signal in order, stopping on a nonzero exit', () => {
    const root = mkdtempSync(join(tmpdir(), 'landed-green-order-'));
    const title = '판정 신호: 관측 = bun test first.test.ts\n판정 신호: 관측 = bun test second.test.ts\n판정 신호: 관측 = bun test third.test.ts';
    const calls: string[] = [];
    try {
      expect(judgeLandedCell({ version, id: 'X', title, pr: 45 }, {
        ledgerRoot: root, cwd: root, log: () => {},
        run: (argv) => { calls.push(argv[2]!); return argv[2] === 'second.test.ts' ? 1 : 0; },
      })).toBe('not-passed');
      expect(calls).toEqual(['first.test.ts', 'second.test.ts']);
      expect(entries(root)[0]).toMatchObject({ verdict: 'not-passed', signals: [
        { observe: 'bun test first.test.ts' }, { observe: 'bun test second.test.ts' }, { observe: 'bun test third.test.ts' },
      ] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('runs real bun test with the default spawnSync runner without changing checklist status', () => {
    const root = mkdtempSync(join(tmpdir(), 'landed-green-spawn-'));
    writeFileSync(join(root, 'ok.test.ts'), "import { test, expect } from 'bun:test'; test('ok', () => expect(1).toBe(1));\n");
    try {
      expect(judgeLandedCell({ version, id: 'X', title: '판정 신호: 관측 = bun test ok.test.ts', pr: 43 }, { cwd: root, ledgerRoot: root, log: () => {} })).toBe('proposed');
      expect(entries(root)[0]).toMatchObject({ verdict: 'proposed', id: 'X', pr: 43 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 65_000);

  test('spawn or ledger write errors fail softly with one error event and no proposal', () => {
    const root = mkdtempSync(join(tmpdir(), 'landed-green-error-'));
    const events: Array<{ event: string; data: unknown }> = [];
    const log = (_category: string, event: string, data: unknown) => { events.push({ event, data }); };
    try {
      expect(judgeLandedCell({ version, id: 'X', title: line, pr: 44 }, { cwd: root, ledgerRoot: root, run: () => { throw new Error('spawn failure'); }, log })).toBeUndefined();
      expect(events).toMatchObject([{ event: 'landed-green-error', data: { version, id: 'X', pr: 44, error: 'Error: spawn failure' } }]);
      expect(judgeLandedCell({ version, id: 'Y', title: line, pr: 44 }, { cwd: root, ledgerRoot: join(root, 'missing'), run: () => 0, log })).toBe('proposed');
      writeFileSync(join(root, 'not-a-directory'), 'x');
      expect(judgeLandedCell({ version, id: 'Z', title: line, pr: 44 }, { cwd: root, ledgerRoot: join(root, 'not-a-directory'), run: () => 0, log })).toBeUndefined();
      expect(events[1]).toMatchObject({ event: 'landed-green-proposed' });
      expect(events[2]).toMatchObject({ event: 'landed-green-error', data: { version, id: 'Z', pr: 44 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
