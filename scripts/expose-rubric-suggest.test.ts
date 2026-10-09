import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { checkExposeRubric } from './expose-rubric-check.js';
import { run, suggestExposeRubric } from './expose-rubric-suggest.js';
import type { HelpRunner } from './docs-cli-check.js';

const root = mkdtempSync(join(tmpdir(), 'expose-rubric-suggest-'));
const docs = join(root, 'release/public/docs');
mkdirSync(docs, { recursive: true });
writeFileSync(join(docs, 'one.md'), '# Clean\n`elanous doctor --fix`\n');
writeFileSync(join(docs, 'two.md'), '# Missing\n`elanous doctor missing`\n');
writeFileSync(join(docs, 'three.md'), '# Home\n/Users/example/secret\n');
const ledger = join(root, 'release/public/expose-rubric.yaml');
const criterion = { status: 'n/a', reason: '초기 적재 — 재심 필요' };
const entries = ['one.md', 'two.md', 'three.md'].map((name) => ({
  path: `release/public/docs/${name}`, verdict: 'internal', judge: 'MK', at: '2026-10-04T13:38:41.963Z',
  criteria: Object.fromEntries(['maturity', 'value', 'reproducible', 'evidence', 'confidential', 'brand', 'support'].map((key) => [key, { ...criterion }])),
}));
writeFileSync(ledger, stringify({ entries }));
const original = readFileSync(ledger);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const help: HelpRunner = (args) => {
  if (!args.length) return { ok: true, out: 'Usage: elanous\nCommands:\n  doctor [options]  diagnose\n' };
  if (args.join(' ') === 'doctor') return { ok: true, out: 'Usage: elanous doctor\nOptions:\n  --fix  fix\nCommands:\n  status  check\n' };
  return { ok: false, out: '' };
};

const path = (name: string) => `release/public/docs/${name}.md`;

describe('expose rubric suggestions — measurement, not judgement', () => {
  test('세 문서: 깨끗한 명령은 pass, 없는 하위 명령은 fail, 홈 경로는 브랜드 위반; 원장 바이트 불변', () => {
    const result = suggestExposeRubric(root, undefined, help);
    expect(result.map((item) => item.path)).toEqual([path('one'), path('three'), path('two')]);
    const byName = Object.fromEntries(result.map((item) => [item.path, item.criteria]));
    expect(byName[path('one')]).toEqual({
      reproducible: { status: 'pass', reason: '명령 1개 모두 --help 에 있음' },
      confidential: { status: 'pass', reason: '누출 표식 없음' },
      brand: { status: 'pass', reason: '브랜드 규칙 위반 없음' },
    });
    expect(byName[path('two')]!.reproducible).toEqual({ status: 'fail', reason: '없는 명령: elanous doctor missing' });
    expect(byName[path('three')]!.reproducible).toEqual({ status: 'n/a', reason: '문서에 elanous 명령 없음' });
    expect(['confidential', 'brand'].some((key) => byName[path('three')]![key as 'confidential' | 'brand'].status === 'fail')).toBe(true);
    expect(byName[path('three')]!.brand).toEqual({ status: 'fail', reason: '브랜드 규칙: B7' });
    expect(readFileSync(ledger)).toEqual(original);
  });

  test('missing brand rules mark only brand unmeasured and keep independent passes in API, CLI and YAML patch', () => {
    const missing = join(root, 'absent-rules.yaml');
    const [row] = suggestExposeRubric(root, [path('one')], help, missing);
    expect(row!.criteria).toEqual({
      reproducible: { status: 'pass', reason: '명령 1개 모두 --help 에 있음' },
      confidential: { status: 'pass', reason: '누출 표식 없음' },
      brand: { status: 'n/a', reason: '규칙 없음 — 측정 불가' },
    });
    const lines: string[] = [];
    const print = console.log;
    const patch = join(root, 'missing-rules-patch.yaml');
    try {
      console.log = (...args) => { lines.push(args.join(' ')); };
      expect(run(['--files', path('one'), '--rules', missing, '--yaml-patch', patch], root, help)).toBe(0);
    } finally { console.log = print; }
    expect(lines[0]).toContain('brand n/a(규칙 없음 — 측정 불가)');
    expect(lines[1]).toContain('pass 2');
    expect(parse(readFileSync(patch, 'utf8')).entries[0].criteria).toEqual(row!.criteria);
    expect(readFileSync(ledger)).toEqual(original);
    const [measured] = suggestExposeRubric(root, [path('one')], help);
    expect(measured!.criteria.brand).toEqual({ status: 'pass', reason: '브랜드 규칙 위반 없음' });
  });

  test('missing brand rules do not hide a confidential leak or an independent failure', () => {
    const missing = join(root, 'absent-rules.yaml');
    const leak = path('leaking');
    writeFileSync(join(root, leak), '# Example\n// Created by Example Author\n`elanous doctor missing`\n');
    try {
      const [row] = suggestExposeRubric(root, [leak], help, missing);
      expect(row!.criteria.brand).toEqual({ status: 'n/a', reason: '규칙 없음 — 측정 불가' });
      expect(row!.criteria.confidential).toEqual({ status: 'fail', reason: '누출 표식: xcode-author-header' });
      expect(row!.criteria.reproducible).toEqual({ status: 'fail', reason: '없는 명령: elanous doctor missing' });
      const [measured] = suggestExposeRubric(root, [leak], help);
      expect(row!.criteria.confidential).toEqual(measured!.criteria.confidential);
      const lines: string[] = [];
      const print = console.log;
      try {
        console.log = (...args) => { lines.push(args.join(' ')); };
        expect(run(['--json', '--files', leak, '--rules', missing], root, help)).toBe(0);
      } finally { console.log = print; }
      expect(JSON.parse(lines[0]!).at(0).criteria).toEqual(row!.criteria);
      expect(readFileSync(ledger)).toEqual(original);
    } finally { rmSync(join(root, leak)); }
  });

  test('help 예외·실패는 없는 명령이라 추측하지 않고 n/a, 나머지 기준은 계속 측정', () => {
    for (const down of [(() => { throw new Error('help down\nraw details'); }) as HelpRunner, (() => ({ ok: false, out: '' })) as HelpRunner]) {
      const [item] = suggestExposeRubric(root, [path('one')], down);
      expect(item!.criteria.reproducible.status).toBe('n/a');
      expect(item!.criteria.reproducible.reason).toStartWith('측정 불가: ');
      expect(item!.criteria.reproducible.reason).not.toContain('\n');
      expect(item!.criteria.confidential.status).toBe('pass');
      expect(item!.criteria.brand.status).toBe('pass');
    }
  });

  test('최상위 명령 help 실패는 재시도 후에도 fail 이 아닌 측정 불가이며 같은 판에 실패를 공유한다', () => {
    const calls: string[] = [];
    const down: HelpRunner = (args) => {
      calls.push(args.join(' '));
      return args.join(' ') === 'doctor' ? { ok: false, out: '' } : help(args);
    };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const [one, two] = suggestExposeRubric(root, [path('one'), path('two')], down);
      expect(one!.criteria.reproducible).toEqual({ status: 'n/a', reason: '측정 불가: elanous doctor --help 실패(빈 출력)' });
      expect(two!.criteria.reproducible).toEqual(one!.criteria.reproducible);
      expect(calls.filter((key) => key === 'doctor')).toHaveLength(2);
      expect(calls.filter((key) => key === '')).toHaveLength(1);
      expect(log).toHaveBeenCalledWith('expose.rubric', 'suggested', expect.objectContaining({ helpRuns: 0, helpFailures: 2 }));
    } finally { log.mockRestore(); }
  });

  test('실패 사유의 exit·timeout 을 한 줄로 기록한다', () => {
    for (const failure of ['exit 7', 'timeout']) {
      const down: HelpRunner = (args) => args.join(' ') === 'doctor'
        ? { ok: false, out: 'partial output', failure }
        : help(args);
      const [item] = suggestExposeRubric(root, [path('one')], down);
      expect(item!.criteria.reproducible).toEqual({ status: 'n/a', reason: `측정 불가: elanous doctor --help 실패(${failure})` });
    }
  });

  test('관측은 주입 러너를 spawn 으로 세지 않고 실패 시도 횟수를 센다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let attempts = 0;
    const flaky: HelpRunner = (args) => {
      if (args.join(' ') === 'doctor' && ++attempts === 1) return { ok: false, out: '' };
      return help(args);
    };
    try {
      suggestExposeRubric(root, [path('one')], flaky);
      expect(log).toHaveBeenCalledWith('expose.rubric', 'suggested', expect.objectContaining({ helpRuns: 0, helpFailures: 1 }));
    } finally { log.mockRestore(); }
  });

  test('기본 러너 관측의 helpRuns 는 중복 문서 없이 실제 spawn 수다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = suggestExposeRubric(root, [path('one'), path('two')]);
      expect(result[0]!.criteria.reproducible.status).toBe('pass');
      expect(log).toHaveBeenCalledWith('expose.rubric', 'suggested', expect.objectContaining({ helpRuns: 2, helpFailures: 0 }));
    } finally { log.mockRestore(); }
  }, 60_000);

  test('루트 help 실패도 재시도 후 모든 참조 문서에서 측정 불가', () => {
    let attempts = 0;
    const down: HelpRunner = (args) => {
      if (!args.length) { attempts++; return { ok: false, out: '' }; }
      return help(args);
    };
    const rows = suggestExposeRubric(root, [path('one'), path('two')], down);
    expect(rows.map((row) => row.criteria.reproducible)).toEqual(Array(2).fill({
      status: 'n/a', reason: '측정 불가: elanous --help 실패(빈 출력)',
    }));
    expect(attempts).toBe(2);
  });

  test('성공 상태여도 빈 help 출력이면 재시도 후 측정 불가', () => {
    let attempts = 0;
    const empty: HelpRunner = (args) => {
      if (args.join(' ') === 'doctor') { attempts++; return { ok: true, out: ' \n ' }; }
      return help(args);
    };
    const [item] = suggestExposeRubric(root, [path('one')], empty);
    expect(item!.criteria.reproducible).toEqual({ status: 'n/a', reason: '측정 불가: elanous doctor --help 실패(빈 출력)' });
    expect(attempts).toBe(2);
  });

  test('세 문서가 같은 명령을 쓰면 help 는 판당 한 번만 실행하고 호출 간 캐시는 공유하지 않는다', () => {
    const copies = ['repeat-a', 'repeat-b', 'repeat-c'];
    for (const name of copies) writeFileSync(join(docs, `${name}.md`), '# Repeat\n`elanous doctor --fix`\n');
    const calls: string[] = [];
    const counted: HelpRunner = (args) => { calls.push(args.join(' ')); return help(args); };
    try {
      const files = copies.map(path);
      const first = suggestExposeRubric(root, files, counted);
      expect(first.map((item) => item.criteria.reproducible.status)).toEqual(['pass', 'pass', 'pass']);
      expect(calls).toEqual(['', 'doctor']);
      const second = suggestExposeRubric(root, files, counted);
      expect(second).toEqual(first);
      expect(calls).toEqual(['', 'doctor', '', 'doctor']);
    } finally { for (const name of copies) rmSync(join(docs, `${name}.md`)); }
  });

  test('첫 help 실패 뒤 재시도 성공이면 pass', () => {
    let attempts = 0;
    const flaky: HelpRunner = (args) => {
      if (args.join(' ') === 'doctor' && ++attempts === 1) return { ok: false, out: '' };
      return help(args);
    };
    const [item] = suggestExposeRubric(root, [path('one')], flaky);
    expect(item!.criteria.reproducible).toEqual({ status: 'pass', reason: '명령 1개 모두 --help 에 있음' });
    expect(attempts).toBe(2);
  });

  test('하위 명령 --help 실패도 부모 도움말로 pass 를 지어내지 않는다', () => {
    writeFileSync(join(docs, 'sub.md'), '# Sub\n`elanous doctor status`\n');
    const subHelpDown: HelpRunner = (args) => {
      if (args.join(' ') === 'doctor status') return { ok: false, out: '' };
      return help(args);
    };
    try {
      const [item] = suggestExposeRubric(root, [path('sub')], subHelpDown);
      expect(item!.criteria.reproducible).toEqual({ status: 'n/a', reason: '측정 불가: elanous doctor status --help 실패(빈 출력)' });
      expect(readFileSync(ledger)).toEqual(original);
    } finally { rmSync(join(docs, 'sub.md')); }
  });

  test('--yaml-patch 는 세 키만 내고 checker 원장 항목에 손 병합 가능한 status/reason 형태이며 실제 원장은 불변', () => {
    const patch = join(root, 'suggestions.yaml');
    const lines: string[] = [];
    const print = console.log;
    try {
      console.log = (...args) => { lines.push(args.join(' ')); };
      expect(run(['--yaml-patch', patch, '--json', '--files', path('one'), path('two'), path('three')], root, help)).toBe(0);
      expect(JSON.parse(lines[0]!)).toHaveLength(3);
    } finally { console.log = print; }
    const rows = parse(readFileSync(patch, 'utf8')).entries;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['criteria', 'path']);
      expect(Object.keys(row.criteria).sort()).toEqual(['brand', 'confidential', 'reproducible']);
      for (const item of Object.values(row.criteria) as Array<{ status: string; reason: string }>) {
        expect(['pass', 'fail', 'n/a']).toContain(item.status);
        expect(item.reason.trim()).not.toBe('');
        expect(item.reason).not.toContain('\n');
      }
    }
    expect(readFileSync(ledger)).toEqual(original);
    const merged = { entries: entries.map((entry) => ({ ...entry, criteria: { ...entry.criteria, ...rows.find((row: { path: string }) => row.path === entry.path).criteria } })) };
    const scratch = mkdtempSync(join(tmpdir(), 'expose-rubric-merge-'));
    try {
      mkdirSync(join(scratch, 'release/public/docs'), { recursive: true });
      for (const name of ['one', 'two', 'three']) writeFileSync(join(scratch, path(name)), readFileSync(join(root, path(name))));
      writeFileSync(join(scratch, 'release/public/expose-rubric.yaml'), stringify(merged));
      expect(checkExposeRubric(scratch).missing).toEqual([]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    expect(readFileSync(ledger)).toEqual(original);
    expect(() => run(['--yaml-patch', ledger, '--files', path('one')], root, help)).toThrow('원장 파일은 덮어쓸 수 없습니다');
    expect(readFileSync(ledger)).toEqual(original);
  });

  test('--yaml-patch 하드 링크 경로는 원장을 덮어쓰지 않고 거부한다', () => {
    const alias = join(root, 'ledger-hardlink.yaml');
    linkSync(ledger, alias);
    try {
      expect(() => run(['--yaml-patch', alias, '--files', path('one')], root, help))
        .toThrow('원장 파일은 덮어쓸 수 없습니다');
      expect(readFileSync(ledger)).toEqual(original);
      expect(readFileSync(alias)).toEqual(original);
    } finally { rmSync(alias); }
  });

  test('import.meta.main CLI 는 파일 선택 JSON만 출력하고 원장 바이트를 보존한다', () => {
    const script = join(import.meta.dir, 'expose-rubric-suggest.ts');
    const result = spawnSync('bun', [script, '--json', '--files', path('three')], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(path('three'));
    expect(rows[0].criteria.brand).toEqual({ status: 'fail', reason: '브랜드 규칙: B7' });
    expect(readFileSync(ledger)).toEqual(original);
  }, 60_000);

  test('실제 CLI --help 로 있는 elanous 명령은 pass, 없는 명령은 fail 로 측정한다', () => {
    const script = join(import.meta.dir, 'expose-rubric-suggest.ts');
    const missing = join(docs, 'live-missing.md');
    writeFileSync(missing, '# Missing command\n`elanous nonexistentrubriccommand`\n');
    try {
      const result = spawnSync('bun', [script, '--json', '--files', path('one'), path('live-missing')], {
        cwd: root, encoding: 'utf8', timeout: 120_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout);
      expect(rows).toHaveLength(2);
      expect(rows.find((row: { path: string }) => row.path === path('one')).criteria.reproducible)
        .toEqual({ status: 'pass', reason: '명령 1개 모두 --help 에 있음' });
      expect(rows.find((row: { path: string }) => row.path === path('live-missing')).criteria.reproducible)
        .toEqual({ status: 'fail', reason: '없는 명령: elanous nonexistentrubriccommand' });
      expect(readFileSync(ledger)).toEqual(original);
    } finally { rmSync(missing); }
  }, 60_000);

  test('기본 출력에 한 줄씩·합계·사람 판정 표시, JSON은 요구된 배열만 출력', () => {
    const lines: string[] = [];
    const print = console.log;
    try {
      console.log = (...args) => { lines.push(args.join(' ')); };
      expect(run(['--files', path('one'), path('two')], root, help)).toBe(0);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('reproducible pass · confidential pass · brand pass');
      expect(lines[1]).toContain('reproducible fail(elanous doctor missing)');
      expect(lines[2]).toContain('maturity/value/evidence/support 사람 판정 (MK)');
      lines.length = 0;
      expect(run(['--json', '--files', path('one')], root, help)).toBe(0);
      expect(JSON.parse(lines[0]!)).toEqual(suggestExposeRubric(root, [path('one')], help));
    } finally { console.log = print; }
    expect(readFileSync(ledger)).toEqual(original);
  });
});
