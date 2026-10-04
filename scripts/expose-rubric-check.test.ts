import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify, parse } from 'yaml';
import { checkExposeRubric } from './expose-rubric-check.js';
import { loadExportConfig, selectExportFiles } from './public-export.js';

const repo = resolve(import.meta.dir, '..');
const script = join(repo, 'scripts/expose-rubric-check.ts');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'expose-rubric-')));
const docs = join(root, 'release/public/docs');
mkdirSync(docs, { recursive: true });
for (const name of ['one.md', 'two.md', 'three.md']) writeFileSync(join(docs, name), `# ${name}\n`);
const criterion = () => ({ status: 'pass', reason: '확인함' });
const criteria = () => Object.fromEntries(['maturity', 'value', 'reproducible', 'evidence', 'confidential', 'brand', 'support'].map((key) => [key, criterion()]));
const entry = (name: string, verdict: string) => ({ path: `release/public/docs/${name}`, verdict, criteria: criteria(), judge: 'MK', at: new Date().toISOString() });
const one = entry('one.md', 'beta');
const two = entry('two.md', 'public');
two.criteria.confidential = { status: 'fail', reason: '초기 적재 — 재심 필요; 비밀 노출 확인' };
writeFileSync(join(root, 'release/public/expose-rubric.yaml'), stringify({ entries: [one, two] }));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = (args: string[]) => spawnSync('bun', [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_CONFIG_DIR: join(root, 'config'), ELANOUS_STATE_DIR: join(root, 'state') } });

describe('expose-rubric-check', () => {
  test('원장 없음 1 · public 인데 fail 1 을 stderr 경고로 내고 기본 exit 0, strict exit 1', () => {
    const normal = run([]);
    expect(normal.status).toBe(0);
    expect(normal.stderr).toContain('경고: 원장 없음: release/public/docs/three.md');
    expect(normal.stderr).toContain('경고: public 인데 fail (confidential): release/public/docs/two.md');
    expect(normal.stderr).toContain('경고: public 기술 정확성 TC 미검토: release/public/docs/two.md');
    expect(normal.stderr).toContain('missing=1 orphan=0 failing=1 internal=0 unreviewed=1');
    expect(run(['--strict']).status).toBe(1);
    const json = run(['--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ docs: 3, missing: ['release/public/docs/three.md'], orphan: [], failing: [{ path: 'release/public/docs/two.md', criteria: ['confidential'] }], internal: [], unreviewed: ['release/public/docs/two.md'], unjudged: [] });
  });

  test('--files 는 선택된 등록 문서만 보고 누락·fail 을 세지 않는다', () => {
    const chosen = run(['--strict', '--files', join(docs, 'one.md')]);
    expect(chosen.status).toBe(0);
    expect(chosen.stderr).toContain('missing=0 orphan=0 failing=0 internal=0 unreviewed=0');
    expect(chosen.stderr).not.toContain('경고:');
    expect(JSON.parse(run(['--json', '--files', 'release/public/docs/one.md']).stdout)).toEqual({ docs: 1, missing: [], orphan: [], failing: [], internal: [], unreviewed: [], unjudged: [] });
  });

  test('기술 검토 기록이 없는 public 만 경고하고 TC 기록이 있으면 경고하지 않는다', () => {
    const ledger = join(root, 'release/public/expose-rubric.yaml');
    const original = readFileSync(ledger, 'utf8');
    try {
      const data = parse(original);
      data.entries[1].techReview = 'TC';
      writeFileSync(ledger, stringify(data));
      const reviewed = run(['--json', '--files', 'release/public/docs/two.md']);
      expect(JSON.parse(reviewed.stdout).unreviewed).toEqual([]);
      data.entries[1].techReview = 'MK';
      writeFileSync(ledger, stringify(data));
      const wrongSeat = run(['--json', '--files', 'release/public/docs/two.md']);
      expect(JSON.parse(wrongSeat.stdout).unreviewed).toEqual(['release/public/docs/two.md']);
      delete data.entries[1].techReview;
      writeFileSync(ledger, stringify(data));
      const unreviewed = run(['--files', 'release/public/docs/two.md']);
      expect(unreviewed.status).toBe(0);
      expect(unreviewed.stderr).toContain('경고: public 기술 정확성 TC 미검토: release/public/docs/two.md');
      data.entries[1].criteria.confidential = criterion();
      writeFileSync(ledger, stringify(data));
      const onlyUnreviewed = run(['--strict', '--files', 'release/public/docs/two.md']);
      expect(onlyUnreviewed.status).toBe(0);
      expect(onlyUnreviewed.stderr).toContain('경고: public 기술 정확성 TC 미검토: release/public/docs/two.md');
    } finally { writeFileSync(ledger, original); }
  });

  test('파일 없는 항목과 public fail 을 구별하고 beta 지원 실패는 경고하지 않는다', () => {
    const ledger = join(root, 'release/public/expose-rubric.yaml');
    const original = readFileSync(ledger, 'utf8');
    try {
      const data = parse(original);
      data.entries.push(entry('gone.md', 'internal'));
      data.entries[0].criteria.support = { status: 'fail', reason: '지원 안 됨' };
      writeFileSync(ledger, stringify(data));
      expect(checkExposeRubric(root).orphan).toEqual(['release/public/docs/gone.md']);
      expect(checkExposeRubric(root).failing).toEqual([{ path: 'release/public/docs/two.md', criteria: ['confidential'] }]);
      const scoped = run(['--strict', '--json', '--files', 'release/public/docs/gone.md', 'release/public/docs/two.md']);
      expect(scoped.status).toBe(1);
      expect(JSON.parse(scoped.stdout)).toEqual({ docs: 1, missing: [], orphan: ['release/public/docs/gone.md'], failing: [{ path: 'release/public/docs/two.md', criteria: ['confidential'] }], internal: [], unreviewed: ['release/public/docs/two.md'], unjudged: [] });
    } finally { writeFileSync(ledger, original); }
  });

  test('beta 기밀 실패는 공개 노출 경고 · strict 실패 · 선택 범위와 JSON에 포함', () => {
    const ledger = join(root, 'release/public/expose-rubric.yaml');
    const original = readFileSync(ledger, 'utf8');
    try {
      const data = parse(original);
      data.entries[0].criteria.confidential = { status: 'fail', reason: '외부 비밀 노출' };
      writeFileSync(ledger, stringify(data));
      const selected = run(['--files', 'release/public/docs/one.md']);
      expect(selected.status).toBe(0);
      expect(selected.stderr).toContain('경고: beta 인데 fail (confidential): release/public/docs/one.md');
      expect(selected.stderr).toContain('missing=0 orphan=0 failing=1 internal=0');
      expect(run(['--strict', '--files', 'release/public/docs/one.md']).status).toBe(1);
      expect(JSON.parse(run(['--json', '--files', 'release/public/docs/one.md']).stdout)).toEqual({ docs: 1, missing: [], orphan: [], failing: [{ path: 'release/public/docs/one.md', criteria: ['confidential'], verdict: 'beta' }], internal: [], unreviewed: [], unjudged: [] });
    } finally { writeFileSync(ledger, original); }
  });

  test('공개 경로에 둔 internal 판정은 경고 · strict 실패 · 선택 범위와 JSON에 포함', () => {
    const ledger = join(root, 'release/public/expose-rubric.yaml');
    const original = readFileSync(ledger, 'utf8');
    try {
      const data = parse(original);
      data.entries[0].verdict = 'internal';
      writeFileSync(ledger, stringify(data));
      const selected = run(['--files', 'release/public/docs/one.md']);
      expect(selected.status).toBe(0);
      expect(selected.stderr).toContain('경고: internal 인데 공개 경로: release/public/docs/one.md');
      expect(selected.stderr).toContain('missing=0 orphan=0 failing=0 internal=1');
      expect(run(['--strict', '--files', 'release/public/docs/one.md']).status).toBe(1);
      expect(JSON.parse(run(['--json', '--files', 'release/public/docs/one.md']).stdout)).toEqual({ docs: 1, missing: [], orphan: [], failing: [], internal: ['release/public/docs/one.md'], unreviewed: [], unjudged: [] });
      expect(run(['--json', '--files', 'release/public/docs/two.md']).stdout).not.toContain('one.md');
    } finally { writeFileSync(ledger, original); }
  });

  test('실물 원장 — 모든 공개 문서가 원장에 있고 기계 측정 세 기준이 채워져 미판정 0 · 재현성 fail 문서는 strict 실패 · export include 밖', () => {
    const actual = runReal();
    const ledger = parse(readFileSync(join(repo, 'release/public/expose-rubric.yaml'), 'utf8'));
    expect(ledger.entries.length).toBe(readdirSync(join(repo, 'release/public/docs')).filter((f) => f.endsWith('.md')).length);
    expect(actual.stderr).toContain('missing=0 orphan=0');
    expect(actual.stderr).toContain('unjudged=0');
    const failing = ledger.entries.filter((item: any) => item.verdict === 'public' && Object.values(item.criteria).some((c: any) => c.status === 'fail'));
    expect(actual.status).toBe(failing.length ? 1 : 0);
    for (const item of ledger.entries) {
      expect(item.judge).toBe('MK');
      expect(Object.keys(item.criteria).sort()).toEqual(['brand', 'confidential', 'evidence', 'maturity', 'reproducible', 'support', 'value']);
      // Human criteria stay unjudged until MK reviews them; machine criteria carry their measurement.
      for (const key of ['maturity', 'value', 'evidence', 'support']) expect(item.criteria[key].status).toBe('n/a');
      expect(['pass', 'fail']).toContain(item.criteria.confidential.status);
    }
    const config = loadExportConfig(repo);
    const rubricPath = 'release/public/expose-rubric.yaml';
    expect(selectExportFiles([rubricPath], config)).toEqual([]);
    expect(Object.values(config.replace)).not.toContain(rubricPath);
  });

  test('미판정(일곱 기준 pass 0) public·beta 는 경고 · strict 실패 · pass 하나면 판정으로 본다', () => {
    const ledger = join(root, 'release/public/expose-rubric.yaml');
    const original = readFileSync(ledger, 'utf8');
    try {
      const data = parse(original);
      const unchecked = { status: 'n/a', reason: '초기 적재 — 재심 필요; 미확인' };
      for (const key of Object.keys(data.entries[0].criteria)) data.entries[0].criteria[key] = { ...unchecked };
      writeFileSync(ledger, stringify(data));
      const selected = run(['--files', 'release/public/docs/one.md']);
      expect(selected.status).toBe(0);
      expect(selected.stderr).toContain('경고: 미판정(일곱 기준 중 pass 0): release/public/docs/one.md');
      expect(run(['--strict', '--files', 'release/public/docs/one.md']).status).toBe(1);
      data.entries[0].criteria.maturity = { status: 'pass', reason: '운영 판에서 실물 확인' };
      writeFileSync(ledger, stringify(data));
      expect(JSON.parse(run(['--json', '--files', 'release/public/docs/one.md']).stdout).unjudged).toEqual([]);
    } finally { writeFileSync(ledger, original); }
  });

  test('판정자가 MK 가 아니면 원장 항목이 무효다', () => {
    const ledger = join(root, 'release/public/expose-rubric.yaml');
    const original = readFileSync(ledger, 'utf8');
    try {
      const data = parse(original);
      data.entries[0].judge = 'TC';
      writeFileSync(ledger, stringify(data));
      expect(() => checkExposeRubric(root)).toThrow('invalid or duplicate ledger entry');
      expect(run(['--strict']).status).toBe(2);
    } finally { writeFileSync(ledger, original); }
  });
});

function runReal() {
  return spawnSync('bun', [script, '--strict'], { cwd: repo, encoding: 'utf8' });
}
