import { afterEach, expect, test } from 'bun:test';
import { buildSharedAppTools } from '../agent/shared-app-tools.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { listChecklist } from '../release-loop/checklist.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { getSchedule } from '../release-loop/release-schedule.js';
import { history } from '../release-loop/feature-store.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { assertGradableItems, classifyRouting, selectCorpusItems, unavailableExpectedToolIds } from '../../scripts/lib/nl-routing-measurement.js';
import { isEvalPromptToolSurface } from '../eval-prompt-cli.js';
import { buildCoreTools } from './core-tools.js';
import { formatElanousCard, parseElanousCard } from './elanous-card.js';
import { dispatchReleaseChange, dispatchReleaseStatus, RELEASE_CHANGE_SPEC, RELEASE_STATUS_SPEC } from './release-tool.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetElanousConfigDir();
  delete process.env.ELANOUS_STATE_DIR;
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'release-chat-'));
  dirs.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  return root;
};
const originChannel = { name: 'terminal', request: async () => true, cancel: () => {} };
const human: ToolRuntimeContext = { surface: 'tui', sessionId: 'human-session', verifiedOwner: { id: 'owner' }, confirmChannels: [originChannel] };
const confirm = (answer: boolean, channel = 'terminal') => async () => ({ answer, channel, elapsedMs: 0 });

test('status returns KST schedule, counts, red identities, yellow owners, latest run and two parseable cards', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const output = dispatchReleaseStatus({ version: '0.2.10' }, {
    now, devVersion: () => '0.2.10',
    schedule: () => ({ version: '0.2.10', cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-03T07:00:00.000Z', updatedAt: now.toISOString(), updatedBy: 'owner' }),
    checklist: () => ({ version: '0.2.10', released: '', dev: '0.2.10', history: [], items: [
      ...['G1', 'G2'].map(id => ({ id, title: id, status: 'green' as const, updatedAt: '', updatedBy: '' })),
      { id: 'R1', title: '막힌 칸', status: 'red', owner: 'OP', updatedAt: '', updatedBy: '' },
      { id: 'Y1', title: '진행 칸', status: 'yellow', owner: 'TC', updatedAt: '', updatedBy: '' },
    ] }),
    latestRun: () => ({ status: 'done', path: ['build', 'publish'], startedAt: '2026-10-01T03:00:00Z' }) as any,
  });
  expect(output.text).toContain('컷 10-03(토) 08:00 KST');
  expect(output.text).toContain('R1 막힌 칸 (OP)');
  expect(output.text).toContain('컷 D-1 (23시간)');
  expect(output.text).toContain('TC 1');
  expect(output.text).toContain('done · 끝 노드 publish');
  expect((output.structured.releases as any[])[0].counts).toEqual({ green: 2, yellow: 1, red: 1, done: 0 });
  const cards = parseElanousCard(output.text);
  expect(cards.map(card => card.kind)).toEqual(['release-schedule', 'release-checklist']);
  expect(cards[0]?.items[0]).toMatchObject({ title: '0.2.10 컷', due: '2026-10-03', daysLeft: 1 });
  expect(cards[1]?.items[0]).toMatchObject({ title: 'R1 막힌 칸', state: 'red', owner: 'OP' });
  expect(output.text.indexOf('최근 발행 런')).toBeLessThan(output.text.indexOf('```elanous-card'));
});

test('missing schedule is not an error; omitted version reads development and next release', () => {
  const read: string[] = [];
  const result = dispatchReleaseStatus({}, { devVersion: () => '0.2.10', schedule: () => null,
    checklist: (version) => { read.push(version); return { version, released: '', dev: version, history: [], items: [] }; }, latestRun: () => null });
  expect(read).toEqual(['0.2.10', '0.2.11']);
  expect(result.text).toContain('컷 미정');
  expect(parseElanousCard(result.text)[0]?.items.map(item => item.due)).toEqual([null, null]);
});

test('a release-branch dev version (0.2.18-dev.0) reads the 0.2.18 and 0.2.19 checklists, not a version the checklist rejects', () => {
  const read: string[] = [];
  dispatchReleaseStatus({}, { devVersion: () => '0.2.18-dev.0', schedule: () => null,
    checklist: (version) => { read.push(version); return { version, released: '', dev: version, history: [], items: [] }; }, latestRun: () => null });
  expect(read).toEqual(['0.2.18', '0.2.19']);
});

test('missing schedule in the real ledger returns 컷 미정 without an error', () => {
  fixture();
  const result = dispatchReleaseStatus({ version: '0.2.14' }, { latestRun: () => null });
  expect(result.text).toContain('0.2.14 · 컷 미정');
  expect((result.structured.releases as Array<{ schedule: unknown }>)[0]?.schedule).toBeNull();
});

test('owner approval adds exactly one ledger item and history by owner; core dispatch does not take identity from args', async () => {
  fixture();
  const prompts: string[] = [];
  const result = await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id: 'REL9', title: '판올림', owner: 'OP' }, human, {
    confirm: async opts => { prompts.push(opts.prompt); return { answer: true, channel: 'terminal', elapsedMs: 0 }; },
  });
  expect(result).toContain('변경했습니다');
  expect(prompts).toEqual(['0.2.11 에 칸 REL9 «판올림» 추가 — 진행할까요?']);
  expect(listChecklist('0.2.11').items).toMatchObject([{ id: 'REL9', owner: 'OP', updatedBy: 'owner' }]);
  expect(history('REL9')[0]).toMatchObject({ by: 'owner', field: 'add' });
  expect(await buildCoreTools().dispatch('release_change', { action: 'add-item', version: '0.2.11', id: 'BAD', title: '거부', actor: 'owner' })).toContain('오너');
  expect(listChecklist('0.2.11').items).toHaveLength(1);
});

test('a positive answer labeled timeout still fails closed without changing the ledger', async () => {
  fixture();
  const output = await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id: 'TIMEOUT', title: 'no' }, human,
    { confirm: confirm(true, 'timeout') });
  expect(output).toContain('변경하지 않았습니다');
  expect(listChecklist('0.2.11').items).toHaveLength(0);
});

test('refused or timed-out confirmation makes zero ledger changes', async () => {
  fixture();
  for (const [id, channel] of [['N1', 'terminal'], ['N2', 'timeout']] as const) {
    const result = await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id, title: id }, human, { confirm: confirm(false, channel) });
    expect(result).toContain('변경하지 않았습니다');
  }
  expect(listChecklist('0.2.11').items).toHaveLength(0);
});

test('refused move and schedule confirmations leave the existing ledger intact', async () => {
  fixture();
  await dispatchReleaseChange({ action: 'add-item', version: '0.2.10', id: 'STAY', title: '남는 칸' }, human,
    { confirm: confirm(true) });
  const refusedMove = await dispatchReleaseChange({ action: 'move-item', id: 'STAY', from: '0.2.10', to: '0.2.11' }, human,
    { confirm: confirm(false) });
  const refusedSchedule = await dispatchReleaseChange({ action: 'set-schedule', version: '0.2.11', cutAt: '2026-10-03T08:00:00+09:00' }, human,
    { confirm: confirm(false, 'timeout') });
  expect(refusedMove).toContain('변경하지 않았습니다');
  expect(refusedSchedule).toContain('변경하지 않았습니다');
  expect(listChecklist('0.2.10').items.map(item => item.id)).toEqual(['STAY']);
  expect(listChecklist('0.2.11').items).toHaveLength(0);
  expect(getSchedule('0.2.11')).toBeNull();
  expect(history('STAY').map(item => item.field)).toEqual(['add']);
});

test('declared session source and owner origin cannot impersonate server-verified owner', async () => {
  fixture();
  let asked = 0;
  const output = await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id: 'BAD', title: '금지' },
    { surface: 'tui', sessionId: 'declared-telegram', requestOrigin: 'owner', confirmChannels: [originChannel] },
    { confirm: async () => { asked++; return { answer: true, channel: 'terminal', elapsedMs: 0 }; } });
  expect(output).toContain('오너');
  expect(asked).toBe(0);
  expect(listChecklist('0.2.11').items).toHaveLength(0);
});

test('verified owner without originating channel never asks globally or writes', async () => {
  fixture();
  let asked = 0;
  const output = await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id: 'BAD', title: '금지' },
    { ...human, confirmChannels: undefined },
    { confirm: async () => { asked++; return { answer: true, channel: 'terminal', elapsedMs: 0 }; } });
  expect(output).toContain('확인 채널이 없어');
  expect(asked).toBe(0);
  expect(listChecklist('0.2.11').items).toHaveLength(0);
});

test('a positive answer on another channel is rejected without a ledger write', async () => {
  fixture();
  const output = await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id: 'BAD', title: '금지' },
    human, { confirm: confirm(true, 'telegram') });
  expect(output).toContain('변경하지 않았습니다');
  expect(listChecklist('0.2.11').items).toHaveLength(0);
});

test('no human / non-owner is rejected before confirmation or ledger write', async () => {
  fixture();
  let requests = 0;
  const deps = { confirm: async () => { requests++; return { answer: true, channel: 'terminal', elapsedMs: 0 }; } };
  for (const ctx of [undefined, { ...human, requestOrigin: 'external-agent' as const }, { ...human, sessionId: undefined },
    { surface: 'tui' as const, sessionId: 'autonomous' }]) {
    expect(await dispatchReleaseChange({ action: 'add-item', version: '0.2.11', id: 'NO', title: '금지' }, ctx, deps)).toContain('오너');
  }
  expect(requests).toBe(0);
  expect(listChecklist('0.2.11').items).toHaveLength(0);
});

test('move-item invokes the feature ledger once after approval; schedule writes owner history', async () => {
  const root = fixture();
  await dispatchReleaseChange({ action: 'add-item', version: '0.2.10', id: 'MOVE', title: '이동' }, human, { confirm: confirm(true) });
  let calls = 0;
  const realMove = (await import('../release-loop/feature-store.js')).move;
  await dispatchReleaseChange({ action: 'move-item', id: 'MOVE', from: '0.2.10', to: '0.2.11' }, human,
    { confirm: confirm(true), move: (...args) => { calls++; return realMove(...args); } });
  expect(calls).toBe(1);
  expect(listChecklist('0.2.10').items).toHaveLength(0);
  expect(listChecklist('0.2.11').items[0]?.id).toBe('MOVE');
  expect(history('MOVE').at(-1)).toMatchObject({ field: 'move', by: 'owner' });
  await dispatchReleaseChange({ action: 'set-schedule', version: '0.2.11', cutAt: '2026-10-03T08:00:00+09:00' }, human, { confirm: confirm(true) });
  expect(getSchedule('0.2.11')?.updatedBy).toBe('owner');
  const status = dispatchReleaseStatus({ version: '0.2.11' }, { now: new Date('2026-10-02T00:00:00Z'), latestRun: () => null });
  expect((status.structured.releases as Array<{ counts: { yellow: number }; schedule: { cutAt: string } }>)[0])
    .toMatchObject({ counts: { yellow: 1 }, schedule: { cutAt: '2026-10-02T23:00:00.000Z' } });
  expect(parseElanousCard(status.text).map(card => card.kind)).toEqual(['release-schedule', 'release-checklist']);
  const viaCore = await buildCoreTools().dispatch('release_status', { version: '0.2.11' }) as typeof status;
  expect((viaCore.structured.releases as Array<{ counts: { yellow: number } }>)[0]?.counts.yellow).toBe(1);
  expect(parseElanousCard(viaCore.text)[0]?.items[0]?.due).toBe('2026-10-03');
  const db = new Database(join(root, 'release', 'features.sqlite'));
  try { expect((db.query("SELECT by FROM events WHERE feature_id = '@version' AND field = 'cut_at'").get() as { by: string }).by).toBe('owner'); }
  finally { db.close(); }
});

test('shared PWA/TUI core dispatch preserves owner context and asks on the originating channel', async () => {
  fixture();
  let asked = 0;
  const channel = { name: 'pwa', request: async () => { asked++; return true; }, cancel: () => {} };
  const shared = buildSharedAppTools();
  expect(shared.names.has('release_change')).toBe(true);
  const result = await shared.dispatch('release_change', { action: 'add-item', version: '0.2.11', id: 'PWA', title: '카드' },
    { ...human, confirmChannels: [channel] });
  expect(result).toContain('변경했습니다');
  expect(asked).toBe(1);
  expect(listChecklist('0.2.11').items[0]?.id).toBe('PWA');
});

test('card parser accepts both blocks, ignores malformed blocks, preserves prose', () => {
  const text = `사람용 원문\n${formatElanousCard({ kind: 'release-schedule', items: [] })}\n\`\`\`elanous-card\nnot-json\n\`\`\`\n${formatElanousCard({ kind: 'coo-admin', items: [] })}`;
  expect(text.startsWith('사람용 원문')).toBe(true);
  expect(parseElanousCard(text).map(card => card.kind)).toEqual(['release-schedule', 'coo-admin']);
});

test('release NL corpus follows the measurement loader shape and exposed core tool catalog', () => {
  const corpus = JSON.parse(readFileSync(join(import.meta.dir, '../../test/fixtures/release-nl-routing-corpus.json'), 'utf8')) as {
    description: string; surface: string; tiers: Record<string, string>; items: Array<{ id: string; tier: string; prompt: string; accept: string[]; reject?: string[] }>;
  };
  expect(corpus.description.length).toBeGreaterThan(0);
  expect(corpus.surface).toBe('webterm');
  expect(isEvalPromptToolSurface(corpus.surface)).toBe(true);
  expect(() => assertGradableItems(corpus.items)).not.toThrow();
  expect(selectCorpusItems(corpus.items, {})).toHaveLength(10);
  const releaseItems = corpus.items.filter(item => item.id.startsWith('rel-'));
  expect(releaseItems).toHaveLength(5);
  expect(classifyRouting(['release_status'], releaseItems[1]!.accept, releaseItems[1]!.reject)).toBe('rejected-tool');
  expect(classifyRouting([], releaseItems[3]!.accept, releaseItems[3]!.reject)).toBe('pass');
  expect(unavailableExpectedToolIds(corpus.items, buildCoreTools().specs.map(spec => spec.name))).toEqual([]);
  expect(new Set(corpus.items.map(item => item.id)).size).toBe(10);
  for (const item of corpus.items) {
    expect(corpus.tiers[item.tier]).toBeTruthy();
    expect(item.prompt).toBeTruthy();
    expect(Array.isArray(item.accept)).toBe(true);
    expect((item.reject ?? []).some(name => item.accept.includes(name))).toBe(false);
  }
  expect(releaseItems.map(item => [item.prompt, item.accept, item.reject])).toEqual([
    ['0.2.10 어디까지 왔어', ['release_status'], ['release_change', 'coo_admin']],
    ['행정 뭐 남았어', ['coo_admin'], ['release_status']],
    ['0.2.11 에 ○○ 칸 추가해줘', ['release_change'], ['release_status']],
    ['오늘 날씨 어때', [], ['release_status', 'release_change']],
    ['로그 보여줘', [], ['release_status', 'release_change']],
  ]);
  expect(RELEASE_STATUS_SPEC.description).toContain('컷 언제');
  expect(RELEASE_CHANGE_SPEC.name).toBe('release_change');
});
