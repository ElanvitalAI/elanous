import { afterEach, expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { retroDayFile } from '../retro/daily.js';
import type { CoordEvent } from './coord-events.js';
import type { MemoryItem } from './long-term-memory.js';
import {
  SEAT_RETRO_CARD_TITLE, SEAT_RETRO_MORNING_MAX_LINES, discoverSeats, roleProposalName, runSeatRetroStage,
  seatMemoryBeginMarker, seatRetroBakDir, seatRetroBeginMarker, seatRetroDayFile, seatRetroMorningCard, type SeatRetroFs,
} from './seat-retro.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DAY = '2026-11-16';
const LIVE = () => ({ context: { seatRetro: { mode: 'live' } } });
const RETRO_HEAD = '# TC 자기 회고 (2시간마다 한 절 · 최신이 위)\n\n## 11-16 21:xx (손 회고)\n- 한 일: 손으로 쓴 줄\n';
const MEMORY_HEAD = '- 손으로 쓴 기억 한 줄 · 이유 포함\n';

function seatState(seats: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'tc-srn-'));
  dirs.push(root);
  const seatRoot = join(root, 'seat-state');
  for (const seat of seats) {
    mkdirSync(join(seatRoot, seat), { recursive: true });
    writeFileSync(join(seatRoot, seat, 'ROLE.md'), `# ${seat} 역할 카드\n## 1. 사명\n손으로 쓴 사명\n`);
    writeFileSync(join(seatRoot, seat, 'RETRO.md'), RETRO_HEAD.replace('TC', seat));
    writeFileSync(join(seatRoot, seat, 'MEMORY.md'), MEMORY_HEAD);
  }
  // A seat folder without ROLE.md is not a retro seat.
  mkdirSync(join(seatRoot, 'NOROLE'), { recursive: true });
  return { root, seatRoot };
}

const event = (n: number, seat: string, summary: string): CoordEvent => ({
  id: `ev-${n}`, at: `${DAY}T0${n}:00:00.000Z`, text: 'raw', summary, kind: '보고',
  refs: { seat, recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: `https://example.test/${seat}/${n}` },
});
const item = (seat: string, topic: string): MemoryItem => ({
  project: 'alpha', seat, topic, summary: `${topic} ready`, source: `https://example.test/mem/${seat}/${topic}`,
  updatedAt: `${DAY}T05:00:00.000Z`, status: 'active',
});

/** The KST local-day window collect emits for DAY since #38187 (nightlyWindow): KST 00:00 = 15:00Z the day before. */
const KST_WINDOW = { since: '2026-11-15T15:00:00.000Z', until: '2026-11-16T15:00:00.000Z', timeZone: 'Asia/Seoul' };

function ctx(events: CoordEvent[], memoryItems: MemoryItem[]) {
  return { graphId: 'nightly-condense', nodeId: 'seat-retro', input: {},
    outputs: { collect: { day: DAY, window: KST_WINDOW, events, decisions: [] }, record: { memoryItems } } };
}

function writeRetroDaily(root: string, owner: string) {
  const file = retroDayFile(root, DAY);
  mkdirSync(join(root, 'retro', 'daily'), { recursive: true });
  writeFileSync(file, JSON.stringify({ day: DAY, actions: [{ id: 'RETRO-SILENT-FAILURE-20261116', theme: 'silent-failure', owner,
    title: '조용한 실패 한 단 위 수리', verdictLine: '알림 없는 실패 0', falsifier: 'x', evidence: ['F-0000abcd'], status: 'draft' }] }));
}

function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      hash.update(child);
      if (nodeFs.statSync(child).isDirectory()) walk(child); else hash.update(readFileSync(child));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test('live: one dated RETRO section per day — re-running the same day replaces it, hand-written lines stay', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const deps = { seatStateRoot: seatRoot, readConfig: LIVE };
  const first = await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], [item('TC', 'release')]), root, false, deps);
  expect(first).toMatchObject({ outcome: 'ok', mode: 'live', seats: [{ seat: 'TC', retro: 'written', memory: 'written' }] });
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  const once = readFileSync(retroFile, 'utf8');
  expect(count(once, seatRetroBeginMarker(DAY))).toBe(1);
  expect(once.startsWith('# TC 자기 회고')).toBe(true);
  expect(once).toContain('- 한 일: 손으로 쓴 줄');
  expect(once).toContain('https://example.test/TC/1');
  // Same facts again: byte-identical, reported as unchanged.
  const again = await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], [item('TC', 'release')]), root, false, deps);
  expect(again).toMatchObject({ seats: [{ seat: 'TC', retro: 'unchanged', memory: 'unchanged' }] });
  expect(readFileSync(retroFile, 'utf8')).toBe(once);
  // More facts the same day: the section is replaced in place, still one block.
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped'), event(2, 'TC', 'beta shipped')], [item('TC', 'release')]), root, false, deps);
  const replaced = readFileSync(retroFile, 'utf8');
  expect(count(replaced, seatRetroBeginMarker(DAY))).toBe(1);
  expect(replaced).toContain('beta shipped');
  expect(replaced).toContain('- 한 일: 손으로 쓴 줄');
  // MEMORY.md: hand-written line kept, one candidate block.
  const memory = readFileSync(join(seatRoot, 'TC', 'MEMORY.md'), 'utf8');
  expect(memory.startsWith(MEMORY_HEAD)).toBe(true);
  expect(count(memory, seatMemoryBeginMarker(DAY))).toBe(1);
  expect(memory).toContain('[후보] alpha/release: release ready');
});

test('ROLE.md is never edited; a dated proposal file carries the retro-daily actions the seat owns', async () => {
  const { root, seatRoot } = seatState(['TC']);
  writeRetroDaily(root, 'TC');
  const roleFile = join(seatRoot, 'TC', 'ROLE.md');
  const roleBefore = readFileSync(roleFile);
  const result = await runSeatRetroStage(ctx([], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
  expect(result).toMatchObject({ retroDaily: { day: DAY, status: 'read' }, seats: [{ seat: 'TC', proposal: 'written' }] });
  expect(readFileSync(roleFile).equals(roleBefore)).toBe(true);
  const proposal = readFileSync(join(seatRoot, 'TC', roleProposalName(DAY)), 'utf8');
  expect(proposal).toContain('상태: 제안');
  expect(proposal).toContain('RETRO-SILENT-FAILURE-20261116');
  expect(proposal).toContain(createHash('sha256').update(roleBefore).digest('hex'));
  expect(readFileSync(join(seatRoot, 'TC', 'RETRO.md'), 'utf8')).toContain(roleProposalName(DAY));
});

test('shadow (default) computes and emits but writes nothing to seat-state; the morning card stays off', async () => {
  const { root, seatRoot } = seatState(['TC', 'UX']);
  writeRetroDaily(root, 'TC');
  const before = treeHash(seatRoot);
  const result = await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], [item('TC', 'release')]), root, false,
    { seatStateRoot: seatRoot });
  expect(result).toMatchObject({ mode: 'shadow', seats: [{ seat: 'TC', retro: 'shadow', memory: 'shadow', proposal: 'shadow' },
    { seat: 'UX', retro: 'shadow' }] });
  expect(treeHash(seatRoot)).toBe(before);
  expect(existsSync(join(seatRoot, '.seat-retro.lock'))).toBe(false);
  // The only write is the shadow day file under the run universe.
  expect(JSON.parse(readFileSync(seatRetroDayFile(root, DAY), 'utf8'))).toMatchObject({ mode: 'shadow', briefing: false });
  expect(seatRetroMorningCard(root, DAY)).toBeNull();
  // Config live but input forces shadow: still nothing.
  await runSeatRetroStage({ ...ctx([], []), input: { mode: 'shadow' } }, root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
  expect(treeHash(seatRoot)).toBe(before);
});

test('dry-run writes no file at all, not even the shadow day file', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const before = treeHash(seatRoot);
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, true, { seatStateRoot: seatRoot, readConfig: LIVE });
  expect(treeHash(seatRoot)).toBe(before);
  expect(existsSync(join(root, 'context-memory'))).toBe(false);
});

test('a failure mid-write leaves RETRO.md byte-identical and no temp file behind', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  const original = readFileSync(retroFile);
  // The new text is moved in last (link tmp → RETRO.md); fail exactly that step, after the original was set aside.
  const failingFs: SeatRetroFs = { ...nodeFs, linkSync: ((from: string, to: string) => {
    if (String(to) === retroFile && String(from).endsWith('.tmp')) throw new Error('disk full (injected)');
    return nodeFs.linkSync(from, to);
  }) as typeof nodeFs.linkSync };
  const result = await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false,
    { seatStateRoot: seatRoot, readConfig: LIVE, fs: failingFs });
  expect(result).toMatchObject({ outcome: 'ok', failedSeats: ['TC'], seats: [{ seat: 'TC', retro: 'error', error: 'disk full (injected)' }] });
  expect(readFileSync(retroFile).equals(original)).toBe(true);
  expect(readdirSync(join(seatRoot, 'TC')).filter(name => name.includes('.seat-retro.'))).toEqual([]);
});

test('a crash between setting RETRO.md aside and moving the new text in is undone by the next run', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  const original = readFileSync(retroFile, 'utf8');
  nodeFs.renameSync(retroFile, `${retroFile}.seat-retro.claim`);
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
  const text = readFileSync(retroFile, 'utf8');
  expect(text).toContain('- 한 일: 손으로 쓴 줄');
  expect(text.startsWith(original.split('\n')[0]!)).toBe(true);
  expect(existsSync(`${retroFile}.seat-retro.claim`)).toBe(false);
});

test('a hand edit after the last read (just before the swap) is kept, and a file recreated mid-swap is never overwritten', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  let step = 0;
  const racingFs: SeatRetroFs = { ...nodeFs, renameSync: ((from: string, to: string) => {
    if (String(from) === retroFile && String(to).endsWith('.claim')) {
      step += 1;
      // 1st swap: the seat appends right before the set-aside. 2nd swap: the seat's editor recreates the file after it.
      if (step === 1) nodeFs.appendFileSync(retroFile, '- 읽은 뒤 손으로 더한 줄\n');
      nodeFs.renameSync(from, to);
      if (step === 2) nodeFs.writeFileSync(retroFile, `${nodeFs.readFileSync(to, 'utf8')}- 편집기가 다시 쓴 줄\n`);
      return;
    }
    return nodeFs.renameSync(from, to);
  }) as typeof nodeFs.renameSync };
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE, fs: racingFs });
  const text = readFileSync(retroFile, 'utf8');
  expect(text).toContain('- 읽은 뒤 손으로 더한 줄');
  expect(text).toContain('- 편집기가 다시 쓴 줄');
  expect(count(text, seatRetroBeginMarker(DAY))).toBe(1);
  expect(readdirSync(join(seatRoot, 'TC')).filter(name => name.includes('.seat-retro.'))).toEqual([]);
});

/** Every line of `original` is in the final file, and some bak holds the original bytes exactly. */
function assertOriginalKept(file: string, original: string) {
  const text = readFileSync(file, 'utf8');
  for (const line of original.split('\n').filter(Boolean)) expect(text).toContain(line);
  const bakDir = seatRetroBakDir(file);
  const baks = existsSync(bakDir) ? readdirSync(bakDir).map(name => readFileSync(join(bakDir, name), 'utf8')) : [];
  expect(baks).toContain(original);
}

/** fs whose unlinkSync records every path, so a test can assert only node-made temp files were ever deleted. */
function recordingFs(base: SeatRetroFs, unlinked: string[]): SeatRetroFs {
  return { ...base, unlinkSync: ((path: string) => { unlinked.push(String(path)); return nodeFs.unlinkSync(path); }) as typeof nodeFs.unlinkSync };
}

test('a `>>` append landing in the swap window keeps the whole original plus the appended line; only temp files are unlinked', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  const original = readFileSync(retroFile, 'utf8');
  let appended = false;
  const unlinked: string[] = [];
  const racingFs = recordingFs({ ...nodeFs, renameSync: ((from: string, to: string) => {
    nodeFs.renameSync(from, to);
    if (!appended && String(from) === retroFile && String(to).endsWith('.claim')) {
      appended = true;
      // `echo … >> RETRO.md` after the original was set aside: a new file holding only this line.
      nodeFs.appendFileSync(retroFile, '- 창 안에서 >> 로 더한 줄\n');
    }
  }) as typeof nodeFs.renameSync }, unlinked);
  const result = await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false,
    { seatStateRoot: seatRoot, readConfig: LIVE, fs: racingFs });
  expect(appended).toBe(true);
  expect(result).toMatchObject({ seats: [{ seat: 'TC', retro: 'written' }] });
  const text = readFileSync(retroFile, 'utf8');
  expect(text).toContain('- 창 안에서 >> 로 더한 줄');
  expect(count(text, seatRetroBeginMarker(DAY))).toBe(1);
  assertOriginalKept(retroFile, original);
  expect(unlinked.every(path => path.endsWith('.tmp'))).toBe(true);
  expect(readdirSync(join(seatRoot, 'TC')).filter(name => name.includes('.seat-retro.'))).toEqual([]);
});

test('restart recovery after a crash with a `>>` file beside the set-aside original keeps both', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  const original = readFileSync(retroFile, 'utf8');
  nodeFs.renameSync(retroFile, `${retroFile}.seat-retro.claim`);
  writeFileSync(retroFile, '- 죽은 사이 >> 로 더한 줄\n');
  const unlinked: string[] = [];
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false,
    { seatStateRoot: seatRoot, readConfig: LIVE, fs: recordingFs(nodeFs, unlinked) });
  const text = readFileSync(retroFile, 'utf8');
  expect(text).toContain('- 죽은 사이 >> 로 더한 줄');
  expect(count(text, seatRetroBeginMarker(DAY))).toBe(1);
  assertOriginalKept(retroFile, original);
  expect(existsSync(`${retroFile}.seat-retro.claim`)).toBe(false);
  expect(unlinked.every(path => path.endsWith('.tmp'))).toBe(true);
});

test('collect window (KST) is used as is: a fact at KST 01:00 — before UTC midnight — is in the seat section', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const early: CoordEvent = { ...event(1, 'TC', 'kst early fact'), at: '2026-11-15T16:00:00.000Z' };
  const result = await runSeatRetroStage(ctx([early], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
  expect(result).toMatchObject({ seats: [{ seat: 'TC', counts: { events: 1 } }] });
  expect(readFileSync(join(seatRoot, 'TC', 'RETRO.md'), 'utf8')).toContain('kst early fact');
});

test('collect without a window is a loud skip that writes nothing — never a silent UTC-day cut', async () => {
  const logs: Array<{ event: string; data: unknown; level?: string }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, name: string, data?: unknown, opts?: { level?: string }) => {
    if (category === 'context.seat-retro') logs.push({ event: name, data, level: opts?.level });
  }) as typeof debug.log);
  try {
    const { root, seatRoot } = seatState(['TC']);
    const before = treeHash(seatRoot);
    const early: CoordEvent = { ...event(1, 'TC', 'kst early fact'), at: '2026-11-15T16:00:00.000Z' };
    const noWindow = ctx([early], []);
    // A collect output that carries the day but no local window (the pre-#38187 shape).
    const collect = { day: DAY, events: [early], decisions: [] };
    const result = await runSeatRetroStage({ ...noWindow, outputs: { ...noWindow.outputs, collect } }, root, false,
      { seatStateRoot: seatRoot, readConfig: LIVE });
    expect(result).toMatchObject({ outcome: 'ok', skipped: 'collect-window-missing', seats: [] });
    expect(logs).toContainEqual({ event: 'skip', data: { day: DAY, reason: 'collect-window-missing' }, level: 'error' });
    expect(treeHash(seatRoot)).toBe(before);
    expect(existsSync(seatRetroDayFile(root, DAY))).toBe(false);
  } finally { spy.mockRestore(); }
});

test('replaced seat files keep their original permission bits', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const memoryFile = join(seatRoot, 'TC', 'MEMORY.md');
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  nodeFs.chmodSync(memoryFile, 0o600);
  nodeFs.chmodSync(retroFile, 0o640);
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], [item('TC', 'release')]), root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
  expect(readFileSync(memoryFile, 'utf8')).toContain(seatMemoryBeginMarker(DAY));
  expect(nodeFs.statSync(memoryFile).mode & 0o777).toBe(0o600);
  expect(nodeFs.statSync(retroFile).mode & 0o777).toBe(0o640);
});

test('a same-day rerun with no candidates or owned actions retracts the day memory block and the node-written proposal', async () => {
  const { root, seatRoot } = seatState(['TC']);
  writeRetroDaily(root, 'TC');
  const deps = { seatStateRoot: seatRoot, readConfig: LIVE };
  await runSeatRetroStage(ctx([], [item('TC', 'release')]), root, false, deps);
  const proposalFile = join(seatRoot, 'TC', roleProposalName(DAY));
  expect(existsSync(proposalFile)).toBe(true);
  writeRetroDaily(root, 'UX');
  const rerun = await runSeatRetroStage(ctx([], []), root, false, deps);
  expect(rerun).toMatchObject({ seats: [{ seat: 'TC', memory: 'retracted', proposal: 'retracted' }] });
  expect(existsSync(proposalFile)).toBe(false);
  const memory = readFileSync(join(seatRoot, 'TC', 'MEMORY.md'), 'utf8');
  expect(memory.startsWith(MEMORY_HEAD)).toBe(true);
  expect(memory).not.toContain(seatMemoryBeginMarker(DAY));
  expect(readFileSync(join(seatRoot, 'TC', 'RETRO.md'), 'utf8')).not.toContain(roleProposalName(DAY));
});

test('a retro-daily day file without a well-formed actions array is reported unreadable, not read as zero actions', async () => {
  const { root, seatRoot } = seatState(['TC']);
  mkdirSync(join(root, 'retro', 'daily'), { recursive: true });
  writeFileSync(retroDayFile(root, DAY), JSON.stringify({ day: DAY }));
  expect(await runSeatRetroStage(ctx([], []), root, true, { seatStateRoot: seatRoot }))
    .toMatchObject({ retroDaily: { day: DAY, status: 'unreadable' } });
  writeFileSync(retroDayFile(root, DAY), JSON.stringify({ day: DAY, actions: [{ id: 'RETRO-X', title: 'no owner' }] }));
  expect(await runSeatRetroStage(ctx([], []), root, true, { seatStateRoot: seatRoot }))
    .toMatchObject({ retroDaily: { day: DAY, status: 'unreadable' } });
});

test('a hand edit landing between read and rename is kept: the section is rebuilt on the new text', async () => {
  const { root, seatRoot } = seatState(['TC']);
  const retroFile = join(seatRoot, 'TC', 'RETRO.md');
  let raced = false;
  const racingFs: SeatRetroFs = { ...nodeFs, writeFileSync: ((file: string, data: string) => {
    nodeFs.writeFileSync(file, data);
    if (!raced && String(file).startsWith(`${retroFile}.seat-retro.`)) {
      raced = true;
      nodeFs.appendFileSync(retroFile, '- 동시에 손으로 더한 줄\n');
    }
  }) as typeof nodeFs.writeFileSync };
  await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE, fs: racingFs });
  const text = readFileSync(retroFile, 'utf8');
  expect(raced).toBe(true);
  expect(text).toContain('- 동시에 손으로 더한 줄');
  expect(count(text, seatRetroBeginMarker(DAY))).toBe(1);
});

test('two seats each get only their own facts', async () => {
  const { root, seatRoot } = seatState(['TC', 'UX']);
  expect(discoverSeats(seatRoot)).toEqual(['TC', 'UX']);
  await runSeatRetroStage(ctx([event(1, 'TC', 'tc fact'), event(2, 'UX', 'ux fact')], [item('UX', 'screen')]), root, false,
    { seatStateRoot: seatRoot, readConfig: LIVE });
  const tc = readFileSync(join(seatRoot, 'TC', 'RETRO.md'), 'utf8');
  const ux = readFileSync(join(seatRoot, 'UX', 'RETRO.md'), 'utf8');
  expect(tc).toContain('tc fact');
  expect(tc).not.toContain('ux fact');
  expect(ux).toContain('ux fact');
  expect(ux).toContain('alpha/screen');
  expect(readFileSync(join(seatRoot, 'TC', 'MEMORY.md'), 'utf8')).toBe(MEMORY_HEAD);
  expect(readFileSync(join(seatRoot, 'UX', 'MEMORY.md'), 'utf8')).toContain(seatMemoryBeginMarker(DAY));
});

test('an empty day writes an explicit «사실 없음» section and a seat-empty event; no seats is a loud skip', async () => {
  const logs: Array<{ category: string; event: string; level?: string }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, name: string, _data?: unknown, opts?: { level?: string }) => {
    logs.push({ category, event: name, level: opts?.level });
  }) as typeof debug.log);
  try {
    const { root, seatRoot } = seatState(['TC']);
    await runSeatRetroStage(ctx([], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
    expect(readFileSync(join(seatRoot, 'TC', 'RETRO.md'), 'utf8')).toContain('- 사실 없음: 이벤트 0 · 결정 0 · 기억 0 · 회고 조치 0');
    expect(logs).toContainEqual({ category: 'context.seat-retro', event: 'seat-empty', level: undefined });
    const empty = mkdtempSync(join(tmpdir(), 'tc-srn-empty-'));
    dirs.push(empty);
    const none = await runSeatRetroStage(ctx([], []), empty, false, { seatStateRoot: join(empty, 'seat-state'), readConfig: LIVE });
    expect(none).toMatchObject({ outcome: 'ok', seats: [] });
    expect(logs).toContainEqual({ category: 'context.seat-retro', event: 'skip', level: 'error' });
  } finally { spy.mockRestore(); }
});

test('a seat-list read error or a lock timeout is a loud per-run skip that still returns ok (the next node is not blocked)', async () => {
  const logs: Array<{ event: string; level?: string; reason?: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((_category: string, name: string, data?: Record<string, unknown>, opts?: { level?: string }) => {
    logs.push({ event: name, level: opts?.level, reason: data?.reason });
  }) as typeof debug.log);
  try {
    const { root, seatRoot } = seatState(['TC']);
    const unreadable = { ...nodeFs, readdirSync: (() => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); }) as typeof nodeFs.readdirSync };
    expect(await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false, { seatStateRoot: seatRoot, readConfig: LIVE, fs: unreadable }))
      .toMatchObject({ outcome: 'ok', seats: [], seatListError: expect.stringContaining('EACCES') });
    expect(logs).toContainEqual({ event: 'skip', level: 'error', reason: 'seat-list-unreadable' });

    const timedOut = async () => { throw new Error('lock acquisition timed out'); };
    const result = await runSeatRetroStage(ctx([event(1, 'TC', 'alpha shipped')], []), root, false,
      { seatStateRoot: seatRoot, readConfig: LIVE, acquireLock: timedOut });
    expect(result).toMatchObject({ outcome: 'ok', failedSeats: ['TC'], lockError: 'lock acquisition timed out' });
    expect((result.seats as Array<{ retro: string; error?: string }>)[0]).toMatchObject({ retro: 'error', error: expect.stringContaining('lock unavailable') });
    expect(readFileSync(join(seatRoot, 'TC', 'RETRO.md'), 'utf8')).toBe(RETRO_HEAD);
    expect(logs).toContainEqual({ event: 'skip', level: 'error', reason: 'lock-unavailable' });
  } finally { spy.mockRestore(); }
});

test('morning card «어젯밤 이은 것» carries at most two lines, each with an evidence link', async () => {
  const { root, seatRoot } = seatState(['TC', 'UX', 'MK']);
  await runSeatRetroStage(ctx([event(1, 'TC', 'a'), event(2, 'UX', 'b'), event(3, 'MK', 'c'), event(4, 'MK', 'd')],
    [item('TC', 'release')]), root, false, { seatStateRoot: seatRoot, readConfig: LIVE });
  const card = seatRetroMorningCard(root, DAY);
  expect(card?.title).toBe(SEAT_RETRO_CARD_TITLE);
  expect(card!.lines.length).toBeLessThanOrEqual(SEAT_RETRO_MORNING_MAX_LINES);
  expect(card!.lines.map(line => line.seat)).toEqual(['MK', 'TC']);
  for (const line of card!.lines) {
    expect(line.evidence).not.toEqual([]);
    expect(line.evidence[0]).toBe(`file://${join(seatRoot, line.seat, 'RETRO.md')}`);
  }
});
