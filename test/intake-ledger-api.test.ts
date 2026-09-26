import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIntakeLedgerGet, handleIntakeLedgerPost } from '../src/nexus/api/intake-ledger-api.js';
import { intakeLedgerDir, markIntakeItem } from '../src/intake-plane/items.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const deps = () => { const r = mkdtempSync(join(tmpdir(), 'intake-ledger-api-')); roots.push(r); return { root: () => r, now: () => '2026-09-26T13:00:00.000Z', r }; };
const post = (body: unknown) => new Request('http://x/v1/intake-ledger/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('URL·글을 원장에 넣고 id 를 돌려준다 · 입력원은 pwa · user-private', async () => {
  const d = deps();
  const res = await handleIntakeLedgerPost(post({ items: [{ url: 'https://youtu.be/aaaaaaaaaaa' }, { text: '내 메모 한 줄' }], source: 'youtube' }), d);
  expect(res.status).toBe(200);
  const j = await res.json() as { ids: string[]; added: number };
  expect(j.added).toBe(2);
  expect(j.ids).toHaveLength(2);
  const got = await handleIntakeLedgerGet(j.ids[0]!, d).json() as Record<string, unknown>;
  expect(got).toMatchObject({ status: 'new', sources: ['pwa'], privacy: 'user-private', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
});

test('⛔ 추적 응답에 원문(text)을 싣지 않는다', async () => {
  const d = deps();
  const { ids } = await (await handleIntakeLedgerPost(post({ items: [{ text: '비밀 메모 문장' }] }), d)).json() as { ids: string[] };
  const body = await handleIntakeLedgerGet(ids[0]!, d).text();
  expect(body.includes('비밀 메모 문장')).toBe(false);
  expect(readFileSync(join(intakeLedgerDir(d.r), 'items.jsonl'), 'utf8')).toContain('비밀 메모 문장');   // 원장에는 남는다
});

test('추적은 흡수 뒤 노트 산출을 보인다', async () => {
  const d = deps();
  const { ids } = await (await handleIntakeLedgerPost(post({ items: [{ url: 'https://github.com/a/b' }] }), d)).json() as { ids: string[] };
  markIntakeItem(d.r, ids[0]!, { status: 'absorbed', output: { kind: 'note', ref: '/v/n.md' } }, '2026-09-26T14:00:00.000Z');
  expect(await handleIntakeLedgerGet(ids[0]!, d).json()).toMatchObject({ status: 'absorbed', outputs: [{ kind: 'note', ref: '/v/n.md' }] });
});

test('잘못된 입력은 400 이고 원장을 안 만든다 · 없는 id 404 · 모양 밖 id 400', async () => {
  const d = deps();
  for (const b of [{}, { items: [] }, { items: [{ url: 'ftp://x' }] }, { items: [{}] }, { items: Array(51).fill({ text: 'x' }) }]) {
    expect((await handleIntakeLedgerPost(post(b), d)).status).toBe(400);
  }
  expect((await handleIntakeLedgerPost(new Request('http://x', { method: 'POST', body: '{' }), d)).status).toBe(400);
  expect(() => readFileSync(join(intakeLedgerDir(d.r), 'items.jsonl'))).toThrow();
  expect(handleIntakeLedgerGet('0123456789abcdef', d).status).toBe(404);
  expect(handleIntakeLedgerGet('../etc', d).status).toBe(400);
});
