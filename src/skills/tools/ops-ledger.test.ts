// Ops-ledger native tools (우편 msg · 판 release checklist) — focused tests.
//
// Covers the in-process dispatchers (same ledgers as the `elanous msg` /
// `elanous release checklist` CLIs), the seat/OP permission boundaries, the
// HQ-fence denial path, the RunShell steering for covered CLI shapes, and the
// catalog ↔ runtime ↔ registry wiring.

import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../instance/resolve.js';
import { listChecklist } from '../../release-loop/checklist.js';
import {
  dispatchMsgAck,
  dispatchMsgList,
  dispatchMsgPost,
  dispatchChecklistAdd,
  dispatchChecklistEdit,
  dispatchChecklistList,
  dispatchChecklistMove,
  dispatchChecklistSet,
  type MsgLedgerDeps,
} from './ops-ledger.js';
import { dispatchRunShell, rejectedLedgerCliResult } from './shell.js';
import { debug } from '../../debug/log.js';
import { ALL_OPS_LEDGER_RUNTIMES } from '../../tool-runtime/ops-ledger-runtimes.js';
import { runShellRuntime } from '../../tool-runtime/run-shell-runtime.js';
import { findNativeTool } from '../../native-tool-catalog.js';
import { _resetToolRuntimeRegistryForTest, dispatchToolByName, getToolRuntime, listToolRuntimes } from '../../tool-runtime/registry.js';
import { registerAllDefaultToolRuntimes } from '../../tool-runtime/index.js';
import { buildSessionRuntimeToolSpecs } from '../../session-runtime/index.js';
import { dispatchDashboardSessionRuntimeTool } from '../../dashboard/session-runtime-dispatch.js';

describe('ops-ledger msg tools (우편)', () => {
  let dir: string;
  let msgDeps: MsgLedgerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ops-ledger-msg-'));
    const dbPath = join(dir, 'messages.db');
    msgDeps = { openStore: () => new MsgStore(dbPath) };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('post → list → ack → list 왕복 · 커서 전진 · 300ms 이내', async () => {
    const posted = await dispatchMsgPost({ from: 'OP', to: 'TC', body: '릴리스 컷 18시 KST' }, msgDeps);
    expect(posted.ok).toBe(true);
    expect(posted.message.id).toBeGreaterThan(0);
    expect(posted.message.from).toBe('OP');
    expect(posted.message.to).toBe('TC');

    const startedAt = Date.now();
    const listed = await dispatchMsgList({ to: 'TC' }, msgDeps);
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(1);
    expect(listed.after).toBe(0);
    expect(listed.messages[0]!.body).toBe('릴리스 컷 18시 KST');

    const acknowledged = await dispatchMsgAck({ to: 'TC', id: posted.message.id }, msgDeps);
    expect(acknowledged.ok).toBe(true);
    expect(acknowledged.cursor).toBe(posted.message.id);

    const afterAck = await dispatchMsgList({ to: 'TC' }, msgDeps);
    expect(afterAck.count).toBe(0);
    expect(afterAck.after).toBe(posted.message.id);
  });

  test('좌석 정규화 · ALL 발신 거부 · 인자 검증', async () => {
    const posted = await dispatchMsgPost({ from: 'coo', to: 'cto', body: '별칭 좌석' }, msgDeps);
    expect(posted.message.from).toBe('OP');
    expect(posted.message.to).toBe('TC');

    await expect(dispatchMsgPost({ from: 'ALL', to: 'OP', body: 'broad' }, msgDeps)).rejects.toThrow('ALL cannot send messages');
    await expect(dispatchMsgPost({ from: 'OP', to: 'TC' }, msgDeps)).rejects.toThrow("'body' must be a nonempty string");
    await expect(dispatchMsgList({ to: 'TC', limit: 1001 }, msgDeps)).rejects.toThrow("'limit' must be an integer between 1 and 1000");
    await expect(dispatchMsgList({ to: 'TC', after: -1 }, msgDeps)).rejects.toThrow("'after'");
    await expect(dispatchMsgList({}, msgDeps)).rejects.toThrow("'to' must be a nonempty string");
  });
});

describe('ops-ledger msg tools — 채워 넣은 인자', () => {
  test('after:0 · limit:0 · kind:"" · replyTo:0 은 «안 줌» · 지난 우편은 includeAcknowledged 로만', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ledger-msg-fill-'));
    const msgDeps: MsgLedgerDeps = { openStore: () => new MsgStore(join(dir, 'messages.db')) };
    try {
      for (let i = 1; i <= 3; i += 1) await dispatchMsgPost({ from: 'TC', to: 'OP', body: `m${i}`, kind: '', replyTo: 0 }, msgDeps);
      await dispatchMsgAck({ to: 'OP', id: 2 }, msgDeps);
      const filled = await dispatchMsgList({ to: 'OP', after: 0, limit: 0, includeAcknowledged: false }, msgDeps);
      expect(filled.messages.map(message => message.body)).toEqual(['m3']);
      const all = await dispatchMsgList({ to: 'OP', includeAcknowledged: true }, msgDeps);
      expect(all.messages.map(message => message.body)).toEqual(['m1', 'm2', 'm3']);
      expect(all.after).toBe(0);
      const paged = await dispatchMsgList({ to: 'OP', after: 1 }, msgDeps);
      expect(paged.messages.map(message => message.body)).toEqual(['m2', 'm3']);
      expect(all.messages[0]!.kind ?? null).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ops-ledger checklist tools (판)', () => {
  let dir: string;
  let oldTrack: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ops-ledger-checklist-'));
    setElanousConfigDir(dir);
    oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_TRACK = 'OP';
  });

  afterEach(() => {
    if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  });

  test('add → set → list 왕복 · 요약 · 담당 거르기 · 인자 검증', async () => {
    const added = await dispatchChecklistAdd({ id: 'K1', title: '첫 칸', version: '9.9.9', owner: 'OP' });
    expect(added.ok).toBe(true);
    expect(added.version).toBe('9.9.9');
    expect(added.item?.id).toBe('K1');
    expect(added.summary?.yellow).toBe(1);
    expect('snapshot' in added).toBe(false);

    const set = await dispatchChecklistSet({ id: 'K1', version: '9.9.9', status: 'red', evidence: '#1' });
    expect(set.ok).toBe(true);
    expect(set.item?.status).toBe('red');
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'K1')?.owner).toBe('OP');

    const listed = await dispatchChecklistList({ version: '9.9.9' });
    expect(listed.ok).toBe(true);
    expect(listed.summary.red).toBe(1);
    expect(listed.summary.blocked).toEqual(['K1']);
    expect(listed.items).toHaveLength(1);

    const filtered = await dispatchChecklistList({ version: '9.9.9', owner: 'MK' });
    expect(filtered.items).toHaveLength(0);

    await expect(dispatchChecklistSet({ id: 'K1', version: '9.9.9', status: 'bogus' })).rejects.toThrow('잘못된 상태');
    const beforeInvalid = listChecklist('9.9.9');
    await expect(dispatchChecklistEdit({ id: 'K1', version: '9.9.9', field: 'accelerator', value: 'maybe' })).rejects.toThrow("'accelerator' value must be true or false");
    await expect(dispatchChecklistEdit({ id: 'K1', version: '9.9.9', field: 'status', value: 'green' })).rejects.toThrow('고칠 수 없는 칸');
    await expect(dispatchChecklistEdit({ id: 'K1', version: '9.9.9', field: 'priority', value: 'P9' })).rejects.toThrow();
    expect(listChecklist('9.9.9')).toEqual(beforeInvalid);
    await expect(dispatchChecklistSet({ id: 'K1', version: '9.9.9' })).rejects.toThrow('갱신할 칸을 지정하라');
    await expect(dispatchChecklistList({ version: 'not-a-version' })).rejects.toThrow('체크리스트 판 또는 별칭이 아니다');
  });

  test('쓰기 fence와 읽기·쓰기 저장소는 현재 인스턴스의 단일 root를 쓴다', async () => {
    const roots: string[] = [];
    const deps = { fence: (_command: string, root: string) => { roots.push(root); return null; } };
    await dispatchChecklistAdd({ id: 'ROOT1', title: 'same root', version: '9.9.9' }, deps);
    await dispatchChecklistSet({ id: 'ROOT1', version: '9.9.9', status: 'red' }, deps);
    expect((await dispatchChecklistList({ version: '9.9.9' })).items.map(item => item.id)).toContain('ROOT1');
    await dispatchChecklistMove({ id: 'ROOT1', from: '9.9.9', to: '9.9.10', reason: 'root parity' }, deps);
    expect(roots).toEqual([releaseLedgerRoot(), releaseLedgerRoot(), releaseLedgerRoot()]);
    expect((await dispatchChecklistList({ version: '9.9.10' })).items.map(item => item.id)).toContain('ROOT1');
  });

  test('출력 상한 — 이력은 historyLimit 로만 · 쓰기 결과는 그 칸 ⊕ 요약뿐', async () => {
    await dispatchChecklistAdd({ id: 'H1', title: 'history', version: '9.9.9' });
    await dispatchChecklistAdd({ id: 'H2', title: 'other', version: '9.9.9' });
    for (let i = 0; i < 30; i += 1) {
      await dispatchChecklistSet({ id: 'H1', version: '9.9.9', evidence: `근거 ${i} ${'x'.repeat(200)}` });
    }
    const full = listChecklist('9.9.9');
    expect(full.history.length).toBeGreaterThan(30);

    const plain = await dispatchChecklistList({ version: '9.9.9' });
    expect(plain.history).toEqual([]);
    expect(plain.historyTotal).toBe(full.history.length);
    expect(plain.items).toHaveLength(2);

    const one = await dispatchChecklistList({ version: '9.9.9', id: 'H1', historyLimit: 5 });
    expect(one.items.map(item => item.id)).toEqual(['H1']);
    expect(one.history).toHaveLength(5);
    expect(one.history.every(entry => entry.id === 'H1')).toBe(true);
    expect(one.history).toEqual(full.history.filter(entry => entry.id === 'H1').slice(-5));
    await expect(dispatchChecklistList({ version: '9.9.9', historyLimit: 201 })).rejects.toThrow("'historyLimit'");

    // A write returns one cell — its JSON stays a fraction of the ledger with history.
    const set = await dispatchChecklistSet({ id: 'H2', version: '9.9.9', status: 'red', evidence: 'small' });
    expect(set.item?.id).toBe('H2');
    expect(JSON.stringify(set).length).toBeLessThan(JSON.stringify(full).length / 4);
  });

  test('채워 넣은 인자 — 실측 10-14 gpt-6-sol 의 넓은 채움이 칸을 덮지 않는다', async () => {
    await dispatchChecklistAdd({ id: 'F1', title: 'fill', version: '9.9.8', owner: 'OP', priority: 'P0' });
    // The exact live ChecklistSet arguments (node-c · 13:26:18Z) — every property filled.
    const set = await dispatchChecklistSet({
      id: 'F1', version: '9.9.8', status: 'yellow', evidence: '우편 5통 확인', owner: 'OP', disposition: 'block',
      kind: 'postpub', dispatchKind: 'ops', priority: 'P2', deadlineVersion: '9.9.8', predecessors: [],
      ceoMinutes: 0, ceoDate: '', accelerator: false, refs: [],
    });
    expect(set.ok).toBe(true);
    const cell = listChecklist('9.9.8').items.find(item => item.id === 'F1')!;
    expect(cell).toMatchObject({ status: 'yellow', evidence: '우편 5통 확인', owner: 'OP', priority: 'P0' });
    expect(cell.kind).toBeUndefined();
    expect(cell.disposition).toBeUndefined();
    expect(cell.dispatchKind).toBeUndefined();
    expect(cell.ceoMinutes).toBeUndefined();

    // Filled "" / [] read as absent on add and list too.
    const added = await dispatchChecklistAdd({ id: 'F2', title: 'fill add', version: '', owner: '', priority: '', deadlineVersion: '', predecessors: [], refs: [] });
    expect(added.ok).toBe(true);
    expect(added.item?.owner).toBeUndefined();
    expect(added.item?.priority).toBeUndefined();
    const listed = await dispatchChecklistList({ version: '9.9.8', owner: '', id: '', historyLimit: 0 });
    expect(listed.items.map(item => item.id)).toContain('F1');
    await expect(dispatchChecklistSet({ id: 'F1', version: '9.9.8', status: '', evidence: '', refs: [] })).rejects.toThrow('갱신할 칸을 지정하라');
  });

  test('ChecklistEdit — 한 번에 한 칸 · 값 인코딩 · 나머지는 그대로 · 본부 거부', async () => {
    await dispatchChecklistAdd({ id: 'P1', title: 'pred', version: '9.9.9' });
    await dispatchChecklistAdd({ id: 'E1', title: 'edit', version: '9.9.9', owner: 'OP', priority: 'P1' });
    const edits: Array<[string, string]> = [
      ['priority', 'P0'], ['disposition', 'known-issue'], ['kind', 'postpub'], ['dispatchKind', 'measure'],
      ['deadlineVersion', '9.9.10'], ['predecessors', 'P1'], ['ceoMinutes', '15'], ['ceoDate', '2026-10-15'], ['accelerator', 'true'],
    ];
    for (const [field, value] of edits) {
      const result = await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field, value });
      expect(result.ok).toBe(true);
      expect(result.field).toBe(field);
    }
    const cell = listChecklist('9.9.9').items.find(item => item.id === 'E1')!;
    expect(cell).toMatchObject({
      owner: 'OP', priority: 'P0', disposition: 'known-issue', kind: 'postpub', dispatchKind: 'measure',
      deadlineVersion: '9.9.10', predecessors: ['P1'], ceoMinutes: 15, ceoDate: '2026-10-15', accelerator: true,
    });
    await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'predecessors', value: '' });
    await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'accelerator', value: 'false' });
    const cleared = listChecklist('9.9.9').items.find(item => item.id === 'E1')!;
    expect(cleared.predecessors ?? []).toEqual([]);
    expect(cleared.accelerator).toBeUndefined();
    expect(cleared.priority).toBe('P0');
    const history = listChecklist('9.9.9').history.filter(entry => entry.id === 'E1' && entry.field === 'priority');
    expect(history.at(-1)).toMatchObject({ by: 'OP', to: 'P0' });
    const denied = await dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'owner', value: 'TC' }, { fence: () => '본부 아님' });
    expect(denied).toMatchObject({ ok: false, error: '본부 아님' });
    await expect(dispatchChecklistEdit({ id: 'E1', version: '9.9.9', field: 'ceoMinutes', value: '-3' })).rejects.toThrow('ceoMinutes');
  });

  test('screen 칸 green 짝 경고', async () => {
    await dispatchChecklistAdd({ id: 'S1', title: '다섯 화면', version: '9.9.9' });
    await dispatchChecklistEdit({ id: 'S1', version: '9.9.9', field: 'kind', value: 'screen' });
    const incomplete = await dispatchChecklistSet({ id: 'S1', version: '9.9.9', status: 'green', evidence: '짝: PWA ok · 데스크톱 ok' });
    expect(incomplete.parityWarning).toBeDefined();
    const complete = await dispatchChecklistSet({ id: 'S1', version: '9.9.9', status: 'green', evidence: '짝: PWA ok · 데스크톱 ok · 폴드 ok · 아이폰 ok · 아이패드 ok' });
    expect(complete.parityWarning).toBeUndefined();
  });

  test('별칭 코드네임 판 해석', async () => {
    writeFileSync(join(effectiveInstanceRoot(), 'config.json'), JSON.stringify({ release: { codenames: { '9.9.9': 'aurora' } } }));
    const added = await dispatchChecklistAdd({ id: 'K1', title: '별칭 칸', version: 'aurora' });
    expect(added.version).toBe('9.9.9');
    const listed = await dispatchChecklistList({ version: 'aurora' });
    expect(listed.version).toBe('9.9.9');
    expect(listed.codename).toBe('aurora');
  });

  test('본부 임대 거부는 구조화 실패로 돌아온다', async () => {
    const denied = await dispatchChecklistAdd({ id: 'K1', title: '첫 칸', version: '9.9.9' }, { fence: () => '본부 아님' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe('본부 아님');
    expect(denied.item).toBeUndefined();
    const deniedSet = await dispatchChecklistSet({ id: 'K1', version: '9.9.9', status: 'green' }, { fence: () => '본부 아님' });
    expect(deniedSet.ok).toBe(false);
    const deniedMove = await dispatchChecklistMove({ id: 'K1', from: '9.9.8', to: '9.9.9', reason: 'next' }, { fence: () => '본부 아님' });
    expect(deniedMove.ok).toBe(false);
  });

  test('move — OP 는 이월하고 · 자리는 남의 칸을 못 옮긴다 · 이유 필수', async () => {
    await dispatchChecklistAdd({ id: 'K2', title: 'carry', version: '0.2.9' });
    await dispatchChecklistAdd({ id: 'K3', title: 'other seat', version: '0.2.9', owner: 'MK' });

    await expect(dispatchChecklistMove({ id: 'K2', from: '0.2.9', to: '0.2.10' })).rejects.toThrow('이동 이유가 필요하다');

    const moved = await dispatchChecklistMove({ id: 'K2', from: '0.2.9', to: '0.2.10', reason: 'next cut' });
    expect(moved.ok).toBe(true);
    expect(moved.actor).toBe('OP');
    expect(moved.item?.id).toBe('K2');
    expect(listChecklist('0.2.10').items.map((item) => item.id)).toContain('K2');
    const moveHistory = listChecklist('0.2.10').history.filter((entry) => entry.id === 'K2' && entry.field === 'move');
    expect(moveHistory.at(-1)).toMatchObject({ reason: 'next cut' });

    process.env.ELANOUS_TRACK = 'TC';
    await expect(dispatchChecklistMove({ id: 'K3', from: '0.2.9', to: '0.2.10', reason: 'next' })).rejects.toThrow();
  });
});

describe('ops-ledger RunShell 스티어링', () => {
  test('TUI dashboard 진입점의 실제 카탈로그로 msg list를 거부하며 subprocess 0건', async () => {
    registerAllDefaultToolRuntimes();
    const tools = buildSessionRuntimeToolSpecs({
      userText: 'TC 우편 msg list 확인',
      hostTools: [],
      runtimeTools: listToolRuntimes('tui'),
      rich: false,
    });
    expect(tools.map(tool => tool.name)).toContain('RunShell');
    expect(tools.map(tool => tool.name)).toContain('MsgList');

    const spawn = spyOn(childProcess, 'spawn');
    try {
      // Control proves this spy sees the shell primitive's actual subprocess boundary.
      await dispatchRunShell({ command: ['true'] });
      expect(spawn).toHaveBeenCalledTimes(1);
      spawn.mockClear();
      const result = await dispatchDashboardSessionRuntimeTool(
        'RunShell', { command: ['elanous', 'msg', 'list', '--to', 'TC'] }, {
          contextUserText: 'TC 우편 msg list 확인',
          turnRefUserText: null,
          muted: line => line,
          pushChatLine: () => {},
          draw: () => {},
          getToolRuntime,
          dispatchToolRuntime: (name, args) => dispatchToolByName(name, args, {
            surface: 'tui', agentHostTools: tools,
          }),
          dispatchPluginTool: async () => ({ ok: false, error: 'unexpected plugin dispatch' }),
        },
      ) as { approvalKey?: string };
      expect(result.approvalKey).toBe('rejected:ops-ledger-cli');
      expect(spawn).toHaveBeenCalledTimes(0);
    } finally {
      spawn.mockRestore();
    }
  });

  test('덮은 CLI 모양은 네이티브 툴로 안내하고 나머지는 통과한다', async () => {
    const availableToolNames = ALL_OPS_LEDGER_RUNTIMES.map(runtime => runtime.spec.name);
    const steer = (command: string[]) => rejectedLedgerCliResult(command, availableToolNames);
    const msgListReject = await dispatchRunShell(
      { command: ['elanous', 'msg', 'list', '--to', 'OP', '--json'] }, { availableToolNames });
    expect(msgListReject.approvalKey).toBe('rejected:ops-ledger-cli');
    const privateBody = 'private-message-body-token';
    const postReject = steer(['elanous', 'msg', 'post', '--from', 'TC', '--to', 'OP', '--body', privateBody]);
    expect(postReject?.output).toContain('MsgPost');
    expect(postReject?.output).not.toContain(privateBody);
    expect(msgListReject.output).toContain('MsgList');
    expect(msgListReject.outcome).toBe('spawn-error');

    const setReject = await dispatchRunShell(
      { command: ['bun', 'bin/elanous.mjs', 'release', 'checklist', 'set', 'K1', '--status', 'green', '--version', '9.9.9'] },
      { availableToolNames });
    expect(setReject.approvalKey).toBe('rejected:ops-ledger-cli');
    expect(setReject.output).toContain('ChecklistSet');

    expect(steer(['eln', 'release', 'checklist', 'move', 'K1', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'next'])?.output).toContain('ChecklistMove');
    expect(steer(['/usr/local/bin/elanous', 'msg', 'post', '--from', 'OP', '--to', 'TC', '--body', 'hi'])?.output).toContain('MsgPost');
    expect(steer(['elanous', 'msg', 'ack', '7', '--to', 'TC'])?.output).toContain('MsgAck');
    expect(steer(['elanous', 'release', 'checklist', 'list', '--version', '9.9.9'])?.output).toContain('ChecklistList');
    expect(steer(['elanous', 'release', 'checklist', 'add', 'K9', 'title'])?.output).toContain('ChecklistAdd');
    expect(steer(['env', 'elanous', 'msg', 'list', '--to', 'OP'])?.output).toContain('MsgList');
    expect(steer(['/usr/bin/env', 'FOO=bar', 'bunx', '--bun', 'elanous', 'release', 'checklist', 'set', 'K1'])?.output).toContain('ChecklistSet');

    // 안 덮은 것 · 다른 우주 명시 · 다른 바이너리 — 통과.
    expect(steer(['git', 'status'])).toBeNull();
    expect(steer(['elanous', 'msg', 'watch', '--to', 'OP'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'status'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'rm', 'K1'])).toBeNull();
    expect(steer(['elanous', '--test', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'set', 'K1', '--status', 'green', '--config-dir', '/tmp/other'])).toBeNull();
    expect(steer(['elanous', 'release', 'checklist', 'set', 'K1', '--config-dir=/tmp/other'])).toBeNull();
    expect(steer(['elanous', 'msg', 'list', '--to', 'OP', '--state-dir=/tmp/other'])).toBeNull();
    expect(steer(['env', 'ELANOUS_STATE_DIR=/tmp/other', 'elanous', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['env', 'ELANOUS_TRACK=TC', 'elanous', 'release', 'checklist', 'move', 'K1', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'x'])).toBeNull();
    expect(steer(['env', '-u', 'ELANOUS_TRACK', 'elanous', 'release', 'checklist', 'move', 'K1'])).toBeNull();
    expect(steer(['env', '--unset=ELANOUS_TRACK', 'elanous', 'msg', 'post', '--from', 'OP', '--to', 'TC'])).toBeNull();
    expect(steer(['env', 'ELANOUS_DEBUG=1', 'elanous', 'msg', 'list', '--to', 'OP'])?.output).toContain('MsgList');
    expect(steer(['env', '-i', 'elanous', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['env', 'elanous', '--test', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(steer(['bun', 'run.ts', 'msg', 'list'])).toBeNull();
    expect(rejectedLedgerCliResult(['elanous', 'msg', 'list', '--to', 'OP'])).toBeNull();
    expect(rejectedLedgerCliResult(['elanous', 'msg', 'list', '--to', 'OP'], ['ChecklistList'])).toBeNull();
    expect(steer(['elanous', 'msg', 'list', '--to', 'OP'])?.output).toContain('MsgList');
    const runtimeReject = await runShellRuntime.run(
      { command: ['elanous', 'msg', 'list', '--to', 'OP'] },
      { surface: 'tui', agentHostTools: [ALL_OPS_LEDGER_RUNTIMES[0]!.spec] },
    );
    expect(runtimeReject.approvalKey).toBe('rejected:ops-ledger-cli');
  });
});

describe('ops-ledger 배선 — 카탈로그 ↔ 런타임 ↔ 등록부', () => {
  afterEach(() => {
    _resetToolRuntimeRegistryForTest();
  });

  test('8개 런타임이 카탈로그 항목과 1:1 이고 별칭이 이름으로 풀린다', () => {
    expect(ALL_OPS_LEDGER_RUNTIMES).toHaveLength(8);
    for (const runtime of ALL_OPS_LEDGER_RUNTIMES) {
      const entry = findNativeTool(runtime.id);
      expect(entry).toBeDefined();
      expect(entry!.aliases).toContain(runtime.spec.name);
      expect(entry!.host).toContain('tui');
      expect(entry!.host).toContain('skill');
      expect(entry!.defaultEnabled).toBe(true);
      expect(entry!.cleanerFitThanShell).toBe(true);
    }
    registerAllDefaultToolRuntimes();
    for (const runtime of ALL_OPS_LEDGER_RUNTIMES) {
      expect(getToolRuntime(runtime.spec.name)?.id).toBe(runtime.id);
    }
    expect(getToolRuntime('MsgPost')?.id).toBe('msg_post');
    expect(getToolRuntime('checklist_move')?.id).toBe('checklist_move');
  });

  test('기본 TUI 도구 목록에서 여덟 도구가 실제로 노출되고 디스패치된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ledger-tui-'));
    const oldState = process.env.ELANOUS_STATE_DIR;
    const oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_STATE_DIR = dir;
    process.env.ELANOUS_TRACK = 'OP';
    setElanousConfigDir(dir);
    try {
      registerAllDefaultToolRuntimes();
      const specs = buildSessionRuntimeToolSpecs({
        userText: '우편을 읽고 판을 점검해 줘',
        hostTools: [],
        runtimeTools: listToolRuntimes('tui'),
        rich: false,
      });
      const names = new Set(specs.map((spec) => spec.name));
      for (const runtime of ALL_OPS_LEDGER_RUNTIMES) expect(names.has(runtime.spec.name)).toBe(true);

      const calls: Array<[string, Record<string, unknown>]> = [
        ['MsgPost', { from: 'OP', to: 'TC', body: 'probe' }],
        ['MsgList', { to: 'TC' }],
        ['MsgAck', { to: 'TC', id: 1 }],
        ['ChecklistAdd', { id: 'K1', title: 'probe', version: '9.9.8' }],
        ['ChecklistSet', { id: 'K1', version: '9.9.8', status: 'yellow', evidence: 'probe' }],
        ['ChecklistEdit', { id: 'K1', version: '9.9.8', field: 'priority', value: 'P1' }],
        ['ChecklistList', { version: '9.9.8' }],
        ['ChecklistMove', { id: 'K1', from: '9.9.8', to: '9.9.9', reason: 'next' }],
      ];
      for (const [name, args] of calls) {
        expect(names.has(name)).toBe(true);
        const startedAt = performance.now();
        const result = await dispatchToolByName(name, args, { surface: 'tui' });
        expect(performance.now() - startedAt).toBeLessThan(300);
        expect('ok' in result && result.ok).toBe(true);
      }
    } finally {
      if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
      if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ops-ledger 한 턴 시나리오 — OP 가 우편 5통을 읽고 판을 손본다', () => {
  test('RunShell 시도는 네이티브로 안내되고 · 셸 subprocess 0 · 네이티브 호출마다 <300ms · 호출 관측 줄', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ledger-turn-'));
    const oldState = process.env.ELANOUS_STATE_DIR;
    const oldTrack = process.env.ELANOUS_TRACK;
    process.env.ELANOUS_STATE_DIR = dir;
    process.env.ELANOUS_TRACK = 'OP';
    setElanousConfigDir(dir);
    registerAllDefaultToolRuntimes();
    const userText = 'OP 앞 우편 5통 읽고 요약해 줘, 판 칸도 정리';
    const tools = buildSessionRuntimeToolSpecs({ userText, hostTools: [], runtimeTools: listToolRuntimes('tui'), rich: false });
    const log = spyOn(debug, 'log');
    const spawn = spyOn(childProcess, 'spawn');
    try {
      for (let i = 1; i <= 5; i += 1) await dispatchMsgPost({ from: 'TC', to: 'OP', body: `보고 ${i}` });
      log.mockClear();

      const dispatch = (name: string, args: Record<string, unknown>) => dispatchDashboardSessionRuntimeTool(name, args, {
        contextUserText: userText,
        turnRefUserText: null,
        muted: line => line,
        pushChatLine: () => {},
        draw: () => {},
        getToolRuntime,
        dispatchToolRuntime: (toolName, toolArgs) => dispatchToolByName(toolName, toolArgs, { surface: 'tui', agentHostTools: tools }),
        dispatchPluginTool: async () => ({ ok: false, error: 'unexpected plugin dispatch' }),
      }) as Promise<Record<string, unknown>>;

      // The model's habitual CLI spelling is refused with the native tool name.
      const shell = await dispatch('RunShell', { command: ['eln', 'release', 'checklist', 'list', '--version', '9.9.8', '--json'] });
      expect(String(shell.output)).toContain('ChecklistList');

      const calls: Array<[string, Record<string, unknown>]> = [
        ['MsgList', { to: 'OP' }],
        ['ChecklistAdd', { id: 'T1', title: 'turn cell', version: '9.9.8', owner: 'OP' }],
        ['ChecklistList', { version: '9.9.8', owner: 'OP' }],
        ['ChecklistSet', { id: 'T1', version: '9.9.8', status: 'red', evidence: '우편 3 근거' }],
        ['ChecklistEdit', { id: 'T1', version: '9.9.8', field: 'priority', value: 'P0' }],
        ['ChecklistMove', { id: 'T1', from: '9.9.8', to: '9.9.9', reason: '다음 판' }],
        ['MsgPost', { from: 'OP', to: 'TC', body: '5통 확인' }],
        ['MsgAck', { to: 'OP', id: 5 }],
      ];
      // Every one of the eight native tools is exercised in this turn.
      expect(calls.map(([name]) => name).sort()).toEqual(ALL_OPS_LEDGER_RUNTIMES.map(runtime => runtime.spec.name).sort());
      const results: Record<string, Record<string, unknown>> = {};
      const wallMs: Record<string, number> = {};
      for (const [name, args] of calls) {
        const startedAt = performance.now();
        results[name] = await dispatch(name, args);
        wallMs[name] = performance.now() - startedAt;
        expect(results[name]!.ok).toBe(true);
      }
      // Per-tool budget: each native call, measured end to end through the TUI dispatch path.
      for (const [name] of calls) expect({ tool: name, underBudget: wallMs[name]! < 300 }).toEqual({ tool: name, underBudget: true });
      expect((results.MsgList!.messages as unknown[]).length).toBe(5);
      expect(results.MsgAck!.cursor).toBe(5);
      expect((await dispatchMsgList({ to: 'OP' })).count).toBe(0);

      // RunShell-0: no shell subprocess for the whole turn.
      expect(spawn).toHaveBeenCalledTimes(0);
      const ledgerCalls = log.mock.calls.filter(([category, event]) => category === 'ops-ledger' && event === 'call')
        .map(([, , data]) => data as Record<string, unknown>);
      // One ops-ledger call line per tool, in call order, each with its own elapsed ms.
      expect(ledgerCalls.map(data => data.tool)).toEqual(calls.map(([name]) => name));
      for (const data of ledgerCalls) {
        expect(typeof data.ms).toBe('number');
        expect({ tool: data.tool, ok: data.ok, underBudget: (data.ms as number) < 300 }).toEqual({ tool: data.tool, ok: true, underBudget: true });
        expect(data.actor).toBe('OP');
        expect(JSON.stringify(data)).not.toContain('5통 확인');
        expect(JSON.stringify(data)).not.toContain('우편 3 근거');
      }
      const steered = log.mock.calls.filter(([category, event]) => category === 'shell.dispatch' && event === 'ledger-cli.steered');
      expect(steered).toHaveLength(1);
    } finally {
      spawn.mockRestore();
      log.mockRestore();
      _resetToolRuntimeRegistryForTest();
      if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
      if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
