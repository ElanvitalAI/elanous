import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompletionEvidence } from './completion-evidence.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { openSchedulesDb } from '../domains/schedule-registry.js';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'completion-evidence-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function schedule(db: Database, id: string, status: string | null) {
  db.run(`INSERT INTO schedule_registry (id, name, source, category, last_status) VALUES (?, 'brief', 'test', 'report', ?)`, [id, status]);
}

describe('completion evidence (read-only, temporary root)', () => {
  test('deliverable: output path must point to a nonempty file within the task directory', () => {
    const dir = temp();
    const output = join(dir, 'output.txt');
    const input = { dir, ref: 'output.txt', receipt: true };
    expect(checkCompletionEvidence('deliverable', input).missing).toContain('산출물 파일');
    writeFileSync(output, '');
    expect(checkCompletionEvidence('deliverable', input).missing).toContain('산출물 파일');
    writeFileSync(output, 'delivered');
    expect(checkCompletionEvidence('deliverable', input)).toEqual({ ok: true, ref: 'output.txt', missing: [] });
    expect(checkCompletionEvidence('deliverable', { dir, ref: '../output.txt', receipt: true }).missing).toContain('못 쟀다: 경로');
    const outside = temp();
    writeFileSync(join(outside, 'outside.txt'), 'outside');
    symlinkSync(join(outside, 'outside.txt'), join(dir, 'link.txt'));
    expect(checkCompletionEvidence('deliverable', { dir, ref: 'link.txt', receipt: true }).missing).toContain('못 쟀다: 경로');
  });

  test('deliverable: a valid http(s) link can identify the output without a local file', () => {
    const dir = temp();
    expect(checkCompletionEvidence('deliverable', { dir, ref: 'https://example.org/output', receipt: true }))
      .toEqual({ ok: true, ref: 'https://example.org/output', missing: [] });
    expect(checkCompletionEvidence('deliverable', { dir, ref: 'https://', receipt: true }).ok).toBe(false);
    expect(checkCompletionEvidence('deliverable', { dir, ref: 'ftp://example.org/output', receipt: true }).missing).toContain('산출물 경로 또는 링크');
  });

  test('deliverable: receipt confirmation is required even with a valid output', () => {
    const dir = temp();
    writeFileSync(join(dir, 'output.txt'), 'delivered');
    const input = { dir, ref: 'output.txt' };
    expect(checkCompletionEvidence('deliverable', input)).toEqual({ ok: false, ref: 'output.txt', missing: ['수신 확인'] });
    expect(checkCompletionEvidence('deliverable', { ...input, receipt: false }).missing).toContain('수신 확인');
    expect(checkCompletionEvidence('deliverable', { ...input, receipt: true }))
      .toEqual({ ok: true, ref: 'output.txt', missing: [] });
  });

  test('research-report: md, two distinct http(s) sources, counter-evidence heading', () => {
    const dir = temp();
    const path = join(dir, 'report.md');
    writeFileSync(path, '# 조사\n인용 https://a.example/path\n인용 http://b.example/x\n## 반대 근거\n반론\n');
    expect(checkCompletionEvidence('research-report', { dir, ref: 'report.md' })).toEqual({ ok: true, ref: 'report.md', missing: [] });
    writeFileSync(path, '# 조사\n인용 https://a.example/path\n## 반대 근거\n');
    expect(checkCompletionEvidence('research-report', { dir, ref: 'report.md' })).toMatchObject({ ok: false, missing: ['출처'] });
    writeFileSync(path, '# 조사\nhttps://a.example/path https://b.example/x');
    expect(checkCompletionEvidence('research-report', { dir, ref: 'report.md' }).missing).toContain('반대 근거');
  });

  test('artifact/content: nonempty file and same-stem preview or markdown title', () => {
    const dir = temp();
    writeFileSync(join(dir, 'output.txt'), '');
    expect(checkCompletionEvidence('artifact', { dir, ref: 'output.txt' }).missing).toContain('파일 크기');
    writeFileSync(join(dir, 'output.txt'), 'body');
    for (const ext of ['.png', '.pdf', '.html']) {
      writeFileSync(join(dir, `output${ext}`), 'preview');
      expect(checkCompletionEvidence('artifact', { dir, ref: 'output.txt' }).ok).toBe(true);
      rmSync(join(dir, `output${ext}`));
    }
    expect(checkCompletionEvidence('artifact', { dir, ref: 'output.txt' }).missing).toContain('미리보기');
    writeFileSync(join(dir, 'draft.md'), '# Title\nBody');
    expect(checkCompletionEvidence('content', { dir, ref: 'draft.md' }).ok).toBe(true);
    writeFileSync(join(dir, 'lonely.png'), 'image');
    expect(checkCompletionEvidence('artifact', { dir, ref: 'lonely.png' }).missing).toContain('미리보기');
  });

  test('ops-action: execution and readback must share the requested id', () => {
    const dir = temp();
    const log = join(dir, 'execution.jsonl');
    writeFileSync(log, JSON.stringify({ id: 'act-1', type: 'execution' }) + '\n');
    expect(checkCompletionEvidence('ops-action', { dir, ref: 'act-1' })).toMatchObject({ ok: false, missing: ['되읽기'] });
    writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ id: 'other', type: 'readback' }) + '\n');
    expect(checkCompletionEvidence('ops-action', { dir, ref: 'act-1' }).missing).toContain('되읽기');
    writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ id: 'act-1', type: 'readback' }) + '\n');
    expect(checkCompletionEvidence('ops-action', { dir, ref: 'act-1' }).ok).toBe(true);
  });

  test('watch-brief: registered schedule and last status ok without DB writes', () => {
    const dir = temp();
    const db = openSchedulesDb(join(dir, 'schedules.db'));
    try {
      const input = { dir, ref: 'brief-1' };
      expect(checkCompletionEvidence('watch-brief', input, { schedulesDb: db }).missing).toContain('일정');
      schedule(db, 'brief-1', null);
      expect(checkCompletionEvidence('watch-brief', input, { schedulesDb: db }).missing).toContain('도착');
      db.run("UPDATE schedule_registry SET last_status = 'ok' WHERE id = 'brief-1'");
      const changes = db.query('SELECT total_changes() AS count').get() as { count: number };
      expect(checkCompletionEvidence('watch-brief', input, { schedulesDb: db })).toEqual({ ok: true, ref: 'brief-1', missing: [] });
      expect(db.query('SELECT total_changes() AS count').get()).toEqual(changes);
    } finally { db.close(); }
  });

  test('decision-support: injected DecisionLedger reads all statuses without writing', () => {
    const dir = temp();
    const ledger = new DecisionLedger({ stateDir: dir, resolveVersion: () => ({ released: null, dev: null, codename: null }) });
    const entry = ledger.raise({ title: '결정 카드', category: 'other', scqa: { s: '상황', c: '복잡' }, options: [{ key: 'a', label: 'A', consequence: 'A' }, { key: 'b', label: 'B', consequence: 'B' }], recommendation: { option: 'a', why: '근거' }, raisedBy: { agent: 'test' } });
    const before = readFileSync(ledger.path, 'utf8');
    expect(checkCompletionEvidence('decision-support', { dir, ref: entry.id }, { ledger })).toEqual({ ok: true, ref: entry.id, missing: [] });
    expect(checkCompletionEvidence('decision-support', { dir, ref: 'unknown' }, { ledger }).missing).toContain('결정 기록');
    expect(readFileSync(ledger.path, 'utf8')).toBe(before);
  });

  test('missing evidence differs from unreadable evidence', () => {
    const dir = temp();
    expect(checkCompletionEvidence('research-report', { dir, ref: 'absent.md' }).missing).toContain('파일');
    expect(checkCompletionEvidence('watch-brief', { dir, ref: 'x' }).missing).toContain('못 쟀다: 스케줄 DB');
    expect(checkCompletionEvidence('decision-support', { dir, ref: 'x' }, { ledger: { list: () => { throw Error('unreadable'); } } }).missing).toContain('못 쟀다: 결정 원장 읽기');
    const db = new Database(':memory:');
    try { expect(checkCompletionEvidence('watch-brief', { dir, ref: 'x' }, { schedulesDb: db }).missing).toContain('못 쟀다: 스케줄 DB 읽기'); }
    finally { db.close(); }
    writeFileSync(join(dir, 'bad.md'), '# report');
    expect(checkCompletionEvidence('research-report', { dir, ref: '../bad.md' }).missing).toContain('못 쟀다: 경로');
    writeFileSync(join(dir, 'execution.jsonl'), '{bad json}\n');
    expect(checkCompletionEvidence('ops-action', { dir, ref: 'x' }).missing).toContain('못 쟀다: 실행 기록 해석');
    const broken = new DecisionLedger({ stateDir: dir });
    mkdirSync(join(dir, 'decisions'), { recursive: true });
    writeFileSync(broken.path, '{bad json}\n');
    expect(checkCompletionEvidence('decision-support', { dir, ref: 'D-1' }, { ledger: broken }).missing).toContain('못 쟀다: 결정 원장 읽기');
  });
});
