import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { countSource, emptyCounts, failureMessage, growth, kindOfLine, readBaseline, runPolicyConstantsGate, scanRepo, shrink } from './policy-constants';

test('the repo adds no new policy-shaped constant in src/', () => {
  expect(growth(scanRepo(), readBaseline())).toEqual([]);
});

test('threshold: a knob-named UPPER const holding a number expression (or env numeric fallback, or a one-line knob table)', () => {
  expect(kindOfLine('export const REVIEW_TIMEOUT_MS = 30_000;')).toBe('threshold');
  expect(kindOfLine('const BULLETIN_STALE_MIN = 45;')).toBe('threshold');
  expect(kindOfLine('export const MAX_ASSIGN_PER_PLAN = 8;')).toBe('threshold');
  expect(kindOfLine('const LOOKBACK_MIN = 24 * 60;')).toBe('threshold');
  expect(kindOfLine('const STALL_MS = 30 * MINUTE_MS;')).toBe('threshold');
  expect(kindOfLine('const POLL_INTERVAL_MS: number = Number(process.env.X_POLL) || 5000;')).toBe('threshold');
  expect(kindOfLine('export const BACKPRESSURE_DEFAULTS = { maxPendingPassive: 30, maxTurnsPerHour: 20 } as const;')).toBe('threshold');
});

test('place: a host / absolute-path literal in a HOST · DIR · PATH const', () => {
  expect(kindOfLine("export const REVIEW_HOSTS = ['node-b', 'node-c'] as const;")).toBe('place');
  expect(kindOfLine("const SEAT_STATE_DIR = '/Users/someone/elanous-hq/seat-state';")).toBe('place');
  expect(kindOfLine("const LEDGER_FILE = '~/x/ledger.tsv';")).toBe('place');
  expect(kindOfLine("const POLICY_PATH = join(root, 'graphs', 'policies', 'x.yaml');")).toBeNull();
});

test('not policy: unit conversions · protocol prefixes · `// not-policy: <reason>` · comments · non-numeric values', () => {
  expect(kindOfLine('const MINUTE_MS = 60_000;')).toBeNull();
  expect(kindOfLine('const MS_PER_DAY = 86_400_000;')).toBeNull();
  expect(kindOfLine('const HTTP_TIMEOUT_STATUS = 408;')).toBeNull();
  expect(kindOfLine('const FRAME_MAX = 65_535; // not-policy: WebSocket frame size (RFC 6455)')).toBeNull();
  expect(kindOfLine('const FRAME_MAX = 65_535; // not-policy:')).toBe('threshold');
  expect(kindOfLine('// const REVIEW_TIMEOUT_MS = 30_000;')).toBeNull();
  expect(kindOfLine("const TIMEOUT_LABEL = 'timeout';")).toBeNull();
  expect(kindOfLine('const MAX_ITEMS = (n: number) => n;')).toBeNull();
  expect(kindOfLine('const timeoutMs = pack.review.timeout_ms;')).toBeNull();
});

test('pregate: a synthetic new TS threshold constant → RED with where to move it · the same value in a policy pack → GREEN', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-constants-'));
  const gate = (changed?: string[]) => {
    const log: string[] = [];
    const rc = runPolicyConstantsGate({ cwd: root, args: changed ? ['--changed-files', ...changed] : [], log: (m) => log.push(m), error: (m) => log.push(m) });
    return { rc, text: log.join('\n') };
  };
  try {
    mkdirSync(join(root, 'src', 'feature'), { recursive: true });
    mkdirSync(join(root, 'graphs', 'policies'), { recursive: true });
    mkdirSync(join(root, 'scripts', 'ratchets'), { recursive: true });
    const file = join(root, 'src', 'feature', 'review-wait.ts');
    writeFileSync(join(root, 'src', 'feature', 'old.ts'), `export const OLD_CAP = 3;\n`);
    // a tree without the baseline file (older branch · fixture) is not measured
    expect(gate().rc).toBe(0);
    expect(gate().text).toBe('');
    const base = shrink(scanRepo(root), emptyCounts(), true); // today's baseline: old.ts only
    writeFileSync(join(root, 'scripts', 'ratchets', 'policy-constants.baseline.json'), `${JSON.stringify(base)}\n`);
    expect(gate()).toEqual({ rc: 0, text: '[policy-constants-gate] PASS no new policy-shaped constant in src/' });

    // RED — a new file adds a TS policy constant
    writeFileSync(file, `export const REVIEW_WAIT_TIMEOUT_MS = 30_000;\nexport const waitMs = () => REVIEW_WAIT_TIMEOUT_MS;\n`);
    expect(growth(scanRepo(root), base)).toEqual(['src/feature/review-wait.ts: threshold 1 > 0']);
    const red = gate(['src/feature/review-wait.ts']);
    expect(red.rc).toBe(1);
    expect(red.text).toContain('src/feature/review-wait.ts: threshold 1 > 0');
    expect(red.text).toContain('src/feature/review-wait.ts:1: export const REVIEW_WAIT_TIMEOUT_MS = 30_000;');
    expect(red.text).toContain('graphs/policies/<area>.yaml');
    expect(red.text).toContain('agent.yaml `policies:`');
    expect(red.text).toContain('plugin.json');
    expect(red.text).toContain('// not-policy: <reason>');
    // growth in a file this PR did not touch (a drifted main) does not block it
    expect(gate(['src/feature/other.ts']).rc).toBe(0);

    // GREEN — the value moves to a policy pack and the TS reads it by name
    // 출처: R-REV17 — the synthetic policy pack's value (fixture data, not a test bound)
    writeFileSync(join(root, 'graphs', 'policies', 'review-wait.yaml'), `version: 1\nreview_wait:\n  # why: one terra review round on a medium PR\n  timeout_ms: 30000\n`);
    writeFileSync(file, `import { readFileSync } from 'node:fs';\nimport { parse } from 'yaml';\nconst pack = parse(readFileSync('graphs/policies/review-wait.yaml', 'utf8'));\nexport const waitMs = () => pack.review_wait.timeout_ms as number;\n`);
    expect(gate(['src/feature/review-wait.ts', 'graphs/policies/review-wait.yaml']).rc).toBe(0);
    expect(parse(readFileSync(join(root, 'graphs', 'policies', 'review-wait.yaml'), 'utf8')).review_wait.timeout_ms).toBe(30_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the RED message names the file, its matching lines and every YAML home', () => {
  const msg = failureMessage(['src/a.ts: threshold 2 > 1'], () => ['3: const A_MAX = 1;', '4: const B_TTL_MS = 2;']);
  expect(msg.split('\n').slice(0, 4)).toEqual([
    'policy-constants ratchet: 1 file(s) gained a policy-shaped constant in src/',
    'src/a.ts: threshold 2 > 1',
    '    src/a.ts:3: const A_MAX = 1;',
    '    src/a.ts:4: const B_TTL_MS = 2;',
  ]);
});

test('growth is per file and kind · --update only shrinks (a migrated file drops out)', () => {
  const base = countSource('src/x.ts', 'const A_MAX = 1;\n');
  expect(growth(countSource('src/x.ts', 'const A_MAX = 1;\nconst B_TTL_MS = 2;\n'), base)).toEqual(['src/x.ts: threshold 2 > 1']);
  expect(growth(base, base)).toEqual([]);
  const now = { ...emptyCounts(), threshold: { 'src/a.ts': 5 } };
  expect(shrink(now, { ...emptyCounts(), threshold: { 'src/a.ts': 3, 'src/b.ts': 1 } }).threshold).toEqual({ 'src/a.ts': 3 });
  expect(shrink({ ...emptyCounts(), threshold: { 'src/new.ts': 2 } }, emptyCounts()).threshold).toEqual({});
});
