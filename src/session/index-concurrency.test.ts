// 여러 프로세스가 같은 세션 저장소를 동시에 쓴다 — 목록에서 남의 세션이 사라지거나 임시 파일 이름이 부딪히면 안 된다(10-01 `ask` 동시 실행).
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSession, deleteSession, listSessions, loadSession } from './index.js';

const moduleUrl = resolve(import.meta.dir, 'index.ts');

function worker(root: string, n: number): Promise<{ code: number | null; stderr: string }> {
  const script = `
    const { createSession, appendMessage } = await import(${JSON.stringify(moduleUrl)});
    for (let i = 0; i < 5; i++) {
      const meta = createSession({ title: 'w${n}-' + i }, ${JSON.stringify(root)});
      appendMessage(meta.id, { role: 'user', content: 'hello ${n} ' + i, ts: new Date().toISOString() }, ${JSON.stringify(root)});
    }`;
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (code) => done({ code, stderr }));
  });
}

test('four processes creating and appending at once keep every session in the index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-concurrency-'));
  try {
    const results = await Promise.all([0, 1, 2, 3].map((n) => worker(root, n)));
    for (const r of results) expect(r.stderr, r.stderr).toBe('');
    for (const r of results) expect(r.code).toBe(0);
    const titles = listSessions({}, root).map((m) => m.title).sort();
    expect(titles).toHaveLength(20);
    for (const n of [0, 1, 2, 3]) for (let i = 0; i < 5; i++) expect(titles).toContain(`w${n}-${i}`);
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('a deleted session does not come back when a later write merges the index', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-delete-merge-'));
  try {
    const a = createSession({ title: 'a' }, root);
    const b = createSession({ title: 'b' }, root);
    expect(deleteSession(a.id, root)).toBe(true);
    createSession({ title: 'c' }, root);
    const ids = listSessions({}, root).map((m) => m.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function appender(root: string, id: string, n: number, count: number): Promise<{ code: number | null; stderr: string }> {
  const script = `
    const { appendMessage } = await import(${JSON.stringify(moduleUrl)});
    for (let i = 0; i < ${count}; i++) {
      appendMessage(${JSON.stringify(id)}, { role: 'user', content: 'p${n} ' + i, ts: new Date().toISOString() }, ${JSON.stringify(root)});
    }`;
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (code) => done({ code, stderr }));
  });
}

function assigner(root: string, id: string): Promise<{ code: number | null; stderr: string }> {
  const script = `
    const { updateSessionMeta } = await import(${JSON.stringify(moduleUrl)});
    for (let i = 0; i < 25; i++) {
      updateSessionMeta(${JSON.stringify(id)}, (m) => { m.projectId = 'proj-a'; }, ${JSON.stringify(root)});
      await new Promise((r) => setTimeout(r, 2));
    }`;
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('exit', (code) => done({ code, stderr }));
  });
}

// IA1b: appendMessage 가 잠금 밖에서 읽은 목록을 쓰면 다른 프로세스의 messageCount·projectId 갱신을 옛 값으로 덮었다.
test('100 appends to one session from four processes lose no count, and a concurrent project assignment survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-append-race-'));
  try {
    const session = createSession({ title: 'shared' }, root);
    const results = await Promise.all([
      ...[0, 1, 2, 3].map((n) => appender(root, session.id, n, 25)),
      assigner(root, session.id),
    ]);
    for (const r of results) expect(r.stderr, r.stderr).toBe('');
    for (const r of results) expect(r.code).toBe(0);
    const loaded = loadSession(session.id, root)!;
    expect(loaded.messages).toHaveLength(100);
    expect(loaded.meta.messageCount).toBe(100);
    expect(loaded.meta.projectId).toBe('proj-a');
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
